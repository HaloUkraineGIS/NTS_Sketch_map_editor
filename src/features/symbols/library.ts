import PictureFillSymbol from '@arcgis/core/symbols/PictureFillSymbol.js'
import PictureMarkerSymbol from '@arcgis/core/symbols/PictureMarkerSymbol.js'
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js'
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js'
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js'
import CIMSymbol from '@arcgis/core/symbols/CIMSymbol.js'
import UniqueValueRenderer from '@arcgis/core/renderers/UniqueValueRenderer.js'
import type Symbol from '@arcgis/core/symbols/Symbol.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type { FeatureTemplateProperties } from '@arcgis/core/layers/support/FeatureTemplate.js'
import type Extent from '@arcgis/core/geometry/Extent.js'
import type { CIMSymbolReference } from '@arcgis/core/symbols/cim/types.js'
import type { LayerKey } from '../../arcgis/mapSession'

export const EVIDENCE_SYMBOL_FIELD = 'symbol_code'
export const EVIDENCE_DESCR_FIELD = 'legend_decr'
export const EVIDENCE_DESCR_MAX = 400
/** Кут повороту точкового знака в градусах: 0 — північ, за годинниковою. */
export const EVIDENCE_ANGLE_FIELD = 'symbol_angle'
/** Код прихованого знака evidence: на карті невидимий, з легенди виключається. */
export const EVIDENCE_HIDDEN_CODE = 'EVID_HIDDEN'

/** Базовий розмір точкового знака: 17px@96dpi = 4.5мм на папері (як патч легенди).
 * Експортний upscale (300/96) робить решту — знаки НЕ пре-масштабуємо під dpi. */
export const POINT_BASE_PX = 17

export type SymbolGeometry = 'point' | 'line' | 'polygon'

export type LibrarySymbol = {
  code: string
  name: string
  geometry?: SymbolGeometry
  /** Логічні ключі шарів, де знак дозволений. */
  layers?: string[]
  /** Атрибут із кодом знака (дефолт symbol_code). */
  field?: string
  /** SVG-маркер для точок (шлях від base). */
  svg?: string
  /**
   * Прихований знак: на карті повністю прозорий (невидимий), у легенді
   * пропускається. Вибирається в таблиці/шаблонах для точок без знака.
   */
  hidden?: boolean
  color?: string
  outline?: { color?: string; width?: number; style?: 'solid' | 'dash' | 'dot' | 'dash-dot' }
  /** Проста лінія для лінійних знаків (fallback, коли нема pattern). */
  stroke?: { color?: string; width?: number; style?: 'solid' | 'dash' | 'dot' | 'dash-dot' }
  /**
   * Складний лінійний знак: паралельні обводки + маркери вздовж лінії
   * або міст із вусиками на кінцях. Малюється CIMLineSymbol (карта, скетч,
   * превʼю); `stroke` лишається простим fallback. Усі розміри — в точках, як у CIM.
   */
  pattern?: LinePattern
  /**
   * Малюнок контуру полігона: короткі штрихи, перпендикулярні до межі.
   * Використовується для топографічних «Яма» (inside) і «Насип» (outside).
   * Розміри — в точках CIM, як у решті pattern/outline.
   */
  polygonPattern?: PolygonPattern
  /** Маркер-сітка для полігонів: крок у МІЛІМЕТРАХ аркуша/екрана (сталий на всіх масштабах). */
  fill?: {
    markerSvg?: string
    spacingMm?: number
    markerPx?: number
    layout?: 'checker' | 'grid' | 'scatter'
    /**
     * Нерегулярна розсипка (layout scatter): 2+ маркери на тайл, у кожного
     * своє зміщення (dx/dy — частки тайла 0..1) і свій кут (rotate, градуси).
     * Без scatter — дефолтна трійка зі зміщеннями й поворотами.
     */
    scatter?: { dx?: number; dy?: number; rotate?: number; scale?: number }[]
    /** Суцільна заливка (замість маркерів): колір + прозорість 0–1. */
    color?: string
    opacity?: number
  }
}

/** Одна обводка pattern: колір/товщина/пунктир/зсув уздовж/зсув упоперек (точки). */
export type LinePatternStroke = {
  color?: string
  width?: number
  /** dash-шаблон [риска, проміжок, …]; без нього — за style. */
  dash?: number[]
  dashOffset?: number
  /** Зсув упоперек лінії: плюс/мінус — паралелі. */
  offset?: number
  style?: 'solid' | 'dash' | 'dot' | 'dash-dot'
}

/**
 * Маркер вздовж лінії: tick — поперечка через лінію (size = повна довжина);
 * tooth-up/down — замкнутий трикутник; check-up/down — відкрита галочка
 * вершиною на лінії (size = висота); chevron — шеврон «>» за напрямом лінії
 * (size = довжина); dot — заповнений круг (size = діаметр).
 * interval — період (для along), alongOffset — зсув уздовж лінії,
 * offset — перпендикулярний зсув (яка сторона), placement — along (дефолт)
 * або vertices (на кожній вершині і кінцях).
 */
export type LinePatternMarker = {
  shape: 'tick' | 'tooth-up' | 'tooth-down' | 'check-up' | 'check-down' | 'chevron' | 'dot'
  color?: string
  size?: number
  interval?: number
  alongOffset?: number
  thickness?: number
  /** Перпендикулярний зсув маркера від лінії, точки (для tick — яка сторона). */
  offset?: number
  placement?: 'along' | 'vertices'
}

export type LinePattern = {
  strokes?: LinePatternStroke[]
  markers?: LinePatternMarker[]
  /**
   * Міст: дві паралельні лінії, кінці яких розходяться вусиками назовні.
   * gap — відстань між центрами ліній, width — їх товщина, wingLength —
   * довжина вусика, wingAngle — кут від продовження лінії (градуси).
   * Усі розміри в точках CIM.
   */
  bridge?: {
    gap?: number
    width?: number
    wingLength?: number
    wingAngle?: number
    color?: string
  }
  /**
   * Парні шеврони біля вершин (ЛЕП): для кожної вершини, на кожному
   * інцидентному сегменті — пара за напрямом, центри на screen-відстані
   * distance і distance + gap від вершини. Розмір — в точках.
   * Обчислюється оверлеєм (не CIM): привʼязка до вершин, а не до інтервалу.
   */
  pairedArrows?: { size?: number; distance?: number; gap?: number; color?: string }
}

/** Короткий штрих, перпендикулярний до контуру полігона. */
export type PolygonPatternTicks = {
  /** inside — усередину (яма), outside — назовні (насип). */
  side: 'inside' | 'outside'
  /** Довжина штриха в точках CIM (1/72 дюйма). */
  size?: number
  /** Крок між штрихами вздовж контуру, точки. */
  interval?: number
  /** Товщина штриха, точки. */
  thickness?: number
  color?: string
}

export type PolygonPattern = {
  ticks?: PolygonPatternTicks
}

export type EvidenceLibrary = {
  version: number
  symbols: LibrarySymbol[]
}

let cache: EvidenceLibrary | undefined

export function librarySymbolUrl(symbol: Pick<LibrarySymbol, 'svg'>): string {
  return `${import.meta.env.BASE_URL}${symbol.svg ?? ''}`
}

function normalize(raw: LibrarySymbol): LibrarySymbol {
  return {
    ...raw,
    geometry: raw.geometry ?? 'point',
    layers: raw.layers ?? [],
    field: raw.field ?? EVIDENCE_SYMBOL_FIELD,
  }
}

export async function loadEvidenceLibrary(reload = false): Promise<EvidenceLibrary> {
  if (cache && !reload) return cache
  try {
    // no-store: при авторстві знаків файл міняється часто, браузерний кеш тут ворог.
    const response = await fetch(`${import.meta.env.BASE_URL}symbols/library.json`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as Partial<EvidenceLibrary>
    const symbols = Array.isArray(data.symbols)
      ? data.symbols
        .filter((s): s is LibrarySymbol => !!s && typeof s.code === 'string' && typeof s.name === 'string')
        .map(normalize)
      : []
    cache = { version: data.version ?? 1, symbols }
  } catch {
    cache = { version: 1, symbols: [] }
  }
  return cache
}

export function findLibrarySymbol(library: EvidenceLibrary, code: unknown): LibrarySymbol | undefined {
  if (typeof code !== 'string' || !code) return undefined
  return library.symbols.find((s) => s.code === code)
}

/** Знаки для конкретного шару (для випадайок і рендерера). */
export function symbolsForLayer(
  library: EvidenceLibrary,
  layerKey: string,
  geometry?: SymbolGeometry,
): LibrarySymbol[] {
  return library.symbols.filter(
    (s) => s.layers?.includes(layerKey) && (!geometry || (s.geometry ?? 'point') === geometry),
  )
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Не вдалося завантажити маркер ${src}.`))
    image.src = src
  })
}

// Один проміс на URL: повторні перебудови не ганяють мережу/диск заново
// і завершуються передбачувано (див. seq-захист нижче).
const imageCache = new Map<string, Promise<HTMLImageElement>>()

/** Скинути кеш картинок (після ручних правок SVG — інакше старі лишаються до перезавантаження вкладки). */
export function clearSymbolImageCache(): void {
  imageCache.clear()
}

function loadImageCached(src: string): Promise<HTMLImageElement> {
  let pending = imageCache.get(src)
  if (!pending) {
    pending = loadImage(src)
    imageCache.set(src, pending)
    pending.catch(() => {
      imageCache.delete(src)
    })
  }
  return pending
}

/**
 * Розмір маркера зі збереженням пропорцій SVG: вписується в квадрат basePx
 * довгою стороною (contain). Квадратні SVG дають той самий basePx×basePx.
 */
export async function markerBox(symbol: Pick<LibrarySymbol, 'svg'>, basePx: number): Promise<{ width: number; height: number }> {
  const square = { width: basePx, height: basePx }
  if (!symbol.svg) return square
  try {
    const image = await loadImageCached(librarySymbolUrl(symbol))
    const naturalW = image.naturalWidth
    const naturalH = image.naturalHeight
    if (!naturalW || !naturalH) return square
    const scale = basePx / Math.max(naturalW, naturalH)
    return { width: Math.max(1, naturalW * scale), height: Math.max(1, naturalH * scale) }
  } catch {
    return square
  }
}

/**
 * Індекси варіантів evidence: пари (код, опис) групуються за кодом;
 * код з 2+ різними описами нумерується за абеткою опису (1, 2, …),
 * одиночні/порожні/невідомі/hidden — null (без бейджа). Ключ — `код|||опис`.
 */
export function evidenceVariantIndexes(
  pairs: { symbol: string; descr: string }[],
  library: EvidenceLibrary,
): Map<string, number | null> {
  const bySymbol = new Map<string, Set<string>>()
  for (const pair of pairs) {
    if (!pair.symbol) continue
    const lib = findLibrarySymbol(library, pair.symbol)
    if (!lib || lib.hidden) continue
    const set = bySymbol.get(pair.symbol) ?? new Set<string>()
    set.add(pair.descr)
    bySymbol.set(pair.symbol, set)
  }
  const result = new Map<string, number | null>()
  for (const [symbol, descrs] of bySymbol) {
    if (descrs.size < 2) {
      for (const descr of descrs) result.set(`${symbol}|||${descr}`, null)
      continue
    }
    [...descrs].sort((left, right) => left.localeCompare(right, 'uk')).forEach((descr, position) => {
      result.set(`${symbol}|||${descr}`, position + 1)
    })
  }
  return result
}

const badgePatchCache = new Map<string, string>()

/** Малює SVG в бокс зі збереженням пропорцій, повертає бокс знака. */
function drawContained(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sizePx: number,
  boxFrac = 0.84,
): { dx: number; dy: number; drawW: number; drawH: number } {
  const box = sizePx * boxFrac
  const naturalW = image.naturalWidth || box
  const naturalH = image.naturalHeight || box
  const fit = Math.min(box / naturalW, box / naturalH)
  const drawW = naturalW * fit
  const drawH = naturalH * fit
  const dx = (sizePx - drawW) / 2
  const dy = (sizePx - drawH) / 2
  context.drawImage(image, dx, dy, drawW, drawH)
  return { dx, dy, drawW, drawH }
}

/**
 * Патч знака з числовим бейджем варіанта: чорна жирна цифра висотою
 * в третину знака, центром на правому нижньому куті бокса знака
 * (половина цифри на знаку, половина зовні — плоть не перекривається).
 * Прямо (не крутиться). Бокс знака трохи менший, щоб цифра не різалась краєм.
 * Повертає повний dataURL (на відміну від buildLegendPatch без префікса).
 */
export async function buildBadgeDataUrl(svgUrl: string, index: number, sizePx = 48): Promise<string> {
  const cacheKey = `${svgUrl}|||${index}|||${sizePx}`
  const cached = badgePatchCache.get(cacheKey)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = sizePx
  canvas.height = sizePx
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Браузер не створив полотно для превʼю.')
  const image = await loadImageCached(svgUrl)
  const marker = drawContained(context, image, sizePx, 0.68)
  const fontPx = Math.max(8, Math.round(Math.max(marker.drawW, marker.drawH) / 3 / 0.7))
  context.font = `bold ${fontPx}px Arial, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const x = marker.dx + marker.drawW
  const y = marker.dy + marker.drawH
  context.lineWidth = Math.max(1, Math.round(fontPx * 0.12))
  context.strokeStyle = '#ffffff'
  context.strokeText(String(index), x, y)
  context.fillStyle = '#000000'
  context.fillText(String(index), x, y)
  const dataUrl = canvas.toDataURL('image/png')
  badgePatchCache.set(cacheKey, dataUrl)
  return dataUrl
}

/**
 * PNG-тайл маркер-сітки. checker (дефолт): маркер у центрі + четвертинки по кутах —
 * при стикуванні сусідні тайли складають кутові четвертинки в цілі маркери,
 * тож парні ряди йдуть зі зсувом на півкроку (шаховий порядок).
 * grid: лише центральний маркер — строга квадратна сітка.
 *
 * Печеться з суперсемплінгом ×3 (показ — у логічному розмірі): інакше розтягування
 * маленького растра екраном/GPU дає розмиті маркери.
 */
/** Дефолтна нерегулярна трійка для scatter: різні зміщення й кути. */
export const DEFAULT_SCATTER: { dx: number; dy: number; rotate: number; scale: number }[] = [
  { dx: 0.22, dy: 0.28, rotate: -18, scale: 1 },
  { dx: 0.68, dy: 0.38, rotate: 22, scale: 1 },
  { dx: 0.4, dy: 0.72, rotate: -8, scale: 1 },
]

async function buildMarkerTile(
  markerUrl: string,
  tilePx: number,
  markerPx: number,
  layout: 'checker' | 'grid' | 'scatter' = 'checker',
  scatter?: { dx?: number; dy?: number; rotate?: number; scale?: number }[],
): Promise<string> {
  const supersample = 3
  const image = await loadImageCached(markerUrl)
  const size = Math.max(1, Math.round(tilePx * supersample))
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Браузер не створив полотно для тайла.')
  // Маркер малюємо в натуральну величину навіть якщо він більший за тайл:
  // перекриття чесне, крок сітки не спотворюється.
  const marker = markerPx * supersample
  if (layout === 'scatter') {
    // Нерегулярна розсипка: кілька маркерів зі своїми зміщеннями й кутами.
    // Позиції всередині тайла (не на краях) — стики лишаються безшовними.
    const items = scatter?.length ? scatter : DEFAULT_SCATTER
    for (const item of items) {
      const dx = typeof item.dx === 'number' ? item.dx : 0.5
      const dy = typeof item.dy === 'number' ? item.dy : 0.5
      const scale = typeof item.scale === 'number' && item.scale > 0 ? item.scale : 1
      const rotate = typeof item.rotate === 'number' ? item.rotate : 0
      const m = marker * scale
      const cx = dx * size
      const cy = dy * size
      context.save()
      context.translate(cx, cy)
      context.rotate((rotate * Math.PI) / 180)
      context.drawImage(image, -m / 2, -m / 2, m, m)
      context.restore()
    }
    return canvas.toDataURL('image/png')
  }
  const center = (size - marker) / 2
  const cells: (readonly [number, number])[] = [[center, center]]
  if (layout !== 'grid') {
    const edge = -marker / 2
    const farEdge = size - marker / 2
    // 4 кути (полотно обрізає зайве, сусіди добудовують).
    cells.push([edge, edge], [farEdge, edge], [edge, farEdge], [farEdge, farEdge])
  }
  for (const [x, y] of cells) {
    context.drawImage(image, x, y, marker, marker)
  }
  return canvas.toDataURL('image/png')
}

function resolveField(layer: FeatureLayer, entry: LibrarySymbol): string | null {
  const wanted = entry.field ?? EVIDENCE_SYMBOL_FIELD
  return resolveFieldName(layer, wanted)
}

function resolveFieldName(layer: FeatureLayer, wanted: string): string | null {
  return layer.fields?.find((f) => f.name.toLowerCase() === wanted.toLowerCase())?.name ?? null
}

/** Публічна обгортка: реальне ім’я поля коду в шарі або null. */
export function resolveSymbolField(layer: FeatureLayer, symbol: LibrarySymbol): string | null {
  return resolveField(layer, symbol)
}

/** `#rrggbb`/`#rgb` → CIM-колір [r, g, b, 255]; інше — сірий. */
function cimColor(hex: string | undefined): [number, number, number, number] {
  const fallback: [number, number, number, number] = [154, 165, 173, 255]
  if (typeof hex !== 'string') return fallback
  const clean = hex.trim().replace(/^#/, '')
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
    255,
  ]
}

/** Суцільна заливка полігона: null — нема кольору (прозорий контур). */
function solidFillColor(symbol: LibrarySymbol): [number, number, number, number] | null {
  if (!symbol.fill?.color) return null
  const [r, g, b] = cimColor(symbol.fill.color)
  const opacity = symbol.fill.opacity ?? 1
  return [r, g, b, Math.round(Math.min(1, Math.max(0, opacity)) * 255)]
}

/** CSS-колір заливки для легенди/шаблонів. */
export function fillCss(symbol: Pick<LibrarySymbol, 'fill'>): string {
  if (!symbol.fill?.color) return 'transparent'
  const [r, g, b] = cimColor(symbol.fill.color)
  const opacity = symbol.fill.opacity ?? 1
  const alpha = Math.min(1, Math.max(0, opacity))
  return `rgba(${r},${g},${b},${Math.round(alpha * 100) / 100})`
}

function dashTemplateOf(stroke: LinePatternStroke): number[] | null {  if (stroke.dash?.length) return [...stroke.dash]
  switch (stroke.style ?? 'solid') {
    case 'dash': return [8, 5]
    case 'dot': return [1.5, 5]
    case 'dash-dot': return [8, 4, 1.5, 4]
    default: return null
  }
}

/** Пунктир контуру полігона для canvas-патчів легенди (карка-пробіл 1 1 ≈ dot). */
function polygonOutlineDash(style?: string): number[] {
  switch (style ?? 'solid') {
    case 'dash': return [8, 5]
    case 'dot': return [1, 1]
    case 'dash-dot': return [8, 4, 1, 4]
    default: return []
  }
}

function cimMarkerGraphic(
  marker: LinePatternMarker,
  fallbackColor: string | undefined,
): { geometry: unknown; symbol: unknown } {
  const color = cimColor(marker.color ?? fallbackColor)
  const size = marker.size && marker.size > 0 ? marker.size : 4
  // Символ графіки — ТІЛЬКИ багатошаровий (CIMPolygonSymbol для замкнутих,
  // CIMLineSymbol для відкритих): голі примітиви рушій мовчки пропускає.
  const wrapArea = (fillOrStroke: unknown): unknown => ({
    type: 'CIMPolygonSymbol',
    symbolLayers: [fillOrStroke],
  })
  const wrapLine = (strokeLayer: unknown): unknown => ({
    type: 'CIMLineSymbol',
    symbolLayers: [strokeLayer],
  })
  if (marker.shape === 'dot') {
    const radius = size / 2
    const ring: number[][] = []
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * Math.PI * 2
      ring.push([Math.cos(angle) * radius, Math.sin(angle) * radius])
    }
    ring.push([...ring[0]])
    return {
      geometry: { rings: [ring] },
      symbol: wrapArea({ type: 'CIMSolidFill', enable: true, color }),
    }
  }
  if (marker.shape === 'check-up' || marker.shape === 'check-down') {
    // Відкрита галочка вершиною на лінії, рамена назовні (дзеркальна пара
    // безпечна до напряму осі Y: ряди все одно лягають симетрично).
    const half = size * 0.35
    const arms = marker.shape === 'check-up' ? 1 : -1
    return {
      geometry: { paths: [[[ -half, arms * size], [0, 0], [half, arms * size]]] },
      symbol: wrapLine({
        type: 'CIMSolidStroke',
        enable: true,
        color,
        width: marker.thickness && marker.thickness > 0 ? marker.thickness : 1.2,
        capStyle: 'Round',
        joinStyle: 'Miter',
      }),
    }
  }
  if (marker.shape === 'chevron') {
    // Шеврон «>» за напрямом лінії (вісь X маркера йде дотичною).
    const halfLen = size / 2
    const halfH = size * 0.35
    return {
      geometry: { paths: [[[ -halfLen, -halfH], [halfLen, 0], [-halfLen, halfH]]] },
      symbol: wrapLine({
        type: 'CIMSolidStroke',
        enable: true,
        color,
        width: marker.thickness && marker.thickness > 0 ? marker.thickness : 1.2,
        capStyle: 'Round',
        joinStyle: 'Miter',
      }),
    }
  }
  if (marker.shape === 'tick') {
    const half = size / 2
    const thick = (marker.thickness && marker.thickness > 0 ? marker.thickness : size * 0.35) / 2
    return {
      geometry: { rings: [[[-thick, -half], [thick, -half], [thick, half], [-thick, half], [-thick, -half]]] },
      symbol: wrapArea({
        type: 'CIMSolidStroke',
        enable: true,
        color,
        width: thick * 2,
        capStyle: 'Butt',
        joinStyle: 'Miter',
      }),
    }
  }
  const half = size * 0.35
  // Зубець гостряком ДО лінії (основа назовні): верхній — вістрям униз на лінію.
  const apex = 0
  const base = (marker.shape === 'tooth-up' ? 1 : -1) * size
  return {
    geometry: { rings: [[[ -half, base], [half, base], [0, apex], [-half, base]]] },
    symbol: wrapArea({
      type: 'CIMSolidStroke',
      enable: true,
      color,
      width: marker.thickness && marker.thickness > 0 ? marker.thickness : 1.2,
      capStyle: 'Round',
      joinStyle: 'Miter',
    }),
  }
}

/**
 * CIMLineSymbol зі специфікації pattern: паралельні обводки (зсув/пунктир)
 * нижніми шарами, маркери вздовж лінії — верхніми. Той самий білдер для
 * карти, скетча і превʼю — вигляд один.
 */
export function buildCimLineSymbol(entry: LibrarySymbol): CIMSymbol {
  const pattern = entry.pattern ?? {}
  const bridge = pattern.bridge
  const symbolLayers: unknown[] = []
  // Міст — самодостатній pattern: дві паралельні лінії й вусики на кінцях.
  // Центральну лінію/явні strokes не додаємо, інакше всередині мосту буде зайва.
  const strokes = bridge
    ? []
    : pattern.strokes?.length
      ? pattern.strokes
      : [{
        color: entry.stroke?.color ?? entry.color,
        width: entry.stroke?.width,
        style: entry.stroke?.style,
      }]
  for (const stroke of strokes) {
    const effects: unknown[] = []
    if (stroke.offset) {
      effects.push({ type: 'CIMGeometricEffectOffset', enable: true, offset: stroke.offset })
    }
    const dash = dashTemplateOf(stroke)
    if (dash) {
      effects.push({
        type: 'CIMGeometricEffectDashes',
        enable: true,
        dashTemplate: dash,
        ...(stroke.dashOffset ? { offsetAlongLine: stroke.dashOffset } : {}),
      })
    }
    symbolLayers.push({
      type: 'CIMSolidStroke',
      enable: true,
      color: cimColor(stroke.color ?? entry.color),
      width: stroke.width && stroke.width > 0 ? stroke.width : 2,
      capStyle: 'Round',
      joinStyle: 'Round',
      ...(effects.length ? { effects } : {}),
    })
  }
  if (bridge) {
    const gap = bridge.gap && bridge.gap > 0 ? bridge.gap : 7
    const width = bridge.width && bridge.width > 0 ? bridge.width : 1
    const wingLength = bridge.wingLength && bridge.wingLength > 0 ? bridge.wingLength : 6
    const wingAngle = Number.isFinite(bridge.wingAngle) ? bridge.wingAngle! : 45
    const color = cimColor(bridge.color ?? entry.color)
    const halfGap = gap / 2
    const angle = (Math.max(0, Math.min(90, wingAngle)) * Math.PI) / 180
    const wingDx = wingLength * Math.cos(angle)
    const wingDy = wingLength * Math.sin(angle)
    // Дві паралельні лінії без центральної.
    for (const side of [-1, 1]) {
      symbolLayers.push({
        type: 'CIMSolidStroke',
        enable: true,
        color,
        width,
        capStyle: 'Round',
        joinStyle: 'Round',
        effects: [{
          type: 'CIMGeometricEffectOffset',
          enable: true,
          offset: side * halfGap,
        }],
      })
    }
    // Вусики на кінцях. У CIM маркер в екстремумі орієнтується так, що
    // локальна вісь +X дивиться НАЗОВНІ від лінії (на початку — назад,
    // у кінці — вперед). Тому для обох кінців беремо однакову геометрію
    // з додатним X: так вусики кожної лінії розходяться в різні боки.
    const extent = Math.max(wingDx, halfGap + wingDy) + Math.max(width, 0.5)
    const markerSize = Math.max(8, extent * 2)
    const wingPaths = [
      [[0, halfGap], [wingDx, halfGap + wingDy]],
      [[0, -halfGap], [wingDx, -halfGap - wingDy]],
    ]
    for (const extremityPlacement of ['JustBegin', 'JustEnd'] as const) {
      symbolLayers.push({
        type: 'CIMVectorMarker',
        enable: true,
        size: markerSize,
        markerPlacement: {
          type: 'CIMMarkerPlacementAtExtremities',
          enable: true,
          angleToLine: true,
          extremityPlacement,
        },
        frame: {
          xmin: -extent,
          ymin: -extent,
          xmax: extent,
          ymax: extent,
        } as unknown as Extent,
        respectFrame: true,
        markerGraphics: [{
          type: 'CIMMarkerGraphic',
          geometry: { paths: wingPaths },
          symbol: {
            type: 'CIMLineSymbol',
            symbolLayers: [{
              type: 'CIMSolidStroke',
              enable: true,
              color,
              width,
              capStyle: 'Round',
              joinStyle: 'Round',
            }],
          },
        }],
      })
    }
  }
  for (const marker of pattern.markers ?? []) {
    const interval = marker.interval && marker.interval > 0 ? marker.interval : 10
    const size = marker.size && marker.size > 0 ? marker.size : 4
    // Шаблон — один крок: рушій ставить маркер на КОЖНОМУ кроці, тож пара
    // [маркер, проміжок] давала б пари через інтервал. Рівний крок — одне число.
    // Вершини — окремий плейсмент (крапки/маркери на кожній вершині і кінцях).
    const placement = (marker.placement ?? 'along') === 'vertices'
      ? { type: 'CIMMarkerPlacementOnVertices', enable: true }
      : {
        type: 'CIMMarkerPlacementAlongLineSameSize',
        enable: true,
        placementTemplate: [interval],
        // Завжди NoConstraint: дефолт WithHalfGap ігнорує offsetAlongLine, а різні
        // режими в сусідніх рядах зʼїдали б відносний зсув (старт відрізнявся б
        // рівно на зсув — ряди злипались назад у паралель).
        endings: 'NoConstraint',
        ...(marker.alongOffset ? { offsetAlongLine: marker.alongOffset } : {}),
        ...(marker.offset ? { offset: marker.offset } : {}),
      }
    symbolLayers.push({
      type: 'CIMVectorMarker',
      enable: true,
      size,
      markerPlacement: placement,
      frame: { xmin: -size, ymin: -size, xmax: size, ymax: size } as unknown as Extent,
      markerGraphics: [cimMarkerGraphic(marker, entry.color)],
      respectFrame: true,
    })
  }
  return new CIMSymbol({
    // CIM-дані — звичайний JSON за дизайном Esri; типізуємо межу одним кастом.
    data: {
      type: 'CIMSymbolReference',
      symbol: { type: 'CIMLineSymbol', symbolLayers },
    } as unknown as CIMSymbolReference,
  })
}

/**
 * CIMPolygonSymbol для знаків із штрихами по контуру (яма/насип).
 * Маркери ставляться вздовж межі полігона; offset у точках зсуває їх
 * усередину або назовні. Для зовнішніх і внутрішніх кілець ArcGIS
 * орієнтує offset відносно площі полігона, тому додатково нормалізувати
 * напрямок кілець не потрібно.
 */
export function buildCimPolygonSymbol(entry: LibrarySymbol): CIMSymbol {
  const symbolLayers: unknown[] = []
  const outlineEffects: unknown[] = []
  const outlineDash = dashTemplateOf({ style: entry.outline?.style })
  if (outlineDash) {
    outlineEffects.push({
      type: 'CIMGeometricEffectDashes',
      enable: true,
      dashTemplate: outlineDash,
    })
  }
  symbolLayers.push({
    type: 'CIMSolidStroke',
    enable: true,
    color: cimColor(entry.outline?.color ?? entry.color),
    width: entry.outline?.width && entry.outline.width > 0 ? entry.outline.width : 0.8,
    capStyle: 'Butt',
    joinStyle: 'Miter',
    ...(outlineEffects.length ? { effects: outlineEffects } : {}),
  })

  const ticks = entry.polygonPattern?.ticks
  if (ticks) {
    const size = ticks.size && ticks.size > 0 ? ticks.size : 4
    const interval = ticks.interval && ticks.interval > 0 ? ticks.interval : 8
    const thickness = ticks.thickness && ticks.thickness > 0 ? ticks.thickness : 0.6
    const color = cimColor(ticks.color ?? entry.outline?.color ?? entry.color)
    // Позитивний offset — назовні, негативний — усередину (перевірено
    // для обох напрямків обходу кільця).
    const offset = (ticks.side === 'inside' ? -1 : 1) * size / 2
    symbolLayers.push({
      type: 'CIMVectorMarker',
      enable: true,
      size,
      markerPlacement: {
        type: 'CIMMarkerPlacementAlongLineSameSize',
        enable: true,
        angleToLine: true,
        offset,
        endings: 'NoConstraint',
        placementTemplate: [interval],
      },
      frame: {
        xmin: -size / 2,
        ymin: -size / 2,
        xmax: size / 2,
        ymax: size / 2,
      } as unknown as Extent,
      respectFrame: true,
      markerGraphics: [{
        type: 'CIMMarkerGraphic',
        geometry: {
          rings: [[
            [-thickness / 2, -size / 2],
            [thickness / 2, -size / 2],
            [thickness / 2, size / 2],
            [-thickness / 2, size / 2],
            [-thickness / 2, -size / 2],
          ]],
        },
        symbol: {
          type: 'CIMPolygonSymbol',
          symbolLayers: [{ type: 'CIMSolidFill', enable: true, color }],
        },
      }],
    })
  }

  const solid = solidFillColor(entry)
  if (solid) {
    symbolLayers.push({ type: 'CIMSolidFill', enable: true, color: solid })
  }

  return new CIMSymbol({
    data: {
      type: 'CIMSymbolReference',
      symbol: { type: 'CIMPolygonSymbol', symbolLayers },
    } as unknown as CIMSymbolReference,
  })
}

/** Специфікація тайла в пікселях виводу (експортовано для діагностики в UI). */
export function tileSpec(
  symbol: LibrarySymbol,
  dpi = 96,
): { tilePx: number; markerPx: number } {
  const markerPx = ((symbol.fill?.markerPx ?? 8) * dpi) / 96
  const spacingMm = symbol.fill?.spacingMm ?? 0
  const tilePx = spacingMm > 0 ? (spacingMm * dpi) / 25.4 : markerPx * 2
  return { tilePx, markerPx }
}

/**
 * Будує клієнтські renderers для всіх шарів із записами бібліотеки
 * (сервісну символіку не чіпає). Крок сітки — в міліметрах, сталий на всіх
 * масштабах, тому застосовується один раз при старті, без перебудов при зумі.
 *
 * Два захисти від гонок (історично: асинхронні тайли завершувались не по порядку):
 * - seq: застарілий виклик нічого не присвоює;
 * - ключ тайлів: однакові перебудови пропускаються взагалі.
 */
let rendererSeq = 0
let lastRendererKey: string | null = null

export async function applyLibraryRenderers(
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  library: EvidenceLibrary,
  options?: { force?: boolean },
): Promise<string[]> {
  const seq = ++rendererSeq
  const stale = () => seq !== rendererSeq
  const dpi = 96
  const warnings: string[] = []
  const byLayer = new Map<string, LibrarySymbol[]>()
  for (const symbol of library.symbols) {
    if (!symbol.layers?.length) {
      warnings.push(`Знак ${symbol.code} без layers — пропущено.`)
      continue
    }
    for (const layerKey of symbol.layers) {
      const list = byLayer.get(layerKey) ?? []
      list.push(symbol)
      byLayer.set(layerKey, list)
    }
  }

  // Синхронний прорахунок усіх розмірів: ключ стабільний, зайві перебудови видно одразу.
  const keyParts: string[] = [`dpi=${dpi}`]
  const plans = new Map<string, { layerKey: string; kind: 'point' | 'polygon' | 'line'; symbols: LibrarySymbol[]; tiles: { tilePx: number; markerPx: number }[] }>()
  for (const [layerKey, symbols] of byLayer) {
    const points = symbols.filter((s) => (s.geometry ?? 'point') === 'point')
    const polygons = symbols.filter((s) => s.geometry === 'polygon')
    const lines = symbols.filter((s) => s.geometry === 'line')
    const kind = points.length ? 'point' : polygons.length ? 'polygon' : 'line'
    if ([points, polygons, lines].filter((group) => group.length > 0).length > 1) {
      warnings.push(`Шар ${layerKey} має знаки різної геометрії — застосовано першу групу.`)
    }
    const group = kind === 'point' ? points : kind === 'polygon' ? polygons : lines
    const tiles = group.map((s) => {
      if (kind !== 'polygon') return { tilePx: 0, markerPx: 0 }
      const spec = tileSpec(s, dpi)
      return { tilePx: spec.tilePx, markerPx: spec.markerPx }
    })
    for (const [index, symbol] of group.entries()) {
      const tile = tiles[index]
      const layout = symbol.fill?.layout ?? 'checker'
      const scatterKey = layout === 'scatter' ? JSON.stringify(symbol.fill?.scatter ?? DEFAULT_SCATTER) : ''
      const polygonKey = symbol.polygonPattern ? JSON.stringify(symbol.polygonPattern) : ''
      keyParts.push(`${layerKey}:${symbol.code}:${kind}:${tile.tilePx.toFixed(2)}:${tile.markerPx.toFixed(2)}:${layout}:${scatterKey}:${polygonKey}`)
    }
    plans.set(layerKey, { layerKey, kind, symbols: group, tiles })
  }
  const key = keyParts.join('|')
  if (key === lastRendererKey && !options?.force) return []
  if (stale()) return [...new Set(warnings)]

  for (const [layerKey, plan] of plans) {
    if (stale()) return [...new Set(warnings)]
    const layer = (layers as Partial<Record<string, FeatureLayer>>)[layerKey]
    if (!layer) {
      warnings.push(`Шар ${layerKey} не знайдено у WebMap — знаки пропущено.`)
      continue
    }
    const { kind, symbols } = plan
    try {
      if (kind === 'point') {
        const field = resolveField(layer, symbols[0])
        if (!field) {
          warnings.push(`Поле ${symbols[0].field ?? EVIDENCE_SYMBOL_FIELD} не знайдено в ${layerKey} — знаки пропущено.`)
        } else {
          const markerPx = (POINT_BASE_PX * dpi) / 96
          // Поле кута повороту (якщо є в шарі) — rotation visual variable.
          const angleField = resolveFieldName(layer, EVIDENCE_ANGLE_FIELD)
          if (!angleField && layerKey === 'evidence') {
            warnings.push(`Поле ${EVIDENCE_ANGLE_FIELD} не знайдено в ${layerKey} — поворот знаків вимкнено.`)
          }
          if (!stale()) {
            const uniqueValueInfos: { value: string; label: string; symbol: PictureMarkerSymbol | SimpleMarkerSymbol }[] = []
            for (const symbol of symbols) {
              if (stale()) break
              // Прихований знак: повністю прозорий маркер — точки лишаються
              // клікабельними/редагованими, але їх не видно на карті.
              if (symbol.hidden) {
                uniqueValueInfos.push({
                  value: symbol.code,
                  label: symbol.name,
                  symbol: new SimpleMarkerSymbol({
                    color: [0, 0, 0, 0],
                    size: `${markerPx * 0.64}px`,
                    outline: { color: [0, 0, 0, 0], width: 1 },
                  }),
                })
              } else if (symbol.svg) {
                // Неквадратні SVG вписуються в бокс зі збереженням пропорцій.
                const size = await markerBox(symbol, markerPx)
                if (stale()) break
                uniqueValueInfos.push({
                  value: symbol.code,
                  label: symbol.name,
                  symbol: new PictureMarkerSymbol({
                    url: librarySymbolUrl(symbol),
                    width: `${size.width}px`,
                    height: `${size.height}px`,
                  }),
                })
              }
            }
            if (stale()) return [...new Set(warnings)]
            layer.renderer = new UniqueValueRenderer({
              field,
              defaultSymbol: new SimpleMarkerSymbol({
                color: '#9aa5ad',
                size: `${markerPx * 0.64}px`,
                outline: { color: '#ffffff', width: 1.5 },
              }),
              defaultLabel: 'Без коду / невідомий код',
              uniqueValueInfos,
              // Поворот знаків за symbol_angle: geographic = 0 на півночі,
              // за годинниковою. Порожнє поле — без повороту. У легенді не застосовується.
              visualVariables: angleField
                ? [{ type: 'rotation', field: angleField, rotationType: 'geographic' }]
                : undefined,
            })
          }
        }
      } else if (kind === 'polygon') {
        const field = resolveField(layer, symbols[0])
        if (!field) {
          warnings.push(`Поле ${symbols[0].field ?? EVIDENCE_SYMBOL_FIELD} не знайдено в ${layerKey} — знаки пропущено.`)
        } else {
          const uniqueValueInfos = []
          let aborted = false
          for (const [index, symbol] of symbols.entries()) {
            if (stale()) {
              aborted = true
              break
            }
            const tile = plan.tiles[index]
            const outlineWidth = ((symbol.outline?.width ?? 2) * dpi) / 96
            const outline = new SimpleLineSymbol({
              color: symbol.outline?.color ?? symbol.color ?? '#7b3f00',
              width: outlineWidth,
              style: symbol.outline?.style ?? 'solid',
            })
            // Яма/насип: CIMPolygonSymbol із маркерами, перпендикулярними
            // до контуру. Не залежить від тайла й не масштабується разом із
            // полігоном — розмір штриха сталий на папері.
            if (symbol.polygonPattern?.ticks) {
              try {
                uniqueValueInfos.push({
                  value: symbol.code,
                  label: symbol.name,
                  symbol: buildCimPolygonSymbol(symbol),
                })
              } catch (error) {
                warnings.push(
                  `Знак ${symbol.code}: не вдалося побудувати CIM-контур (${error instanceof Error ? error.message : 'невідома помилка'}) — простий контур.`,
                )
                const solid = solidFillColor(symbol)
                uniqueValueInfos.push({
                  value: symbol.code,
                  label: symbol.name,
                  symbol: new SimpleFillSymbol({ color: solid ?? [0, 0, 0, 0], outline }),
                })
              }
              continue
            }
            // Маркер-сітка лише коли тайл не вироджений (≥3px): інакше маркери
            // зіллються в суцільну пляму — чесніше чистий контур.
            // Суцільний fill.color — заливка з прозорістю (маркерів нема взагалі).
            if (!symbol.fill?.markerSvg || !symbol.fill?.spacingMm || tile.tilePx < 3) {
              const solid = solidFillColor(symbol)
              uniqueValueInfos.push({
                value: symbol.code,
                label: symbol.name,
                symbol: new SimpleFillSymbol({ color: solid ?? [0, 0, 0, 0], outline }),
              })
              continue
            }
            // Крок тайла в px з метрів: метри × dpi / (0.0254 × масштаб).
            const tileUrl = await buildMarkerTile(
              `${import.meta.env.BASE_URL}${symbol.fill.markerSvg}`,
              tile.tilePx,
              tile.markerPx,
              symbol.fill.layout ?? 'checker',
              symbol.fill.scatter,
            )
            if (stale()) {
              aborted = true
              break
            }
            uniqueValueInfos.push({
              value: symbol.code,
              label: symbol.name,
              symbol: new PictureFillSymbol({ url: tileUrl, width: tile.tilePx, height: tile.tilePx, outline }),
            })
          }
          if (!aborted && !stale()) {
            layer.renderer = new UniqueValueRenderer({
              field,
              defaultSymbol: new SimpleFillSymbol({
                color: [0, 0, 0, 0],
                outline: new SimpleLineSymbol({ color: '#9aa5ad', width: 1 }),
              }),
              defaultLabel: 'Без коду / невідомий код',
              uniqueValueInfos,
            })
          }
        }
      } else {
        const field = resolveField(layer, symbols[0])
        if (!field) {
          warnings.push(`Поле ${symbols[0].field ?? EVIDENCE_SYMBOL_FIELD} не знайдено в ${layerKey} — знаки пропущено.`)
        } else if (!stale()) {
          // Складний pattern малюється CIMLineSymbol; без нього — простий stroke.
          const lineSymbolFor = (symbol: LibrarySymbol): SimpleLineSymbol | CIMSymbol => {
            if (symbol.pattern) {
              try {
                return buildCimLineSymbol(symbol)
              } catch (error) {
                warnings.push(
                  `Знак ${symbol.code}: не вдалося побудувати CIM (${error instanceof Error ? error.message : 'невідома помилка'}) — проста лінія.`,
                )
              }
            }
            return new SimpleLineSymbol({
              color: symbol.stroke?.color ?? symbol.color ?? '#555555',
              width: ((symbol.stroke?.width ?? 2) * dpi) / 96,
              style: symbol.stroke?.style ?? 'solid',
            })
          }
          layer.renderer = new UniqueValueRenderer({
            field,
            defaultSymbol: new SimpleLineSymbol({ color: '#9aa5ad', width: 1 }),
            defaultLabel: 'Без коду / невідомий код',
            uniqueValueInfos: symbols.map((symbol) => ({
              value: symbol.code,
              label: symbol.name,
              symbol: lineSymbolFor(symbol),
            })),
          })
        }
      }
    } catch (error) {
      warnings.push(
        `Не вдалося застосувати знаки до ${layerKey}: ${error instanceof Error ? error.message : 'невідома помилка'}.`,
      )
    }
  }
  if (!stale()) lastRendererKey = key
  return [...new Set(warnings)]
}

const THUMBNAIL_PX = 48

function drawingToolFor(symbol: LibrarySymbol): 'point' | 'line' | 'polygon' {
  const geometry = symbol.geometry ?? 'point'
  return geometry === 'line' || geometry === 'polygon' ? geometry : 'point'
}

/** PNG-превʼю для шаблону Editor і легенди: знак на весь патч, щоб читався.
 * Той самий SVG і кольори, що на карті (карта показує його в істинному розмірі знака).
 */
export async function buildLegendPatch(symbol: LibrarySymbol | null, sizePx = THUMBNAIL_PX): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = sizePx
  canvas.height = sizePx
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Браузер не створив полотно для превʼю.')
  if (!symbol) {
    context.fillStyle = '#9aa5ad'
    context.fillRect(sizePx * 0.2, sizePx * 0.2, sizePx * 0.6, sizePx * 0.6)
    context.fillStyle = '#ffffff'
    context.font = `bold ${Math.round(sizePx * 0.45)}px Arial, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText('?', sizePx / 2, sizePx / 2 + 1)
    return toDataUrl(canvas)
  }
  const geometry = symbol.geometry ?? 'point'
  if (symbol.hidden) {
    // Привид прихованого знака: прозора заливка + пунктирний контур,
    // щоб опцію було видно в шаблонах/таблиці (на карті — невидимий).
    context.strokeStyle = '#1a56db'
    context.lineWidth = Math.max(2, sizePx * 0.06)
    context.setLineDash([sizePx * 0.12, sizePx * 0.08])
    context.beginPath()
    context.arc(sizePx / 2, sizePx / 2, sizePx * 0.32, 0, Math.PI * 2)
    context.stroke()
    context.setLineDash([])
    return toDataUrl(canvas)
  }
  if (geometry === 'point' && symbol.svg) {
    const image = await loadImageCached(librarySymbolUrl(symbol))
    // 1:1 з картою: на карті PictureMarker займає весь бокс 4.5 мм,
    // тож патч легенди не має відступати (раніше було 0.84 → знак дротянів).
    drawContained(context, image, sizePx, 1)
  } else if (geometry === 'polygon') {
    context.strokeStyle = symbol.outline?.color ?? symbol.color ?? '#7b3f00'
    context.lineWidth = Math.max(3, symbol.outline?.width ?? 2)
    context.setLineDash(polygonOutlineDash(symbol.outline?.style))
    // Для ями/насипу лишаємо запас під зовнішні штрихи, інакше їхні кінчики
    // обрізаються краєм квадратного полотна.
    const inset = sizePx * (symbol.polygonPattern?.ticks ? 0.21 : 0.15)
    context.fillStyle = fillCss(symbol)
    context.fillRect(inset, inset, sizePx - inset * 2, sizePx - inset * 2)
    context.strokeRect(inset, inset, sizePx - inset * 2, sizePx - inset * 2)
    context.setLineDash([])
    if (symbol.fill?.markerSvg) {
      const image = await loadImageCached(`${import.meta.env.BASE_URL}${symbol.fill.markerSvg}`)
      if (symbol.fill.layout === 'scatter') {
        // Та сама нерегулярна трійка, що в тайлі карти: мініатюра патча.
        const items = symbol.fill.scatter?.length ? symbol.fill.scatter : DEFAULT_SCATTER
        const box = sizePx - inset * 2
        for (const item of items) {
          const dx = typeof item.dx === 'number' ? item.dx : 0.5
          const dy = typeof item.dy === 'number' ? item.dy : 0.5
          const scale = typeof item.scale === 'number' && item.scale > 0 ? item.scale : 1
          const rotate = typeof item.rotate === 'number' ? item.rotate : 0
          const m = sizePx * 0.3 * scale
          const cx = inset + dx * box
          const cy = inset + dy * box
          context.save()
          context.translate(cx, cy)
          context.rotate((rotate * Math.PI) / 180)
          context.drawImage(image, -m / 2, -m / 2, m, m)
          context.restore()
        }
      } else {
        const marker = sizePx * 0.38
        context.drawImage(image, (sizePx - marker) / 2, (sizePx - marker) / 2, marker, marker)
      }
    }
    if (symbol.polygonPattern?.ticks) {
      drawPolygonBoundaryTicks(
        context,
        symbol.polygonPattern.ticks,
        inset,
        sizePx,
        symbol.outline?.color ?? symbol.color,
      )
    }
  } else if (geometry === 'line') {
    // Складний pattern малюємо самі за тими самими числами, що їдуть у CIM:
    // Esri-превʼю для таких повертало не-SVG і легенда мовчки відкочувалась.
    if (symbol.pattern) {
      const has = (symbol.pattern.strokes?.length ?? 0) + (symbol.pattern.markers?.length ?? 0) > 0
        || Boolean(symbol.pattern.bridge)
      if (has) {
        drawLinePattern(context, symbol, sizePx)
        return toDataUrl(canvas)
      }
    }
    // Лінійна смуга-зразок, якщо є (інакше схематична лінія за stroke).
    if (symbol.svg) {
      try {
        const image = await loadImageCached(librarySymbolUrl(symbol))
        drawContained(context, image, sizePx)
        return toDataUrl(canvas)
      } catch {
        /* нижче схематична лінія */
      }
    }
    context.strokeStyle = symbol.stroke?.color ?? symbol.color ?? '#555555'
    context.lineWidth = Math.max(3, symbol.stroke?.width ?? 2)
    const style = symbol.stroke?.style ?? 'solid'
    context.setLineDash(style === 'dash' ? [8, 5] : style === 'dot' ? [1.5, 5] : style === 'dash-dot' ? [8, 4, 1.5, 4] : [])
    context.beginPath()
    context.moveTo(sizePx * 0.1, sizePx / 2)
    context.lineTo(sizePx * 0.9, sizePx / 2)
    context.stroke()
    context.setLineDash([])
  } else {
    context.fillStyle = '#9aa5ad'
    context.fillRect(sizePx * 0.2, sizePx * 0.2, sizePx * 0.6, sizePx * 0.6)
  }
  return toDataUrl(canvas)
}

function toDataUrl(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png')
  return dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
}

/**
 * Патч полігонального знака зі штрихами по контуру: квадрат у легенді,
 * штрихи — з того самого боку, що й на карті (inside/outside). Розміри
 * переводимо з точок CIM у пікселі патча (96 dpi) і трохи підсилюємо,
 * щоб мініатюра 48 px читалась.
 */
function drawPolygonBoundaryTicks(
  context: CanvasRenderingContext2D,
  ticks: PolygonPatternTicks,
  inset: number,
  sizePx: number,
  fallbackColor?: string,
): void {
  const outward = ticks.side === 'inside' ? -1 : 1
  // Патч легенди — схема, а не масштаб 1:1: підсилюємо штрихи, щоб вони
  // читались навіть у мініатюрі, і масштабуємо разом із розміром полотна.
  const patchScale = sizePx / 48
  const pxPerPt = (96 / 72) * patchScale
  const length = Math.max(3, (ticks.size && ticks.size > 0 ? ticks.size : 4) * pxPerPt * 1.5)
  const interval = Math.max(4, (ticks.interval && ticks.interval > 0 ? ticks.interval : 8) * pxPerPt * 0.85)
  const width = Math.max(1.2, (ticks.thickness && ticks.thickness > 0 ? ticks.thickness : 0.6) * pxPerPt * 1.5)
  const x0 = inset
  const y0 = inset
  const x1 = sizePx - inset
  const y1 = sizePx - inset
  context.strokeStyle = ticks.color ?? fallbackColor ?? '#000000'
  context.lineWidth = width
  context.lineCap = 'butt'
  context.setLineDash([])

  const drawSide = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    nx: number,
    ny: number,
  ) => {
    const lengthPx = Math.hypot(bx - ax, by - ay)
    const count = Math.max(1, Math.floor(lengthPx / interval))
    const step = lengthPx / (count + 1)
    const ux = (bx - ax) / lengthPx
    const uy = (by - ay) / lengthPx
    context.beginPath()
    for (let index = 1; index <= count; index += 1) {
      const x = ax + ux * step * index
      const y = ay + uy * step * index
      context.moveTo(x, y)
      context.lineTo(x + nx * length * outward, y + ny * length * outward)
    }
    context.stroke()
  }

  drawSide(x0, y0, x1, y0, 0, -1)
  drawSide(x1, y0, x1, y1, 1, 0)
  drawSide(x1, y1, x0, y1, 0, 1)
  drawSide(x0, y1, x0, y0, -1, 0)
}

/**
 * Патч моста: дві паралельні лінії й розбіжні вусики на кінцях.
 * Ті самі числа, що в CIM, але з підсиленням для читабельності мініатюри.
 */
function drawBridgePattern(
  context: CanvasRenderingContext2D,
  bridge: NonNullable<LinePattern['bridge']>,
  entry: LibrarySymbol,
  sizePx: number,
): void {
  const gap = bridge.gap && bridge.gap > 0 ? bridge.gap : 7
  const width = bridge.width && bridge.width > 0 ? bridge.width : 1
  const wingLength = bridge.wingLength && bridge.wingLength > 0 ? bridge.wingLength : 6
  const wingAngle = Number.isFinite(bridge.wingAngle) ? bridge.wingAngle! : 45
  const halfGap = gap / 2
  const angle = (Math.max(0, Math.min(90, wingAngle)) * Math.PI) / 180
  const wingDx = wingLength * Math.cos(angle)
  const wingDy = wingLength * Math.sin(angle)
  const maxHalf = halfGap + wingDy
  // Уписуємо весь знак у вертикаль; на 48 px зразок можна підсилити.
  const scale = Math.min(2, (sizePx * 0.42) / Math.max(maxHalf, 0.1))
  const padX = Math.max(sizePx * 0.08, wingDx * scale + 1)
  const x0 = padX
  const x1 = sizePx - padX
  const cy = sizePx / 2
  const topY = cy - halfGap * scale
  const bottomY = cy + halfGap * scale
  context.strokeStyle = bridge.color ?? entry.color ?? '#000000'
  context.lineWidth = Math.max(2, width * 1.5)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.setLineDash([])
  context.beginPath()
  context.moveTo(x0, topY)
  context.lineTo(x1, topY)
  context.moveTo(x0, bottomY)
  context.lineTo(x1, bottomY)
  // Вусики розходяться назовні: верхні — вгору, нижні — вниз.
  for (const [x, direction] of [[x0, -1], [x1, 1]] as const) {
    context.moveTo(x, topY)
    context.lineTo(x + direction * wingDx * scale, topY - wingDy * scale)
    context.moveTo(x, bottomY)
    context.lineTo(x + direction * wingDx * scale, bottomY + wingDy * scale)
  }
  context.stroke()
}

/** Схематичний патч складного лінійного знака строго за pattern (ті самі числа, що в CIM). */
function drawLinePattern(
  context: CanvasRenderingContext2D,
  entry: LibrarySymbol,
  sizePx: number,
): void {
  const pattern = entry.pattern
  if (pattern?.bridge) {
    drawBridgePattern(context, pattern.bridge, entry, sizePx)
    return
  }
  const strokes = pattern?.strokes ?? []
  const markers = pattern?.markers ?? []
  if (!strokes.length && !markers.length) return
  const padX = sizePx * 0.08
  const x0 = padX
  const x1 = sizePx - padX
  const widthScale = 1.5
  // На 24 px великі штрихи (схил, залізниця) інакше виходять за межі патча.
  const offsetScale = sizePx <= 24 ? 1.5 : 2
  const markerBounds = markers.map((marker) => {
    const offset = (marker.offset ?? 0) * offsetScale
    const size = (marker.size && marker.size > 0 ? marker.size : 4) * offsetScale
    if (marker.shape === 'tick' || marker.shape === 'dot') {
      return [offset - size / 2, offset + size / 2] as const
    }
    if (marker.shape === 'chevron') {
      return [offset - size * 0.35, offset + size * 0.35] as const
    }
    const direction = marker.shape === 'check-up' || marker.shape === 'tooth-up' ? -1 : 1
    const far = offset + direction * size
    return [Math.min(offset, far), Math.max(offset, far)] as const
  })
  let top = Math.min(0, ...markerBounds.map(([min]) => min))
  let bottom = Math.max(0, ...markerBounds.map(([, max]) => max))
  for (const stroke of strokes) {
    const y = (stroke.offset ?? 0) * offsetScale
    const halfWidth = Math.max(3, (stroke.width ?? 2) * widthScale) / 2
    top = Math.min(top, y - halfWidth)
    bottom = Math.max(bottom, y + halfWidth)
  }
  const padY = sizePx * 0.06
  // Центруємо весь зразок (лінію + однобічні штрихи), а не лише лінію.
  const cy = Math.max(
    padY - top,
    padY + (sizePx - padY * 2 - (bottom - top)) / 2 - top,
  )
  const dashOf = (stroke: LinePatternStroke): number[] => {
    if (stroke.dash?.length) return stroke.dash.map((d) => d * widthScale)
    switch (stroke.style ?? 'solid') {
      case 'dash': return [8 * widthScale, 5 * widthScale]
      case 'dot': return [1.5 * widthScale, 5 * widthScale]
      case 'dash-dot': return [8 * widthScale, 4 * widthScale, 1.5 * widthScale, 4 * widthScale]
      default: return []
    }
  }
  for (const stroke of strokes) {
    context.strokeStyle = stroke.color ?? entry.color ?? '#555555'
    context.lineWidth = Math.max(3, (stroke.width ?? 2) * widthScale)
    context.setLineDash(dashOf(stroke))
    if (stroke.dashOffset) context.lineDashOffset = stroke.dashOffset * widthScale
    context.beginPath()
    context.moveTo(x0, cy + (stroke.offset ?? 0) * offsetScale)
    context.lineTo(x1, cy + (stroke.offset ?? 0) * offsetScale)
    context.stroke()
    context.setLineDash([])
    context.lineDashOffset = 0
  }
  for (const marker of markers) {
    const color = marker.color ?? entry.color ?? '#555555'
    const interval = (marker.interval && marker.interval > 0 ? marker.interval : 10) * offsetScale
    const size = (marker.size && marker.size > 0 ? marker.size : 4) * offsetScale
    const shift = (marker.alongOffset ?? 0) * offsetScale
    // Додатний offset — той самий бік, що й у CIM (для горизонтальної лінії).
    const markerCy = cy + (marker.offset ?? 0) * offsetScale
    // Вершини: схематично — на кінцях зразка.
    const xs: number[] = marker.placement === 'vertices'
      ? [x0, x1]
      : Array.from(
        { length: Math.max(0, Math.floor((x1 - x0 - shift) / interval) + 1) },
        (_, index) => x0 + shift + index * interval,
      )
    if (marker.shape === 'dot') {
      context.fillStyle = color
      for (const x of xs) {
        context.beginPath()
        context.arc(x, markerCy, size / 2, 0, Math.PI * 2)
        context.fill()
      }
    } else if (marker.shape === 'tick') {
      context.strokeStyle = color
      context.lineWidth = Math.max(
        2,
        (marker.thickness && marker.thickness > 0 ? marker.thickness : size * 0.35),
      )
      context.beginPath()
      for (const x of xs) {
        context.moveTo(x, markerCy - size / 2)
        context.lineTo(x, markerCy + size / 2)
      }
      context.stroke()
    } else if (marker.shape === 'chevron') {
      // Шеврон «>» за напрямом лінії.
      const halfLen = size / 2
      const halfH = size * 0.35
      context.strokeStyle = color
      context.lineWidth = Math.max(
        1.5,
        (marker.thickness && marker.thickness > 0 ? marker.thickness : 2),
      )
      context.lineJoin = 'miter'
      context.lineCap = 'round'
      context.beginPath()
      for (const x of xs) {
        context.moveTo(x - halfLen, markerCy - halfH)
        context.lineTo(x + halfLen, markerCy)
        context.lineTo(x - halfLen, markerCy + halfH)
      }
      context.stroke()
    } else if (marker.shape === 'check-up' || marker.shape === 'check-down') {
      // Відкрита галочка вершиною на лінії, рамена назовні.
      const direction = marker.shape === 'check-up' ? -1 : 1
      const half = size * 0.35
      context.strokeStyle = color
      context.lineWidth = Math.max(
        1.5,
        (marker.thickness && marker.thickness > 0 ? marker.thickness : 2),
      )
      context.lineJoin = 'miter'
      context.lineCap = 'round'
      context.beginPath()
      for (const x of xs) {
        context.moveTo(x - half, markerCy + direction * size)
        context.lineTo(x, markerCy)
        context.lineTo(x + half, markerCy + direction * size)
      }
      context.stroke()
    } else {
      const direction = marker.shape === 'tooth-up' ? -1 : 1
      const half = size * 0.35
      context.strokeStyle = color
      context.lineWidth = Math.max(
        1.5,
        (marker.thickness && marker.thickness > 0 ? marker.thickness : 2),
      )
      context.lineJoin = 'miter'
      // Зубець гостряком до лінії, як у CIM.
      context.beginPath()
      for (const x of xs) {
        context.moveTo(x - half, markerCy + direction * size)
        context.lineTo(x + half, markerCy + direction * size)
        context.lineTo(x, markerCy)
        context.closePath()
      }
      context.stroke()
    }
  }
  // Парні шеврони біля вершин: схематично — по парі біля кінців зразка, за напрямом.
  const paired = entry.pattern?.pairedArrows
  if (paired) {
    const s = ((paired.size ?? 5)) * offsetScale
    const halfLen = s / 2
    const halfH = s * 0.35
    const gapPx = (paired.gap ?? 7)
    const distPx = (paired.distance ?? 14)
    context.strokeStyle = paired.color ?? entry.color ?? '#000000'
    context.lineWidth = Math.max(1.5, 2)
    context.lineJoin = 'miter'
    context.lineCap = 'round'
    const drawPair = (cx: number) => {
      for (const step of [0, gapPx]) {
        const x = cx + step
        context.beginPath()
        context.moveTo(x - halfLen, cy - halfH)
        context.lineTo(x + halfLen, cy)
        context.lineTo(x - halfLen, cy + halfH)
        context.stroke()
      }
    }
    drawPair(x0 + distPx)
    drawPair(x1 - distPx - gapPx)
  }
}

/**
 * Шаблони створення об’єктів для Editor: по одному на кожен знак бібліотеки
 * з готовим symbol_code у prototype. Клієнтські, сервісні не чіпаємо —
 * але шар покаже саме їх у вікні створення.
 */
export async function applyLayerTemplates(
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  library: EvidenceLibrary,
): Promise<string[]> {
  const warnings: string[] = []
  const byLayer = new Map<string, LibrarySymbol[]>()
  for (const symbol of library.symbols) {
    if (!symbol.layers?.length) continue
    for (const layerKey of symbol.layers) {
      const list = byLayer.get(layerKey) ?? []
      list.push(symbol)
      byLayer.set(layerKey, list)
    }
  }
  for (const [layerKey, symbols] of byLayer) {
    const layer = (layers as Partial<Record<string, FeatureLayer>>)[layerKey]
    if (!layer) continue
    const field = resolveField(layer, symbols[0])
    if (!field) {
      warnings.push(`Поле ${symbols[0].field ?? EVIDENCE_SYMBOL_FIELD} не знайдено в ${layerKey} — шаблони пропущено.`)
      continue
    }
    try {
      const templates: FeatureTemplateProperties[] = []
      for (const symbol of symbols) {
        try {
          const imageData = await buildLegendPatch(symbol)
          templates.push({
            name: symbol.name,
            description: symbol.code,
            drawingTool: drawingToolFor(symbol),
            thumbnail: { contentType: 'png', imageData, width: THUMBNAIL_PX, height: THUMBNAIL_PX },
            prototype: { attributes: { [field]: symbol.code } },
          })
        } catch (error) {
          warnings.push(
            `Не вдалося побудувати шаблон ${symbol.code}: ${error instanceof Error ? error.message : 'невідома помилка'}.`,
          )
        }
      }
      if (templates.length) layer.templates = templates
    } catch (error) {
      warnings.push(
        `Не вдалося задати шаблони для ${layerKey}: ${error instanceof Error ? error.message : 'невідома помилка'}.`,
      )
    }
  }
  return [...new Set(warnings)]
}

/**
 * Символ для інтерактивного малювання (SketchViewModel): той самий вигляд,
 * що й у renderer, побудований під поточний масштаб/вивід.
 */
export async function buildCreateSymbol(
  symbol: LibrarySymbol,
  options: { scale: number; dpi?: number },
): Promise<Symbol> {
  const dpi = options.dpi ?? 96
  const geometry = symbol.geometry ?? 'point'
  if (geometry === 'point') {
    if (symbol.hidden) {
      return new SimpleMarkerSymbol({
        color: [0, 0, 0, 0],
        size: 8,
        outline: { color: [0, 0, 0, 0], width: 1 },
      })
    }
    if (symbol.svg) {
      const base = (POINT_BASE_PX * dpi) / 96
      const size = await markerBox(symbol, base)
      return new PictureMarkerSymbol({ url: librarySymbolUrl(symbol), width: `${size.width}px`, height: `${size.height}px` })
    }
    return new SimpleMarkerSymbol({
      color: symbol.color ?? '#d35400',
      size: 10,
      outline: { color: '#ffffff', width: 1 },
    })
  }
  if (geometry === 'line') {
    if (symbol.pattern) {
      try {
        return buildCimLineSymbol(symbol)
      } catch {
        /* нижче проста лінія */
      }
    }
    return new SimpleLineSymbol({
      color: symbol.stroke?.color ?? symbol.color ?? '#555555',
      width: ((symbol.stroke?.width ?? 2) * dpi) / 96,
      style: symbol.stroke?.style ?? 'solid',
    })
  }
  const outlineWidth = ((symbol.outline?.width ?? 2) * dpi) / 96
  const outline = new SimpleLineSymbol({
    color: symbol.outline?.color ?? symbol.color ?? '#7b3f00',
    width: outlineWidth,
    style: symbol.outline?.style ?? 'solid',
  })
  if (symbol.polygonPattern?.ticks) {
    try {
      return buildCimPolygonSymbol(symbol)
    } catch {
      /* нижче простий контур */
    }
  }
  if (!symbol.fill?.markerSvg || !symbol.fill?.spacingMm) {
    const solid = solidFillColor(symbol)
    return new SimpleFillSymbol({ color: solid ?? [0, 0, 0, 0], outline })
  }
  // Скетч малює у вікні редагування: той самий фіксований тайл, що бачить користувач.
  const spec = tileSpec(symbol, dpi)
  const tilePx = Math.max(spec.tilePx, 4)
  const markerPx = spec.markerPx
  const tileUrl = await buildMarkerTile(
    `${import.meta.env.BASE_URL}${symbol.fill.markerSvg}`,
    tilePx,
    markerPx,
    symbol.fill.layout ?? 'checker',
    symbol.fill.scatter,
  )
  return new PictureFillSymbol({ url: tileUrl, width: tilePx, height: tilePx, outline })
}
