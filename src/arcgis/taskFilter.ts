import type Extent from '@arcgis/core/geometry/Extent.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type { LayerKey } from './mapSession'
import { surveyedLineTaskField } from './surveyedLine'

const childLayers: Partial<Record<LayerKey, LayerKey>> = {
  evidence: 'task',
  taskGeopoint: 'task',
  taskPolygon: 'task',
  polygonGeopoint: 'taskPolygon',
}

// Один GUID у лапках ≈ 40 символів. Батч 200 дає ~8 КБ SQL — безпечно для URL,
// батч 500 для ObjectID (числа коротші) лишаємо в getTaskCodes.
const ID_BATCH_SIZE = 200
const MAX_RELATED_IDS = 2000

function fieldName(layer: FeatureLayer, expected: string) {
  return layer.fields.find((field) => field.name.toLowerCase() === expected.toLowerCase())?.name
}

function sqlLiteral(value: unknown) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function assertBatchable(ids: readonly unknown[], what: string) {
  if (ids.length > MAX_RELATED_IDS) {
    throw new Error(
      `Забагато пов’язаних об’єктів (${ids.length}) для ${what}. Звужте вибір або зверніться до адміністратора (обмеження REST запиту).`,
    )
  }
}

async function queryChildGlobalIds(
  layer: FeatureLayer,
  parentField: string,
  parentGlobalIds: unknown[],
  globalIdField: string,
) {
  assertBatchable(parentGlobalIds, `шар ${layer.title ?? 'без назви'}`)
  const ids: unknown[] = []
  for (const batch of chunk(parentGlobalIds, ID_BATCH_SIZE)) {
    const where = `${parentField} IN (${batch.map(sqlLiteral).join(',')})`
    const result = await layer.queryFeatures({
      where,
      outFields: [globalIdField],
      returnGeometry: false,
    })
    ids.push(...result.features.map((feature) => feature.attributes[globalIdField]).filter(Boolean))
  }
  return ids
}

function unionOf(a: Extent, b: Extent): Extent {
  return a.clone().union(b) ?? (a.xmin <= b.xmin ? a : b)
}

async function queryUnionExtent(
  layer: FeatureLayer,
  parentField: string,
  parentGlobalIds: unknown[],
): Promise<Extent | null> {
  assertBatchable(parentGlobalIds, `шар ${layer.title ?? 'без назви'}`)
  let union: Extent | null = null
  for (const batch of chunk(parentGlobalIds, ID_BATCH_SIZE)) {
    const where = `${parentField} IN (${batch.map(sqlLiteral).join(',')})`
    const result = await layer.queryExtent({ where })
    if (result.extent) union = union ? unionOf(union, result.extent) : result.extent
  }
  return union
}

export async function getTaskCodes(taskLayer: FeatureLayer) {
  await taskLayer.load()
  const codeField = fieldName(taskLayer, 'task_code')
  if (!codeField) throw new Error('У шарі task не знайдено поле task_code.')
  const objectIds = await taskLayer.queryObjectIds({ where: '1=1' })
  const values: unknown[] = []
  for (let offset = 0; offset < objectIds.length; offset += 500) {
    const result = await taskLayer.queryFeatures({
      objectIds: objectIds.slice(offset, offset + 500),
      outFields: [codeField],
      returnGeometry: false,
    })
    values.push(...result.features.map((feature) => feature.attributes[codeField]).filter((value) => value != null))
  }
  return [...new Set(values)].sort((left, right) =>
    String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' }),
  )
}

export async function filterLayersByTask(
  view: MapView,
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  code: unknown,
) {
  const taskLayer = layers.task
  if (!taskLayer) throw new Error('Шар task відсутній у WebMap.')
  const codeField = fieldName(taskLayer, 'task_code')
  const globalIdField = taskLayer.globalIdField || fieldName(taskLayer, 'globalid')
  if (!codeField || !globalIdField) throw new Error('У шарі task потрібні поля task_code та GlobalID.')

  if (code == null || code === '') {
    await Promise.all(Object.values(layers).filter(Boolean).map(async (layer) => {
      const layerView = await view.whenLayerView(layer!)
      if ('filter' in layerView) layerView.filter = null
    }))
    return []
  }

  const tasks = await taskLayer.queryFeatures({
    where: `${codeField} = ${sqlLiteral(code)}`,
    outFields: [globalIdField],
    returnGeometry: false,
  })
  const taskGlobalIds = tasks.features.map((feature) => feature.attributes[globalIdField]).filter(Boolean)
  const taskView = await view.whenLayerView(taskLayer)
  taskView.filter = { where: `${codeField} = ${sqlLiteral(code)}` }
  await applyRelatedFilter(view, layers, 'task', taskGlobalIds)
  await applySurveyedLineFilter(view, layers, code)
  return taskGlobalIds
}

/**
 * Surveyed line не пов'язаний з task через parentglobalid — у нього власний
 * task_code. Фільтр ставимо на LayerView кожного в'ю (редагування, друк, LM/BM).
 */
async function applySurveyedLineFilter(
  view: MapView,
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  code: unknown,
) {
  const layer = layers.surveyedLine
  if (!layer) return
  const field = surveyedLineTaskField(layer)
  const layerView = await view.whenLayerView(layer)
  if (!('filter' in layerView)) return
  layerView.filter = field ? { where: `${field} = ${sqlLiteral(code)}` } : null
}

export async function zoomToTaskPolygons(
  view: MapView,
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  taskGlobalIds: unknown[],
) {
  const polygonLayer = layers.taskPolygon
  if (!polygonLayer || taskGlobalIds.length === 0) return false
  const parentField = fieldName(polygonLayer, 'parentglobalid')
  if (!parentField) return false
  const extent = await queryUnionExtent(polygonLayer, parentField, taskGlobalIds)
  if (!extent) return false
  await view.goTo(extent.expand(1.18), { duration: 650 })
  return true
}

/** Об’єднаний extent відфільтрованих task-полігонів (у СК сервісу) або null. */
export async function getTaskPolygonsExtent(
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  taskGlobalIds: unknown[],
): Promise<Extent | null> {
  const polygonLayer = layers.taskPolygon
  if (!polygonLayer || taskGlobalIds.length === 0) return null
  const parentField = fieldName(polygonLayer, 'parentglobalid')
  if (!parentField) return null
  return queryUnionExtent(polygonLayer, parentField, taskGlobalIds)
}

async function applyRelatedFilter(
  view: MapView,
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  parentKey: LayerKey,
  parentGlobalIds: unknown[],
) {
  for (const [childKey, parent] of Object.entries(childLayers) as [LayerKey, LayerKey][]) {
    if (parent !== parentKey) continue
    const layer = layers[childKey]
    if (!layer) continue
    const parentField = fieldName(layer, 'parentglobalid')
    const globalId = layer.globalIdField || fieldName(layer, 'globalid')
    if (!parentField || !globalId || parentGlobalIds.length === 0) {
      const layerView = await view.whenLayerView(layer)
      layerView.filter = { where: '1=2' }
      continue
    }

    const layerView = await view.whenLayerView(layer)
    layerView.filter = { where: `${parentField} IN (${parentGlobalIds.map(sqlLiteral).join(',')})` }
    const childGlobalIds = await queryChildGlobalIds(layer, parentField, parentGlobalIds, globalId)
    await applyRelatedFilter(view, layers, childKey, childGlobalIds)
  }
}
