import Extent from '@arcgis/core/geometry/Extent.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type { LayerKey } from '../../arcgis/mapSession'
import type { PrintFrame } from '../print-layout/grid'
import {
  EVIDENCE_DESCR_FIELD,
  EVIDENCE_SYMBOL_FIELD,
  buildBadgeDataUrl,
  buildLegendPatch,
  evidenceVariantIndexes,
  findLibrarySymbol,
  type EvidenceLibrary,
} from '../symbols/library'
import { getInsetTargets } from '../stamp/stampData'

export type EvidenceLegendRow = {
  symbol: string
  name: string
  descr: string
  /** Прямий URL SVG або null (сірий патч). */
  svgUrl: string | null
  count: number
}

export type TopoLegendRow = {
  layerKey: string
  code: string
  name: string
  /**
   * Для точок — прямий URL SVG (той самий растр, що PictureMarker на карті,
   * 1:1 у боксі 4.5мм). Для ліній/полігонів і невідомих кодів — dataURL PNG-патча.
   * <img> і canvas-експорт їдять обидва формати.
   */
  patchUrl: string
}

export type TaskLegendRow = {
  layerKey: string
  label: string
  /** PNG dataURL патча з живого renderer шару. */
  patchUrl: string
}

export type CombinedLegend = {
  evidence: EvidenceLegendRow[]
  topo: TopoLegendRow[]
  task: TaskLegendRow[]
  warnings: string[]
  truncated: boolean
}

const QUERY_CAP = 2000
const TOPO_LAYER_KEYS: LayerKey[] = ['topoPoint', 'topoLines', 'topoPolygons']
/** Task-шари для легенди: порядок секції. Легко розширити (напр. додати 'task'). */
export const TASK_LAYER_KEYS: LayerKey[] = ['taskGeopoint', 'polygonGeopoint', 'taskPolygon', 'imsmaPolygons']

function patchDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`
}

/** Точний екстент кадру друку (центр + фізичні мм + масштаб), а не весь в’юпорт. */
function frameExtent(view: MapView, frame: PrintFrame, scale: number): Extent | null {
  const center = view.center
  if (!center) return null
  const halfW = (frame.widthMm * scale) / 2000
  const halfH = (frame.heightMm * scale) / 2000
  return new Extent({
    xmin: center.x - halfW,
    ymin: center.y - halfH,
    xmax: center.x + halfW,
    ymax: center.y + halfH,
    spatialReference: view.spatialReference,
  })
}

async function layerWhere(view: MapView, layer: FeatureLayer): Promise<string> {
  const layerView = (await view.whenLayerView(layer)) as unknown as {
    filter?: { where?: string } | null
  }
  const where = layerView.filter?.where?.trim()
  return where ? where : '1=1'
}

const rendererImageCache = new Map<string, Promise<HTMLImageElement>>()

function loadRendererImage(src: string): Promise<HTMLImageElement> {
  let pending = rendererImageCache.get(src)
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error(`Не вдалося завантажити знак ${src}.`))
      image.src = src
    })
    rendererImageCache.set(src, pending)
    pending.catch(() => {
      rendererImageCache.delete(src)
    })
  }
  return pending
}

function cssColor(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const candidate = value as { toCss?: unknown; toHex?: unknown }
    if (typeof candidate.toCss === 'function') {
      try {
        const css = (candidate.toCss as () => unknown)()
        if (typeof css === 'string') return css
      } catch {
        /* нижче запасні варіанти */
      }
    }
    if (typeof candidate.toHex === 'function') {
      try {
        const hex = (candidate.toHex as () => unknown)()
        if (typeof hex === 'string') return hex.startsWith('#') ? hex : `#${hex}`
      } catch {
        /* нижче запасний варіант */
      }
    }
  }
  if (Array.isArray(value)) {
    const [r, g, b, a] = value as number[]
    if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
      const alpha = typeof a === 'number' && a <= 1 ? a : (typeof a === 'number' ? a / 255 : 1)
      return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`
    }
  }
  return '#9aa5ad'
}

function dashFor(style: unknown): number[] {
  switch (String(style ?? 'solid')) {
    case 'dash':
    case 'short-dash':
    case 'long-dash':
      return [8, 5]
    case 'dot':
    case 'short-dot':
      return [1.5, 5]
    case 'dash-dot':
    case 'short-dash-dot':
      return [8, 4, 1.5, 4]
    default:
      return []
  }
}

/**
 * Патч із ЖИВОГО символа веб-карти (сервісний renderer, не бібліотека).
 * Повертає base64 PNG без префікса (як buildLegendPatch).
 *
 * Первинний шлях — штатний `renderPreviewHTML` Esri (той самий, що малює
 * віджет Legend): розуміє simple/cim/picture/text і дає точну геометрію
 * знака, а не наближення. Ручной canvas-малюнок лишено запасним.
 *
 * Роздільність — під друк 300dpi (бокс 4.5мм ≈ 53px, знак у масштабі
 * 300/96 від натурального css-px): превʼю даунскейлить ціле полотно,
 * тож на екрані знак виходить 1:1 з картою, а в JPEG — різко.
 */
const TASK_PATCH_BOX_PX = 53
const TASK_PATCH_PRINT_SCALE = 300 / 96

function canvasBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png')
  return dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
}

function grayPatchBase64(boxPx = TASK_PATCH_BOX_PX): string {
  const canvas = document.createElement('canvas')
  canvas.width = boxPx
  canvas.height = boxPx
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Браузер не створив полотно для превʼю.')
  context.fillStyle = '#9aa5ad'
  const side = boxPx * 0.6
  context.fillRect((boxPx - side) / 2, (boxPx - side) / 2, side, side)
  return canvasBase64(canvas)
}

function loadImageCors(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Не вдалося завантажити знак ${src}.`))
    image.src = src
  })
}

/** Малює картинку в бокс: натуральний розмір по центру, зменшення лише якщо не влізла. */
function drawContain(image: HTMLImageElement, naturalW: number, naturalH: number, boxPx: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = boxPx
  canvas.height = boxPx
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Браузер не створив полотно для превʼю.')
  const w = Math.max(1, Math.round(naturalW))
  const h = Math.max(1, Math.round(naturalH))
  const fit = Math.min(1, boxPx / w, boxPx / h)
  const dw = w * fit
  const dh = h * fit
  context.drawImage(image, (boxPx - dw) / 2, (boxPx - dh) / 2, dw, dh)
  return canvasBase64(canvas)
}

function svgNaturalSize(svg: SVGSVGElement): { w: number; h: number } | null {
  const widthAttr = Number(svg.getAttribute('width'))
  const heightAttr = Number(svg.getAttribute('height'))
  if (Number.isFinite(widthAttr) && Number.isFinite(heightAttr) && widthAttr > 0 && heightAttr > 0) {
    return { w: widthAttr, h: heightAttr }
  }
  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    svg.setAttribute('width', String(viewBox[2]))
    svg.setAttribute('height', String(viewBox[3]))
    return { w: viewBox[2], h: viewBox[3] }
  }
  return null
}

function measureInDom(node: HTMLElement): { w: number; h: number } | null {
  try {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;'
    host.appendChild(node)
    document.body.appendChild(host)
    const rect = node.getBoundingClientRect()
    const size = rect.width > 0 && rect.height > 0 ? { w: rect.width, h: rect.height } : null
    host.remove()
    return size
  } catch {
    return null
  }
}

/** Точний патч через Esri renderPreviewHTML. Кидає помилку — викликач ставить сірий патч. */
async function esriSymbolPatch(symbol: unknown, boxPx = TASK_PATCH_BOX_PX): Promise<string> {
  const { renderPreviewHTML } = (await import('@arcgis/core/symbols/support/symbolUtils.js')) as unknown as {
    renderPreviewHTML: (s: unknown, options?: Record<string, unknown>) => Promise<HTMLElement | null | undefined>
  }
  const source = symbol as { clone?: () => unknown } | null
  const target = source && typeof source.clone === 'function' ? source.clone() : symbol
  // Без size: превʼю в натуральному розмірі знака — як на карті.
  const node = await renderPreviewHTML(target, {})
  if (!node) throw new Error('Esri повернув порожнє превʼю.')
  const svg = node.querySelector('svg') ?? (node.nodeName.toLowerCase() === 'svg' ? (node as unknown as SVGSVGElement) : null)
  if (svg) {
    let natural = svgNaturalSize(svg)
    natural ??= measureInDom(node)
    if (!natural) throw new Error('Не вдалося визначити розмір SVG-превʼю.')
    const text = new XMLSerializer().serializeToString(svg)
    const image = await loadRendererImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`)
    return drawContain(image, natural.w * TASK_PATCH_PRINT_SCALE, natural.h * TASK_PATCH_PRINT_SCALE, boxPx)
  }
  const img = node.querySelector('img') ?? (node.nodeName.toLowerCase() === 'img' ? (node as unknown as HTMLImageElement) : null)
  if (img?.src) {
    // CORS-clean: інакше полотно експорту стане tainted і JPEG впаде.
    const loaded = await loadImageCors(img.src)
    const wAttr = Number(img.getAttribute('width'))
    const hAttr = Number(img.getAttribute('height'))
    const naturalW = Number.isFinite(wAttr) && wAttr > 0 ? wAttr : loaded.naturalWidth || 16
    const naturalH = Number.isFinite(hAttr) && hAttr > 0 ? hAttr : loaded.naturalHeight || 16
    return drawContain(loaded, naturalW * TASK_PATCH_PRINT_SCALE, naturalH * TASK_PATCH_PRINT_SCALE, boxPx)
  }
  throw new Error('Превʼю без svg/img.')
}

async function rendererSymbolPatch(symbol: unknown, sizePx = 40): Promise<string> {
  try {
    return await esriSymbolPatch(symbol)
  } catch {
    return approximateSymbolPatch(symbol, sizePx)
  }
}

/** Запасний ручний малюнок (коли Esri-превʼю недоступне). */
async function approximateSymbolPatch(symbol: unknown, sizePx = 40): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = sizePx
  canvas.height = sizePx
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Браузер не створив полотно для превʼю.')
  const done = () => {
    const dataUrl = canvas.toDataURL('image/png')
    return dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
  }
  const s = symbol as Record<string, unknown> & { type?: string }
  const kind = typeof s?.type === 'string' ? s.type : ''
  if (kind === 'picture-marker') {
    const url = typeof s.url === 'string' ? s.url : ''
    if (!url) throw new Error('PictureMarker без url.')
    const image = await loadRendererImage(url)
    const inset = sizePx * 0.08
    context.drawImage(image, inset, inset, sizePx - inset * 2, sizePx - inset * 2)
    return done()
  }
  if (kind === 'simple-marker') {
    const style = String(s.style ?? 'circle')
    const color = cssColor(s.color)
    const outline = (s.outline ?? {}) as Record<string, unknown>
    const outlineColor = cssColor(outline.color ?? '#ffffff')
    const outlineWidth = typeof outline.width === 'number' ? outline.width : 1
    const cx = sizePx / 2
    const cy = sizePx / 2
    const r = sizePx * 0.32
    context.fillStyle = color
    context.strokeStyle = outlineColor
    context.lineWidth = Math.max(1, outlineWidth)
    context.beginPath()
    if (style === 'square') {
      context.rect(cx - r, cy - r, r * 2, r * 2)
    } else if (style === 'diamond') {
      context.moveTo(cx, cy - r)
      context.lineTo(cx + r, cy)
      context.lineTo(cx, cy + r)
      context.lineTo(cx - r, cy)
      context.closePath()
    } else if (style === 'triangle') {
      context.moveTo(cx, cy - r)
      context.lineTo(cx + r, cy + r)
      context.lineTo(cx - r, cy + r)
      context.closePath()
    } else if (style === 'cross' || style === 'x') {
      context.strokeStyle = color
      context.lineWidth = Math.max(2, sizePx * 0.1)
      context.beginPath()
      if (style === 'cross') {
        context.moveTo(cx - r, cy)
        context.lineTo(cx + r, cy)
        context.moveTo(cx, cy - r)
        context.lineTo(cx, cy + r)
      } else {
        context.moveTo(cx - r, cy - r)
        context.lineTo(cx + r, cy + r)
        context.moveTo(cx + r, cy - r)
        context.lineTo(cx - r, cy + r)
      }
      context.stroke()
      return done()
    } else {
      context.arc(cx, cy, r, 0, Math.PI * 2)
    }
    context.fill()
    context.stroke()
    return done()
  }
  if (kind === 'simple-line') {
    context.strokeStyle = cssColor(s.color ?? '#555555')
    context.lineWidth = Math.max(3, typeof s.width === 'number' ? s.width : 2)
    context.setLineDash(dashFor(s.style))
    context.beginPath()
    context.moveTo(sizePx * 0.1, sizePx / 2)
    context.lineTo(sizePx * 0.9, sizePx / 2)
    context.stroke()
    context.setLineDash([])
    return done()
  }
  if (kind === 'simple-fill') {
    const fill = cssColor(s.color ?? [0, 0, 0, 0])
    const outline = (s.outline ?? {}) as Record<string, unknown>
    context.fillStyle = fill
    context.strokeStyle = cssColor(outline.color ?? '#555555')
    context.lineWidth = Math.max(2, typeof outline.width === 'number' ? outline.width : 1)
    const inset = sizePx * 0.15
    context.fillRect(inset, inset, sizePx - inset * 2, sizePx - inset * 2)
    context.strokeRect(inset, inset, sizePx - inset * 2, sizePx - inset * 2)
    return done()
  }
  if (kind === 'picture-fill') {
    const outline = (s.outline ?? {}) as Record<string, unknown>
    const url = typeof s.url === 'string' ? s.url : ''
    const inset = sizePx * 0.15
    if (url) {
      try {
        const image = await loadRendererImage(url)
        context.drawImage(image, inset, inset, sizePx - inset * 2, sizePx - inset * 2)
      } catch {
        context.fillStyle = '#e8eef2'
        context.fillRect(inset, inset, sizePx - inset * 2, sizePx - inset * 2)
      }
    }
    context.strokeStyle = cssColor(outline.color ?? '#555555')
    context.lineWidth = Math.max(2, typeof outline.width === 'number' ? outline.width : 1)
    context.strokeRect(inset, inset, sizePx - inset * 2, sizePx - inset * 2)
    return done()
  }
  context.fillStyle = '#9aa5ad'
  context.fillRect(sizePx * 0.2, sizePx * 0.2, sizePx * 0.6, sizePx * 0.6)
  return done()
}

/** Значення поля як рядок для зіставлення з uniqueValueInfos. */
function presentValues(features: { attributes: Record<string, unknown> }[], field: string): Set<string> {
  return new Set(
    features
      .map((feature) => feature.attributes[field])
      .filter((value) => value !== null && value !== undefined && String(value) !== '')
      .map(String),
  )
}

// Кеш примусового LM-значення за фільтром (дані taskGeopoint read-only,
// значення стабільне; легенда перезапитується на кожен рух карти).
const lmForceCache = new Map<string, Set<string>>()

/**
 * Значення renderer-поля LM-точки завдання: LM-інсет є завжди, тож і рядок
 * легенди має бути завжди — навіть коли точка поза кадром головної карти.
 * Тільки для unique-value renderer (реальний випадок taskGeopoint).
 */
async function lmForcedValues(view: MapView, layer: FeatureLayer): Promise<Set<string>> {
  try {
    const where = await layerWhere(view, layer)
    const cacheKey = `${layer.id}|||${where}`
    const cached = lmForceCache.get(cacheKey)
    if (cached) return cached
    const compute = async (): Promise<Set<string>> => {
      const targets = await getInsetTargets(view, layer)
      const lm = targets.find((target) => target.kind === 'lm')
      if (!lm) return new Set()
      const renderer = layer.renderer as unknown as { type?: string; field?: string } | null
      const field = typeof renderer?.field === 'string' ? renderer.field : ''
      if (!field || renderer?.type !== 'unique-value') return new Set()
      const realField = layer.fields?.find((f) => f.name.toLowerCase() === field.toLowerCase())?.name
      if (!realField) return new Set()
      const result = await layer.queryFeatures({
        objectIds: [lm.oid],
        outFields: [realField],
        returnGeometry: false,
      }).catch(() => null)
      const value = result?.features[0]?.attributes[realField]
      return value === null || value === undefined || String(value) === '' ? new Set() : new Set([String(value)])
    }
    const forced = await compute()
    lmForceCache.set(cacheKey, forced)
    if (lmForceCache.size > 25) {
      const first = lmForceCache.keys().next()
      if (!first.done) lmForceCache.delete(first.value)
    }
    return forced
  } catch {
    return new Set()
  }
}

/**
 * Рядки легенди одного task-шару з ЖИВОГО renderer веб-карти.
 * Фільтр LayerView (контекст завдання) і екстент кадру враховуються:
 * шар без обʼєктів у кадрі рядків не дає.
 */
async function taskLayerRows(
  view: MapView,
  layerKey: string,
  layer: FeatureLayer,
  extent: Extent,
  warnings: string[],
  forceValues: Set<string> | null = null,
): Promise<TaskLegendRow[]> {
  const where = await layerWhere(view, layer)
  const count = await layer.queryFeatureCount({ where, geometry: extent }).catch(() => -1)
  if (count === 0) return []
  const renderer = layer.renderer as unknown as {
    type?: string
    field?: string
    uniqueValueInfos?: { value?: unknown; label?: string; symbol?: unknown }[]
    classBreakInfos?: { label?: string; symbol?: unknown }[]
    symbol?: unknown
    defaultSymbol?: unknown
    defaultLabel?: string
  } | null
  if (!renderer || typeof renderer.type !== 'string') {
    warnings.push(`Шар ${layerKey}: renderer невідомий — рядок легенди пропущено.`)
    return []
  }
  const rows: TaskLegendRow[] = []
  const title = layer.title?.trim() || layerKey
  if (renderer.type === 'unique-value' && Array.isArray(renderer.uniqueValueInfos)) {
    const field = typeof renderer.field === 'string' ? renderer.field : ''
    let present: Set<string> | null = null
    const realField = field && layer.fields?.find((f) => f.name.toLowerCase() === field.toLowerCase())?.name
    if (realField) {
      try {
        const result = await layer.queryFeatures({
          where,
          geometry: extent,
          outFields: [realField],
          returnGeometry: false,
          num: QUERY_CAP,
        })
        present = presentValues(
          result.features as unknown as { attributes: Record<string, unknown> }[],
          realField,
        )
        if (present.size === 0) return []
      } catch {
        present = null
      }
    }
    for (const info of renderer.uniqueValueInfos) {
      const infoValue = String(info.value ?? '')
      // Примусові значення (LM) показуємо, навіть якщо їх нема в кадрі.
      if (present && !present.has(infoValue) && !forceValues?.has(infoValue)) continue
      const label = info.label?.trim() || String(info.value ?? title)
      try {
        const base64 = await rendererSymbolPatch(info.symbol)
        rows.push({ layerKey, label, patchUrl: patchDataUrl(base64) })
      } catch {
        // Рядок лишаємо з сірим патчем: запис не повинен мовчки зникати з легенди.
        warnings.push(`Шар ${layerKey}: не вдалося намалювати знак «${label}» — сірий патч.`)
        rows.push({ layerKey, label, patchUrl: patchDataUrl(grayPatchBase64()) })
      }
    }
    if (present) {
      const known = new Set(renderer.uniqueValueInfos.map((info) => String(info.value ?? '')))
      const extra = [...present].filter((value) => !known.has(value))
      if (extra.length > 0 && renderer.defaultSymbol) {
        try {
          const base64 = await rendererSymbolPatch(renderer.defaultSymbol)
          rows.push({
            layerKey,
            label: typeof renderer.defaultLabel === 'string' && renderer.defaultLabel.trim()
              ? renderer.defaultLabel
              : 'Інше',
            patchUrl: patchDataUrl(base64),
          })
        } catch {
          /* default-патч необовʼязковий */
        }
      }
    }
    return rows
  }
  if (renderer.type === 'class-breaks' && Array.isArray(renderer.classBreakInfos)) {
    for (const info of renderer.classBreakInfos) {
      const label = info.label?.trim() || title
      try {
        const base64 = await rendererSymbolPatch(info.symbol)
        rows.push({ layerKey, label, patchUrl: patchDataUrl(base64) })
      } catch {
        warnings.push(`Шар ${layerKey}: не вдалося намалювати інтервал «${label}» — сірий патч.`)
        rows.push({ layerKey, label, patchUrl: patchDataUrl(grayPatchBase64()) })
      }
    }
    return rows
  }
  const symbol = renderer.symbol ?? renderer.defaultSymbol
  if (symbol) {
    try {
      const base64 = await rendererSymbolPatch(symbol)
      rows.push({ layerKey, label: title, patchUrl: patchDataUrl(base64) })
    } catch {
      warnings.push(`Шар ${layerKey}: не вдалося намалювати знак — сірий патч.`)
      rows.push({ layerKey, label: title, patchUrl: patchDataUrl(grayPatchBase64()) })
    }
    return rows
  }
  warnings.push(`Шар ${layerKey}: символ renderer порожній — рядок пропущено.`)
  return rows
}

/**
 * Комбінована легенда макета: evidence в межах кадру (унікальні пари знак+legend_decr),
 * далі task-шари (живий renderer веб-карти в тих самих межах),
 * далі топошари в тих самих межах (коди → записи бібліотеки). Не ArcGIS Legend.
 */
export async function getCombinedLegend(
  view: MapView,
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  library: EvidenceLibrary,
  frame: PrintFrame,
  scale: number,
): Promise<CombinedLegend> {
  const extent = frameExtent(view, frame, scale)
  if (!extent) return { evidence: [], topo: [], task: [], warnings: [], truncated: false }
  const warnings: string[] = []
  let truncated = false

  const evidence: EvidenceLegendRow[] = []
  const evidenceLayer = layers.evidence
  if (evidenceLayer) {
    const where = await layerWhere(view, evidenceLayer)
    const total = await evidenceLayer.queryFeatureCount({ where, geometry: extent })
    truncated = total > QUERY_CAP
    const result = await evidenceLayer.queryFeatures({
      where,
      geometry: extent,
      outFields: [EVIDENCE_SYMBOL_FIELD, EVIDENCE_DESCR_FIELD],
      returnGeometry: false,
      num: QUERY_CAP,
    })
    const groups = new Map<string, { symbol: string; descr: string; count: number }>()
    for (const feature of result.features) {
      const attrs = feature.attributes as Record<string, unknown>
      const symbol = typeof attrs[EVIDENCE_SYMBOL_FIELD] === 'string' ? (attrs[EVIDENCE_SYMBOL_FIELD] as string) : ''
      const descr = typeof attrs[EVIDENCE_DESCR_FIELD] === 'string' ? (attrs[EVIDENCE_DESCR_FIELD] as string) : ''
      const key = `${symbol}|||${descr}`
      const existing = groups.get(key)
      if (existing) existing.count += 1
      else groups.set(key, { symbol, descr, count: 1 })
    }
    // Числові бейджі варіантів: один код з 2+ описами нумерується за абеткою.
    const variantIndex = evidenceVariantIndexes(
      [...groups.values()].map((group) => ({ symbol: group.symbol, descr: group.descr })),
      library,
    )
    for (const group of groups.values()) {
      const lib = findLibrarySymbol(library, group.symbol)
      // Прихований знак: ні патча, ні підпису в легенді.
      if (lib?.hidden) continue
      if (!lib && group.symbol) {
        warnings.push(`Невідомий symbol_code «${group.symbol}» (${group.count} об.). Додайте знак у symbols/library.json.`)
      }
      const badge = variantIndex.get(`${group.symbol}|||${group.descr}`) ?? null
      let svgUrl: string | null = lib?.svg ? `${import.meta.env.BASE_URL}${lib.svg}` : null
      if (badge !== null && svgUrl) {
        try {
          // Той самий бейдж, що цифра оверлею на карті (у редукції — той самий PNG).
          svgUrl = await buildBadgeDataUrl(svgUrl, badge)
        } catch {
          /* лишається чистий SVG */
        }
      }
      evidence.push({
        symbol: group.symbol,
        name: lib?.name ?? (group.symbol || 'Без коду'),
        descr: group.descr,
        svgUrl,
        count: group.count,
      })
    }
    evidence.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'uk'))
  }

  const topo: TopoLegendRow[] = []
  for (const layerKey of TOPO_LAYER_KEYS) {
    const layer = layers[layerKey]
    if (!layer) continue
    const entries = library.symbols.filter((s) => s.layers?.includes(layerKey))
    if (!entries.length) continue
    const field = entries[0].field ?? EVIDENCE_SYMBOL_FIELD
    const found = layer.fields?.find((f) => f.name.toLowerCase() === field.toLowerCase())?.name
    if (!found) {
      warnings.push(`Поле ${field} не знайдено в ${layerKey} — топо-легенда шару пропущена.`)
      continue
    }
    const result = await layer.queryFeatures({
      where: '1=1',
      geometry: extent,
      outFields: [found],
      returnGeometry: false,
      num: QUERY_CAP,
    })
    const codes = [
      ...new Set(
        result.features
          .map((feature) => String((feature.attributes as Record<string, unknown>)[found] ?? ''))
          .filter(Boolean),
      ),
    ].slice(0, 100)
    for (const code of codes) {
      const entry = entries.find((e) => e.code === code)
      if (entry?.hidden) continue
      if (!entry) warnings.push(`У шарі ${layerKey} код поза бібліотекою: ${code}.`)
      // Точки: raw SVG без PNG-прокладки з інсетом — інакше патч виходить
      // на ~16% меншим за PictureMarker на карті (та сама viewBox-графіка,
      // але втиснута в 84% бокса). Лінії/полігони — схематичний PNG-патч.
      const geometry = entry?.geometry ?? 'point'
      const patchUrl = entry && geometry === 'point' && entry.svg
        ? `${import.meta.env.BASE_URL}${entry.svg}`
        : patchDataUrl(await buildLegendPatch(entry ?? null, 40))
      topo.push({
        layerKey,
        code,
        name: entry?.name ?? `${code} (поза бібліотекою)`,
        patchUrl,
      })
    }
  }
  topo.sort((a, b) => a.layerKey.localeCompare(b.layerKey) || a.name.localeCompare(b.name, 'uk'))

  const task: TaskLegendRow[] = []
  for (const layerKey of TASK_LAYER_KEYS) {
    const layer = layers[layerKey]
    if (!layer) {
      warnings.push(`Шар ${layerKey} не знайдено у WebMap — легенда пропущена.`)
      continue
    }
    try {
      // LM-інсет є завжди — її рядок теж завжди (навіть поза кадром).
      const force = layerKey === 'taskGeopoint' ? await lmForcedValues(view, layer) : null
      rowsPush(task, await taskLayerRows(view, layerKey, layer, extent, warnings, force))
    } catch {
      warnings.push(`Шар ${layerKey}: не вдалося прочитати легенду renderer.`)
    }
  }

  return { evidence, topo, task, warnings: [...new Set(warnings)], truncated }
}

function rowsPush(target: TaskLegendRow[], rows: TaskLegendRow[]) {
  for (const row of rows) target.push(row)
}
