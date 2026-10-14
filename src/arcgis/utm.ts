import Point from '@arcgis/core/geometry/Point.js'
import Extent from '@arcgis/core/geometry/Extent.js'
import SpatialReference from '@arcgis/core/geometry/SpatialReference.js'
import * as projectOperator from '@arcgis/core/geometry/operators/projectOperator.js'
import * as reactiveUtils from '@arcgis/core/core/reactiveUtils.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'
import { UTM_ZONES } from '../config'
import type { LayerKey } from './mapSession'

const ID_BATCH_SIZE = 200

function findField(layer: FeatureLayer, name: string) {
  return layer.fields.find((field) => field.name.toLowerCase() === name.toLowerCase())?.name
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function sqlLiteral(value: unknown) {
  return `'${String(value).replaceAll("'", "''")}'`
}

export async function findAutomaticUtmZone(
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  taskGlobalIds: unknown[],
): Promise<{ wkid: number; point: Point } | null> {
  const polygonLayer = layers.taskPolygon
  const pointLayer = layers.polygonGeopoint
  if (!polygonLayer || !pointLayer || taskGlobalIds.length === 0) return null
  const polygonGlobalIdField = polygonLayer.globalIdField || findField(polygonLayer, 'globalid')
  const polygonParentField = findField(polygonLayer, 'parentglobalid')
  const pointParentField = findField(pointLayer, 'parentglobalid')
  const oidField = pointLayer.objectIdField
  if (!polygonGlobalIdField || !polygonParentField || !pointParentField || !oidField) return null

  // Батчуємо IN (...), щоб не впертися в довжину URL на великих завданнях.
  const polygonIds: unknown[] = []
  for (const batch of chunk(taskGlobalIds, ID_BATCH_SIZE)) {
    const taskWhere = `${polygonParentField} IN (${batch.map(sqlLiteral).join(',')})`
    const polygons = await polygonLayer.queryFeatures({ where: taskWhere, outFields: [polygonGlobalIdField], returnGeometry: false })
    polygonIds.push(...polygons.features.map((feature) => feature.attributes[polygonGlobalIdField]).filter(Boolean))
  }
  if (!polygonIds.length) return null

  // Шукаємо точку з найменшим ObjectID серед усіх батчів.
  let firstGeometry: Point | null = null
  let smallestOid = Number.POSITIVE_INFINITY
  for (const batch of chunk(polygonIds, ID_BATCH_SIZE)) {
    const pointWhere = `${pointParentField} IN (${batch.map(sqlLiteral).join(',')})`
    const points = await pointLayer.queryFeatures({
      where: pointWhere,
      outFields: [oidField],
      returnGeometry: true,
      orderByFields: [`${oidField} ASC`],
      num: 1,
    })
    const candidate = points.features[0]
    const candidateOid = candidate?.attributes?.[oidField]
    const candidateGeometry = candidate?.geometry
    if (candidateGeometry instanceof Point && typeof candidateOid === 'number' && candidateOid < smallestOid) {
      smallestOid = candidateOid
      firstGeometry = candidateGeometry
    }
  }
  if (!firstGeometry) return null

  if (!projectOperator.isLoaded()) await projectOperator.load()
  const geographicPoint = projectOperator.execute(firstGeometry, new SpatialReference({ wkid: 4326 }))
  if (!(geographicPoint instanceof Point)) return null
  const longitude = geographicPoint.longitude
  if (longitude == null) return null
  const zone = UTM_ZONES.find(({ minLongitude, maxLongitude }) =>
    longitude >= minLongitude && longitude < maxLongitude,
  )
  return zone ? { wkid: zone.wkid, point: firstGeometry } : null
}

export async function setPrintSpatialReference(view: MapView, wkid: number, center?: Point) {
  if (!projectOperator.isLoaded()) await projectOperator.load()
  const spatialReference = new SpatialReference({ wkid })
  if (!view.spatialReference.equals(spatialReference)) {
    view.spatialReference = spatialReference
    // whenOnce замість view.when(): той свариться в консоль, коли вʼю вже була ready.
    await reactiveUtils.whenOnce(() => view.ready)
  }
  if (center) {
    const projected = projectOperator.execute(center, spatialReference)
    if (projected) view.center = projected
  }
}

/** Чекає спокою в’ю з таймаутом — голі whenOnce могли чекати вічно. */
export async function whenViewSettled(view: MapView, timeoutMs = 30000, what = 'Карта') {
  await Promise.race([
    reactiveUtils.whenOnce(() => !view.updating),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} не заспокоїлась за ${Math.round(timeoutMs / 1000)} с. Спробуйте інший масштаб або зону.`)), timeoutMs),
    ),
  ])
}

/**
 * Безпечне встановлення фіксованого масштабу друку.
 * - Нічого не робить при дрейфі < 0.5% (вотчери толерантні, в’ю не смикається).
 * - goTo без анімації + таймаут замість прямого присвоєння.
 */
export async function goToScale(view: MapView, scale: number, timeoutMs = 15000) {
  if (!Number.isFinite(scale) || scale <= 0) return
  if (Math.abs(view.scale - scale) / scale <= 0.005) return
  const target = view.center ? { center: view.center.clone(), scale } : { scale }
  await Promise.race([
    view.goTo(target, { animate: false }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Не вдалося встановити масштаб 1:${scale} за ${Math.round(timeoutMs / 1000)} с.`)), timeoutMs),
    ),
  ])
}

export type SuspendedLayerInfo = { title: string; isBasemap: boolean }

/**
 * Призупинені шари з поділом на підкладу/basemap і операційні.
 * Підклади WebMercator у UTM призупинені завжди — це очікувано, а не помилка даних.
 */
export function listSuspendedLayerInfos(view: MapView): SuspendedLayerInfo[] {
  const baseIds = new Set<string>()
  const basemap = view.map?.basemap
  basemap?.baseLayers?.forEach((layer) => {
    if (layer.id) baseIds.add(layer.id)
  })
  basemap?.referenceLayers?.forEach((layer) => {
    if (layer.id) baseIds.add(layer.id)
  })
  const seen = new Map<string, SuspendedLayerInfo>()
  for (const layerView of view.allLayerViews.toArray()) {
    if (!layerView.suspended) continue
    const layer = layerView.layer as { id?: string; title?: string | null } | null
    const title = layer?.title || 'без назви'
    if (seen.has(title)) continue
    seen.set(title, { title, isBasemap: !!layer?.id && baseIds.has(layer.id) })
  }
  return [...seen.values()]
}

/** Проєкція екстента у WKID або null, якщо оператор не впорався. */
export async function projectExtent(extent: Extent, wkid: number): Promise<Extent | null> {
  if (!projectOperator.isLoaded()) await projectOperator.load()
  const spatialReference = new SpatialReference({ wkid })
  try {
    if (extent.spatialReference?.equals(spatialReference)) return extent
    const projected = projectOperator.execute(extent, spatialReference)
    return projected instanceof Extent ? projected : null
  } catch {
    return null
  }
}

/** Перехід до екстента з таймаутом (goTo без краю міг чекати вічно). */
export async function goToExtent(view: MapView, extent: Extent, timeoutMs = 15000) {
  await Promise.race([
    view.goTo(extent, { animate: false }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Не вдалося перейти до об’єктів за 15 с.')), timeoutMs),
    ),
  ])
}

/** Шари, які в’юха призупинила (suspended) — типово через непідтримку поточної SR. */
export function listSuspendedLayers(view: MapView): string[] {
  const titles = view.allLayerViews
    .toArray()
    .filter((layerView) => layerView.suspended)
    .map((layerView) => layerView.layer?.title ?? 'без назви')
  return [...new Set(titles)]
}
