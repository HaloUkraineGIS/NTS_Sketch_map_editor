import Point from '@arcgis/core/geometry/Point.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'

/**
 * Кутовий штамп з координатами точок завдання.
 * LM ← task geopoint `geopoint_type_id = '1'`, BM ← `'2'` (фільтр LayerView);
 * SP ← polygon geopoint (`poly_geopoint_type_id = '3'`) каскадом через
 * task polygon: task (task_code) → taskPolygon (parentglobalid) →
 * polygonGeopoint (parentglobalid).
 * Точок кожного типу може бути декілька (LM — завжди одна): таблиця
 * розширюється донизу рядками BM1, BM2… / SP1, SP2… (порядок — за ObjectID).
 * Координати — цілими метрами. Один SVG — і превʼю, і JPEG.
 */

export const STAMP_W_MM = 84.4
export const STAMP_ROW_H_MM = 3.8
const STAMP_COLS_MM = [7.4, 18.5, 31.2]
const STAMP_FONT_MM = 2.4
const STAMP_BASELINE_MM = 2.8
const QUERY_LIMIT = 200
const STAMP_MAX_ROWS = 30

export type StampRow = { label: string; x: string; y: string; right: string }
export type StampTable = { rows: StampRow[]; overflow: number; warnings: string[] }

export type StampLayers = {
  task?: FeatureLayer
  taskGeopoint?: FeatureLayer
  taskPolygon?: FeatureLayer
  polygonGeopoint?: FeatureLayer
}

export function stampBlockHeightMm(dataRowCount: number): number {
  return STAMP_ROW_H_MM * (1 + dataRowCount)
}

const ID_BATCH_SIZE = 200

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function sqlLiteral(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`
}

// Числові типи полів ArcGIS JS API: рядковий літерал до числової колонки
// сервер може не прирівняти (як сталося з long), тому типи мають бути повними.
const NUMERIC_FIELD_TYPES = new Set([
  'small-integer',
  'integer',
  'long',
  'single',
  'double',
])

type LayerField = { name: string; type: string }

function findField(layer: FeatureLayer, name: string): LayerField | undefined {
  return layer.fields?.find(
    (field) => field.name.toLowerCase() === name.toLowerCase(),
  ) as LayerField | undefined
}

function typeClause(field: LayerField, value: string): string {
  if (NUMERIC_FIELD_TYPES.has(field.type)) {
    const num = Number(value)
    if (Number.isFinite(num)) return `${field.name} = ${num}`
  }
  return `${field.name} = '${value.replaceAll("'", "''")}'`
}

function formatCoord(value: unknown): string {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN
  return Number.isFinite(num) ? String(Math.round(num)) : ''
}

/**
 * Діагностика порожнього результату: які значення type-поля реально є
 * під where. Повертає до 20 унікальних значень рядками.
 */
async function probePresentTypes(
  layer: FeatureLayer,
  where: string,
  typeField: LayerField,
): Promise<string[]> {
  const collect = (features: { attributes: Record<string, unknown> }[]) => [
    ...new Set(
      features
        .map((feature) => feature.attributes[typeField.name])
        .filter((value) => value !== null && value !== undefined && String(value) !== '')
        .map(String),
    ),
  ].sort().slice(0, 20)
  try {
    const distinct = await layer.queryFeatures({
      where,
      outFields: [typeField.name],
      returnGeometry: false,
      returnDistinctValues: true,
      num: 50,
    })
    const values = collect(
      distinct.features as { attributes: Record<string, unknown> }[],
    )
    if (values.length > 0) return values
  } catch {
    /* запасний варіант нижче */
  }
  const sample = await layer.queryFeatures({
    where,
    outFields: [typeField.name],
    returnGeometry: false,
    orderByFields: [layer.objectIdField],
    num: 50,
  })
  return collect(sample.features as { attributes: Record<string, unknown> }[])
}

type RawPoint = { oid: number; x: string; y: string }

function readRawPoint(
  attributes: Record<string, unknown>,
  geometry: unknown,
  oidField: string,
  xField: LayerField | undefined,
  yField: LayerField | undefined,
): RawPoint | null {
  const oid = attributes[oidField]
  if (typeof oid !== 'number') return null
  let x = xField ? formatCoord(attributes[xField.name]) : ''
  let y = yField ? formatCoord(attributes[yField.name]) : ''
  if ((!x || !y) && geometry instanceof Point) {
    if (!x) x = formatCoord(geometry.x)
    if (!y) y = formatCoord(geometry.y)
  }
  return { oid, x, y }
}

/** Нормалізація значення типу для клієнтського порівняння: геть пробіли
 * і невидимі символи (серверний `= '1'` їх не прощає). */
function normalizeTypeValue(value: unknown): string {
  return String(value ?? '').replace(/[\s\u200b-\u200d\ufeff]/g, '')
}

async function queryTaskGeopoints(
  layer: FeatureLayer,
  baseWhere: string,
  typeField: LayerField,
  typeValue: string,
  xField: LayerField,
  yField: LayerField,
): Promise<RawPoint[]> {
  const toRaw = (attrs: Record<string, unknown>): RawPoint | null => {
    const oid = attrs[layer.objectIdField]
    if (typeof oid !== 'number') return null
    return { oid, x: formatCoord(attrs[xField.name]), y: formatCoord(attrs[yField.name]) }
  }
  const primary = await layer.queryFeatures({
    where: `${baseWhere} AND ${typeClause(typeField, typeValue)}`,
    // objectId потрібен для стабільного сортування — без нього в outFields
    // сервер його не повертає і рядки мовчки відсіюються.
    outFields: [layer.objectIdField, xField.name, yField.name],
    returnGeometry: false,
    orderByFields: [layer.objectIdField],
    num: QUERY_LIMIT,
  })
  const found = primary.features
    .map((feature) => toRaw(feature.attributes as Record<string, unknown>))
    .filter((point): point is RawPoint => point !== null)
  if (found.length > 0) return found
  // Сервер повернув порожньо, хоча значення в наборі є (див. пробу):
  // обходимо серверне порівняння — тягнемо точки завдання і фільтруємо самі.
  const fallback = await layer.queryFeatures({
    where: baseWhere,
    outFields: [layer.objectIdField, typeField.name, xField.name, yField.name],
    returnGeometry: false,
    orderByFields: [layer.objectIdField],
    num: QUERY_LIMIT,
  })
  return fallback.features
    .map((feature) => {
      const attrs = feature.attributes as Record<string, unknown>
      if (normalizeTypeValue(attrs[typeField.name]) !== typeValue) return null
      return toRaw(attrs)
    })
    .filter((point): point is RawPoint => point !== null)
}

export type InsetTarget = { id: string; kind: 'lm' | 'bm'; label: string; center: Point; oid: number }

/**
 * Цілі інсет-карт друку: LM (перша точка типу 1 за ObjectID) + УСІ BM
 * (тип 2 за ObjectID, мітки BM1, BM2… як у штампі). Серверний фільтр типу +
 * клієнтський fallback, як у штампі. База — фільтр LayerView переданого вʼю.
 */
export async function getInsetTargets(
  view: MapView,
  layer: FeatureLayer | undefined,
): Promise<InsetTarget[]> {
  if (!layer) return []
  const typeField = findField(layer, 'geopoint_type_id')
  const oidField = layer.objectIdField
  if (!typeField || !oidField) return []
  const layerView = (await view.whenLayerView(layer)) as unknown as {
    filter?: { where?: string } | null
  }
  const base = layerView.filter?.where?.trim()
  const baseWhere = base ? `(${base})` : '1=1'
  const collect = async (typeValue: string) => {
    const primary = await layer.queryFeatures({
      where: `${baseWhere} AND ${typeClause(typeField, typeValue)}`,
      outFields: [oidField],
      returnGeometry: true,
      orderByFields: [oidField],
      num: QUERY_LIMIT,
    }).catch(() => null)
    const fromPrimary = ((primary?.features ?? []) as { attributes: Record<string, unknown>; geometry: unknown }[])
      .map((feature) => ({
        oid: feature.attributes[oidField],
        geometry: feature.geometry,
      }))
      .filter((item): item is { oid: number; geometry: Point } =>
        typeof item.oid === 'number' && item.geometry instanceof Point)
    if (fromPrimary.length > 0) return fromPrimary.sort((left, right) => left.oid - right.oid)
    const fallback = await layer.queryFeatures({
      where: baseWhere,
      outFields: [oidField, typeField.name],
      returnGeometry: true,
      orderByFields: [oidField],
      num: QUERY_LIMIT,
    }).catch(() => null)
    return ((fallback?.features ?? []) as { attributes: Record<string, unknown>; geometry: unknown }[])
      .map((feature) => ({
        oid: feature.attributes[oidField],
        geometry: feature.geometry,
        type: normalizeTypeValue(feature.attributes[typeField.name]),
      }))
      .filter((item): item is { oid: number; geometry: Point; type: string } =>
        item.type === typeValue && typeof item.oid === 'number' && item.geometry instanceof Point)
      .sort((left, right) => left.oid - right.oid)
  }
  const lm = await collect('1')
  const bm = await collect('2')
  return [
    ...(lm.length > 0 ? [{ id: 'lm', kind: 'lm', label: 'LM', center: lm[0].geometry, oid: lm[0].oid } as InsetTarget] : []),
    ...bm.map((point, index): InsetTarget => ({
      id: `bm-${point.oid}`,
      kind: 'bm',
      label: `BM${bm.length === 1 ? '' : index + 1}`,
      center: point.geometry,
      oid: point.oid,
    })),
  ]
}

async function queryPolygonGeopoints(
  layers: StampLayers,
  taskCode: string,
  warnings: string[],
): Promise<{ points: RawPoint[]; presentTypes: string[]; typeName: string | null }> {
  const empty = { points: [] as RawPoint[], presentTypes: [] as string[], typeName: null as string | null }
  const taskLayer = layers.task
  const polygonLayer = layers.taskPolygon
  const pointLayer = layers.polygonGeopoint
  if (!taskLayer || !polygonLayer || !pointLayer) {
    warnings.push('Шари task / task polygon / polygon geopoint доступні не повністю — SP лишиться порожнім.')
    return empty
  }
  const codeField = findField(taskLayer, 'task_code')
  const taskGidName = taskLayer.globalIdField || findField(taskLayer, 'globalid')?.name
  const polygonParentField = findField(polygonLayer, 'parentglobalid')
  const polygonGidName = polygonLayer.globalIdField || findField(polygonLayer, 'globalid')?.name
  const pointParentField = findField(pointLayer, 'parentglobalid')
  const pointTypeField = findField(pointLayer, 'poly_geopoint_type_id')
  const pointXField = findField(pointLayer, 'poly_coord_x') ?? findField(pointLayer, 'coord_x')
  const pointYField = findField(pointLayer, 'poly_coord_y') ?? findField(pointLayer, 'coord_y')
  const oidField = pointLayer.objectIdField
  if (!codeField || !taskGidName || !polygonParentField || !polygonGidName
    || !pointParentField || !pointTypeField || !oidField) {
    warnings.push('У звʼязці task → task polygon → polygon geopoint бракує полів (task_code/GlobalID/parentglobalid/poly_geopoint_type_id) — SP лишиться порожнім.')
    return empty
  }
  const tasks = await taskLayer.queryFeatures({
    where: `${codeField.name} = ${sqlLiteral(taskCode)}`,
    outFields: [taskGidName],
    returnGeometry: false,
  })
  const taskIds = tasks.features
    .map((feature) => (feature.attributes as Record<string, unknown>)[taskGidName])
    .filter(Boolean)
  if (taskIds.length === 0) return empty
  const polygonIds: unknown[] = []
  for (const batch of chunk(taskIds, ID_BATCH_SIZE)) {
    const polygons = await polygonLayer.queryFeatures({
      where: `${polygonParentField.name} IN (${batch.map(sqlLiteral).join(',')})`,
      outFields: [polygonGidName],
      returnGeometry: false,
    })
    polygonIds.push(
      ...polygons.features
        .map((feature) => (feature.attributes as Record<string, unknown>)[polygonGidName])
        .filter(Boolean),
    )
  }
  if (polygonIds.length === 0) return empty
  const points: RawPoint[] = []
  for (const batch of chunk(polygonIds, ID_BATCH_SIZE)) {
    const result = await pointLayer.queryFeatures({
      where: `${pointParentField.name} IN (${batch.map(sqlLiteral).join(',')}) AND ${typeClause(pointTypeField, '3')}`,
      outFields: [oidField, ...(pointXField ? [pointXField.name] : []), ...(pointYField ? [pointYField.name] : [])],
      returnGeometry: true,
      orderByFields: [oidField],
      num: QUERY_LIMIT,
    })
    for (const feature of result.features) {
      const raw = readRawPoint(
        feature.attributes as Record<string, unknown>,
        feature.geometry,
        oidField,
        pointXField,
        pointYField,
      )
      if (raw) points.push(raw)
    }
  }
  const sorted = points.sort((left, right) => left.oid - right.oid)
  if (sorted.length > 0) return { points: sorted, presentTypes: [], typeName: pointTypeField.type }
  // Серверний фільтр типу нічого не дав — добираємо клієнтським порівнянням.
  for (const batch of chunk(polygonIds, ID_BATCH_SIZE)) {
    const result = await pointLayer.queryFeatures({
      where: `${pointParentField.name} IN (${batch.map(sqlLiteral).join(',')})`,
      outFields: [oidField, pointTypeField.name, ...(pointXField ? [pointXField.name] : []), ...(pointYField ? [pointYField.name] : [])],
      returnGeometry: true,
      orderByFields: [oidField],
      num: QUERY_LIMIT,
    })
    for (const feature of result.features) {
      const attrs = feature.attributes as Record<string, unknown>
      if (normalizeTypeValue(attrs[pointTypeField.name]) !== '3') continue
      const raw = readRawPoint(attrs, feature.geometry, oidField, pointXField, pointYField)
      if (raw) points.push(raw)
    }
  }
  const resorted = points.sort((left, right) => left.oid - right.oid)
  if (resorted.length > 0) return { points: resorted, presentTypes: [], typeName: pointTypeField.type }
  const sampleWhere = `${pointParentField.name} IN (${polygonIds.slice(0, ID_BATCH_SIZE).map(sqlLiteral).join(',')})`
  const presentTypes = await probePresentTypes(pointLayer, sampleWhere, pointTypeField).catch(() => [] as string[])
  return { points: resorted, presentTypes, typeName: pointTypeField.type }
}

/** Праві підписи стоять на фіксованих рядках 2/3/4, як у паперовій формі;
 * зайві рядки даних ідуть нижче з порожніми правими клітинками. */
const FIXED_RIGHT_LABELS = ['Дата обстеження:', 'Керівник групи:', 'Підпис:']

/** Група рядків: одна точка — базова мітка, декілька — з номерами (BM1, BM2…). */
function groupRows(base: string, points: RawPoint[]): StampRow[] {
  return points.map((point, index) => ({
    label: points.length === 1 ? base : `${base}${index + 1}`,
    x: point.x,
    y: point.y,
    right: '',
  }))
}

export async function getStampTable(
  view: MapView,
  layers: StampLayers,
  taskCode: string,
): Promise<StampTable> {
  const warnings: string[] = []
  if (!taskCode) return { rows: [], overflow: 0, warnings }
  let lm: RawPoint[] = []
  let bm: RawPoint[] = []
  const geopointLayer = layers.taskGeopoint
  if (!geopointLayer) {
    warnings.push('Шар task geopoint недоступний — LM/BM лишаться порожніми.')
  } else {
    const typeField = findField(geopointLayer, 'geopoint_type_id')
    const xField = findField(geopointLayer, 'coord_x')
    const yField = findField(geopointLayer, 'coord_y')
    if (!typeField) {
      warnings.push('У шарі task geopoint нема поля geopoint_type_id — LM/BM лишаться порожніми.')
    } else if (!xField || !yField) {
      warnings.push('У шарі task geopoint нема полів coord_x/coord_y — координати не підставляться.')
    } else {
      const layerView = (await view.whenLayerView(geopointLayer)) as unknown as {
        filter?: { where?: string } | null
      }
      const base = layerView.filter?.where?.trim()
      const baseWhere = base ? `(${base})` : '1=1'
      lm = await queryTaskGeopoints(geopointLayer, baseWhere, typeField, '1', xField, yField)
      bm = await queryTaskGeopoints(geopointLayer, baseWhere, typeField, '2', xField, yField)
      if (lm.length === 0 || bm.length === 0) {
        const present = await probePresentTypes(geopointLayer, baseWhere, typeField).catch(() => [] as string[])
        const detail = present.length > 0
          ? `У завданні поле geopoint_type_id (тип ${typeField.type}) має значення: ${present.join(', ')} (шукали «1» і «2»).`
          : 'У завданні взагалі нема точок task geopoint — перевірте фільтр.'
        if (lm.length === 0) {
          warnings.push(`Точку LM (geopoint_type_id = 1) не знайдено у вибраному завданні. ${detail}`)
        }
        if (bm.length === 0) {
          warnings.push(`Точку BM (geopoint_type_id = 2) не знайдено у вибраному завданні. ${detail}`)
        }
      }
    }
  }
  const spResult = await queryPolygonGeopoints(layers, taskCode, warnings)
  const sp = spResult.points
  if (sp.length === 0) {
    const detail = spResult.presentTypes.length > 0
      ? `У полігонах завдання поле poly_geopoint_type_id (тип ${spResult.typeName ?? 'невідомо'}) має значення: ${spResult.presentTypes.join(', ')} (шукали «3»).`
      : 'У полігонах завдання взагалі нема точок polygon geopoint.'
    warnings.push(`Точку SP (poly_geopoint_type_id = 3) не знайдено у вибраному завданні. ${detail}`)
  }
  const dataRows = [
    ...groupRows('LM', lm),
    ...groupRows('BM', bm),
    ...groupRows('SP', sp),
  ]
  const allRows = dataRows.map((row, index) => ({
    ...row,
    right: FIXED_RIGHT_LABELS[index] ?? '',
  }))
  const overflow = Math.max(0, allRows.length - STAMP_MAX_ROWS)
  return { rows: allRows.slice(0, STAMP_MAX_ROWS), overflow, warnings: [...new Set(warnings)] }
}

export function buildStampSvg(rows: StampRow[], overflow: number): string {
  const dataRows = overflow > 0
    ? [...rows, { label: '', x: '', y: '', right: `… +${overflow}` }]
    : rows
  const height = STAMP_ROW_H_MM * (1 + dataRows.length)
  let grid = ''
  for (let i = 1; i <= dataRows.length; i++) {
    const y = (STAMP_ROW_H_MM * i).toFixed(2)
    grid += `<line x1="0" y1="${y}" x2="${STAMP_W_MM}" y2="${y}" stroke="#000000" stroke-width="0.15"/>`
  }
  for (const x of STAMP_COLS_MM) {
    grid += `<line x1="${x}" y1="0" x2="${x}" y2="${height.toFixed(2)}" stroke="#000000" stroke-width="0.15"/>`
  }
  let body = ''
  dataRows.forEach((row, index) => {
    const baseline = (STAMP_ROW_H_MM * (1 + index) + STAMP_BASELINE_MM).toFixed(2)
    const esc = (value: string) =>
      value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    body += `<text x="0.8" y="${baseline}" font-size="${STAMP_FONT_MM}" fill="#000000">${esc(row.label)}</text>`
    body += `<text x="9.2" y="${baseline}" font-size="${STAMP_FONT_MM}" fill="#000000">${esc(row.x)}</text>`
    body += `<text x="20.3" y="${baseline}" font-size="${STAMP_FONT_MM}" fill="#000000">${esc(row.y)}</text>`
    body += `<text x="32.2" y="${baseline}" font-size="${STAMP_FONT_MM}" fill="#000000">${esc(row.right)}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAMP_W_MM} ${height.toFixed(2)}" width="${Math.round(STAMP_W_MM * 10)}" height="${Math.round(height * 10)}" font-family="Arial, Helvetica, sans-serif"><rect x="0.12" y="0.12" width="${(STAMP_W_MM - 0.24).toFixed(2)}" height="${(height - 0.24).toFixed(2)}" fill="#ffffff" stroke="#000000" stroke-width="0.25"/><text x="13" y="${STAMP_BASELINE_MM}" text-anchor="middle" font-size="${STAMP_FONT_MM}" fill="#000000">UTM X</text><text x="25.3" y="${STAMP_BASELINE_MM}" text-anchor="middle" font-size="${STAMP_FONT_MM}" fill="#000000">UTM Y</text><text x="32.3" y="${STAMP_BASELINE_MM}" font-size="${STAMP_FONT_MM}" fill="#000000">Обчислена площа:</text>${grid}${body}</svg>`
}

export function stampDataUrl(rows: StampRow[], overflow: number): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildStampSvg(rows, overflow))}`
}
