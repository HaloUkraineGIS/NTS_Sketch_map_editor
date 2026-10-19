import Extent from '@arcgis/core/geometry/Extent.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type Point from '@arcgis/core/geometry/Point.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type { LayerKey } from '../../arcgis/mapSession'
import { getTaskPolygonsExtent } from '../../arcgis/taskFilter'
import { projectExtent } from '../../arcgis/utm'

/**
 * Вміст інсет-карт LM/BM: тільки полігони завдання + одна точка.
 * Інсети — карти-локатори: evidence, решта task-шарів і топошари там зайві.
 */

/** Шари, видимі в інсетах (решта ховається — лише в цій вʼю). */
const INSET_VISIBLE_KEYS: LayerKey[] = ['taskPolygon', 'taskGeopoint']

/**
 * Залишає в інсеті видимими полігони завдання і ОДНУ точку (LM або конкретну BM),
 * решту шарів ховає. Викликати після filterLayersByTask (звужує її фільтр
 * taskGeopoint до oid точки). Інші вʼю не чіпає.
 */
export async function applyInsetContent(
  view: MapView,
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  pointOid: number,
): Promise<void> {
  const jobs: Promise<unknown>[] = []
  for (const [key, layer] of Object.entries(layers)) {
    if (!layer) continue
    const keep = (INSET_VISIBLE_KEYS as string[]).includes(key)
    jobs.push((async () => {
      try {
        const layerView = await view.whenLayerView(layer)
        if (key === 'taskGeopoint' && 'filter' in layerView) {
          layerView.filter = { where: `${layer.objectIdField} = ${pointOid}` }
        }
        layerView.visible = keep
      } catch {
        /* LayerView ще нема — застосують пізніше */
      }
    })())
  }
  await Promise.all(jobs)
}

/**
 * Обʼєднаний екстент (точка + полігони завдання) у WebMercator для
 * авто-масштабу інсета, з полями. null — полігонів нема
 * (тоді центр точки + поточний масштаб).
 */
export async function insetContentExtent(
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  taskGlobalIds: unknown[],
  center: Point,
): Promise<Extent | null> {
  const poly = await getTaskPolygonsExtent(layers, taskGlobalIds).catch(() => null)
  if (!poly) return null
  // Точка в СК екстента (проєкція за потреби), далі ручне обʼєднання —
  // без клопоту з SR порожнього екстента точки.
  let { x, y } = { x: center.x, y: center.y }
  try {
    const sr = poly.spatialReference
    if (sr && center.spatialReference && !center.spatialReference.equals(sr)) {
      const operators = await import('@arcgis/core/geometry/operators/projectOperator.js')
      if (!operators.isLoaded()) await operators.load()
      const projected = operators.execute(center, sr) as Point
      x = projected.x
      y = projected.y
    }
  } catch {
    /* лишаємо як є — полігони покриті в будь-якому разі */
  }
  const native = poly.clone()
  native.xmin = Math.min(native.xmin, x)
  native.ymin = Math.min(native.ymin, y)
  native.xmax = Math.max(native.xmax, x)
  native.ymax = Math.max(native.ymax, y)
  return projectExtent(native.expand(1.15), 3857).catch(() => null)
}
