import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'
import Graphic from '@arcgis/core/Graphic.js'
import { EVIDENCE_ANGLE_FIELD, EVIDENCE_DESCR_FIELD, EVIDENCE_SYMBOL_FIELD } from '../symbols/library'

export const EVIDENCE_PAGE_SIZE = 20

export type EvidenceRow = {
  fid: number
  symbol_code: string
  symbol_angle: string
  legend_decr: string
  category: string
  type_name: string
  coord_x: string
  coord_y: string
  evidence: string
}

/** Поточний view-local фільтр evidence (той самий, що бачить карта). */
export async function getEvidenceWhere(view: MapView, layer: FeatureLayer): Promise<string> {
  const layerView = (await view.whenLayerView(layer)) as unknown as {
    filter?: { where?: string } | null
  }
  const where = layerView.filter?.where?.trim()
  return where ? where : '1=1'
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function toRow(attributes: Record<string, unknown>, oidField: string): EvidenceRow | null {
  const fid = attributes[oidField]
  if (typeof fid !== 'number') return null
  const symbol = attributes[EVIDENCE_SYMBOL_FIELD]
  const descr = attributes[EVIDENCE_DESCR_FIELD]
  return {
    fid,
    symbol_code: typeof symbol === 'string' ? symbol : '',
    symbol_angle: asText(attributes[EVIDENCE_ANGLE_FIELD]),
    legend_decr: typeof descr === 'string' ? descr : '',
    category: asText(attributes['evidence_category']),
    type_name: asText(attributes['evidence_point_type_name']),
    coord_x: asText(attributes['evidence_coord_x']),
    coord_y: asText(attributes['evidence_coord_y']),
    evidence: asText(attributes['evidence']),
  }
}

export async function queryEvidencePage(
  view: MapView,
  layer: FeatureLayer,
  page: number,
  pageSize = EVIDENCE_PAGE_SIZE,
): Promise<{ total: number; rows: EvidenceRow[] }> {
  const where = await getEvidenceWhere(view, layer)
  const oidField = layer.objectIdField
  const total = await layer.queryFeatureCount({ where })
  if (total === 0) return { total, rows: [] }
  const result = await layer.queryFeatures({
    where,
    outFields: ['*'],
    returnGeometry: false,
    orderByFields: [oidField],
    start: page * pageSize,
    num: pageSize,
  })
  const rows = result.features
    .map((feature) => toRow(feature.attributes as Record<string, unknown>, oidField))
    .filter((row): row is EvidenceRow => row !== null)
  return { total, rows }
}

export async function saveEvidenceRow(
  layer: FeatureLayer,
  fid: number,
  patch: { symbol_code: string; symbol_angle: number | null; legend_decr: string },
): Promise<void> {
  const attributes: Record<string, unknown> = {
    [layer.objectIdField]: fid,
    [EVIDENCE_SYMBOL_FIELD]: patch.symbol_code,
    [EVIDENCE_DESCR_FIELD]: patch.legend_decr,
  }
  // Колонки може не бути в старому сервісі — зайве поле завалило б кожен запис.
  if ((layer.fields ?? []).some((field) => field.name.toLowerCase() === EVIDENCE_ANGLE_FIELD)) {
    attributes[EVIDENCE_ANGLE_FIELD] = patch.symbol_angle
  }
  const result = await layer.applyEdits({
    updateFeatures: [new Graphic({ attributes })],
  })
  const first = result.updateFeatureResults?.[0]
  const editError = first?.error as { message?: string; details?: string } | undefined
  if (!first || editError) {
    throw new Error(editError?.message ?? 'Сервіс відхилив оновлення.')
  }
}
