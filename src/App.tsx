import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { CSSProperties } from 'react'
import * as reactiveUtils from '@arcgis/core/core/reactiveUtils.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type Point from '@arcgis/core/geometry/Point.js'
import type Graphic from '@arcgis/core/Graphic.js'
import { getEvidenceWhere } from './features/evidence/evidenceData'
import {
  EVIDENCE_DESCR_FIELD,
  EVIDENCE_SYMBOL_FIELD,
  POINT_BASE_PX,
  evidenceVariantIndexes,
  findLibrarySymbol,
  loadEvidenceLibrary,
  markerBox,
} from './features/symbols/library'
import type { MapSession } from './arcgis/mapSession'
import type { CombinedLegend } from './features/legend/combinedLegend'
import EvidenceTable from './features/evidence/EvidenceTable'
import TaskSearch from './features/tasks/TaskSearch'
import TemplatePicker from './features/editing/TemplatePicker'
import { CUSTOM_SCALE_MAX, CUSTOM_SCALE_MIN, PORTAL_URL, PRINT_SCALES } from './config'
import { a4Dimensions, drawUtmGrid, GRID_LABEL_ANCHOR_MM, type PrintFrame } from './features/print-layout/grid'
import { defaultScaleBarPos, scaleBarDataUrl, scaleBarSpec } from './features/print-layout/scaleBar'
import {
  STAMP_W_MM,
  getStampTable,
  stampBlockHeightMm,
  stampDataUrl,
  type StampTable,
} from './features/stamp/stampData'
import './App.css'
import './viewport-fixes.css'

type Tab = 'edit' | 'print'
type Orientation = 'portrait' | 'landscape'
type Notice = { kind: 'error' | 'info'; message: string }

const frameFor = (orientation: Orientation): PrintFrame => {
  // Поля: якір підписів рівно на межі поля, рамка далі на GRID_LABEL_ANCHOR_MM.
  // Крайовий відступ 7мм; широка сторона (35мм) — під підписи зліва (портрет) або шапку зверху (альбом).
  const edge = 7
  if (orientation === 'portrait') {
    const leftMm = 35 + GRID_LABEL_ANCHOR_MM
    const topMm = edge
    const rightMm = 210 - edge
    const bottomMm = 297 - edge - GRID_LABEL_ANCHOR_MM
    return { leftMm, topMm, widthMm: rightMm - leftMm, heightMm: bottomMm - topMm }
  }
  const leftMm = edge + GRID_LABEL_ANCHOR_MM
  const topMm = 35
  const rightMm = 297 - edge
  const bottomMm = 210 - edge - GRID_LABEL_ANCHOR_MM
  return { leftMm, topMm, widthMm: rightMm - leftMm, heightMm: bottomMm - topMm }
}

/** Дефолтна позиція інсета за порядком у списку: LM перша, BM каскадом униз ліворуч. */
function defaultPosFor(frame: PrintFrame, defs: InsetDef[], id: string): InsetPos {
  const order = Math.max(0, defs.findIndex((def) => def.id === id))
  const y = (frame.heightMm - INSET_H_MM) / 2 - (INSET_H_MM + INSET_GAP_MM) / 2 + order * (INSET_H_MM + INSET_GAP_MM)
  return { xMm: INSET_MARGIN_MM, yMm: Math.min(Math.max(0, y), Math.max(0, frame.heightMm - INSET_H_MM)) }
}

function describeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const detail = 'details' in error && Array.isArray(error.details)
      ? error.details.filter((item): item is string => typeof item === 'string').join(' ')
      : ''
    return `${error.message} ${detail}`.trim().replace(/([?&](?:token|access_token)=)[^&\s]+/gi, '$1[redacted]')
  }
  return fallback
}

function loadPrintImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Не вдалося завантажити знак ${src}.`))
    image.src = src
  })
}

/** Шапка аркуша: ширина блока на папері, висота — з пропорцій viewBox (мм 1:1 з референсом). */
const HEADER_W_MM = 90
const HEADER_H_MM = HEADER_W_MM * 17.5 / 90
const HEADER_MARGIN_MM = 4
const HEADER_SRC = 'header.svg'
type HeaderPos = { xMm: number; yMm: number }
/** Дефолт — вверху по центру екстенту карти (кадру). */
function defaultHeaderPos(frame: PrintFrame): HeaderPos {
  return { xMm: (frame.widthMm - HEADER_W_MM) / 2, yMm: HEADER_MARGIN_MM }
}

let headerTemplateCache: Promise<string> | null = null
function loadHeaderTemplate(): Promise<string> {
  if (!headerTemplateCache) {
    headerTemplateCache = fetch(`${import.meta.env.BASE_URL}${HEADER_SRC}`, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.text()
      })
      .catch((error: unknown) => {
        headerTemplateCache = null
        throw error
      })
  }
  return headerTemplateCache
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** SVG шапки з підставленим task_code — одне джерело для превʼю (<img>) і JPEG (drawImage). */
async function buildHeaderDataUrl(taskCode: string): Promise<string> {
  const template = await loadHeaderTemplate()
  const svg = template.replaceAll('{{TASK_CODE}}', escapeXml(taskCode || ''))
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

type LegendBox = { xMm: number; yMm: number; wMm: number; hMm: number }
type LegendLayout = LegendBox & { evRows: number; taskRows: number; topoRows: number; overflow: number }

/** Стрілка півночі: висота знака на аркуші і відступ дефолтної позиції від кутів кадру. */
const NORTH_ARROW_H_MM = 10
const NORTH_ARROW_W_MM = NORTH_ARROW_H_MM * 642.41 / 929.51
const NORTH_ARROW_MARGIN_MM = 4
const NORTH_ARROW_SRC = 'north-arrow.svg'
type NorthPos = { xMm: number; yMm: number }
/** Дефолт — верхній правий кут екстенту карти (кадру). */
function defaultNorthPos(frame: PrintFrame): NorthPos {
  return {
    xMm: frame.widthMm - NORTH_ARROW_W_MM - NORTH_ARROW_MARGIN_MM,
    yMm: NORTH_ARROW_MARGIN_MM,
  }
}

/** Логотип організації: висота знака на аркуші, ширина — з пропорцій viewBox. */
const HALO_LOGO_H_MM = 12
const HALO_LOGO_W_MM = HALO_LOGO_H_MM * 639.14 / 451.94
const HALO_LOGO_MARGIN_MM = 4
const HALO_LOGO_SRC = 'HALO Logo Dark.svg'
type LogoPos = { xMm: number; yMm: number }
/** Дефолт — лівий верхній кут екстенту карти (кадру). */
function defaultLogoPos(): LogoPos {
  return { xMm: HALO_LOGO_MARGIN_MM, yMm: HALO_LOGO_MARGIN_MM }
}

/** Кутовий штамп: ширина з референса, висота — за кількістю рядків. */
const STAMP_MARGIN_MM = 4
const STAMP_FALLBACK_ROWS = 4

/** Інсет-карти LM/BM: фіксований розмір на аркуші, масштаб на вибір, без сітки й підписів. */
const INSET_W_MM = 40
const INSET_H_MM = 50
const INSET_MIN_MM = 20
const INSET_FRAME_MM = 0.2
const INSET_GAP_MM = 4
const INSET_MARGIN_MM = 4
const INSET_DEFAULT_SCALE = 1000
type InsetKind = 'lm' | 'bm'
type InsetDef = { id: string; kind: InsetKind; label: string }
type InsetPos = { xMm: number; yMm: number }
type InsetSize = { wMm: number; hMm: number }
type StampPos = { xMm: number; yMm: number }
/** Дефолт — лівий нижній кут екстенту карти (кадру). */
function defaultStampPos(frame: PrintFrame, blockHMm: number): StampPos {
  return { xMm: STAMP_MARGIN_MM, yMm: frame.heightMm - blockHMm - STAMP_MARGIN_MM }
}

/**
 * Геометрія легенди в мм кадру. Без кастома — авто-блок унизу справа під контент;
 * з кастомом — як поставив користувач, рядки влізають по висоті, решта в «+N».
 */
function legendLayout(
  frame: PrintFrame,
  custom: LegendBox | null,
  evCount: number,
  topoCount: number,
  taskCount = 0,
): LegendLayout {
  if (!custom) {
    const evRows = Math.min(8, evCount)
    const taskRows = Math.min(Math.max(0, 12 - evRows), taskCount)
    const topoRows = Math.min(Math.max(0, 12 - evRows - taskRows), topoCount)
    const overflow = evCount - evRows + (taskCount - taskRows) + (topoCount - topoRows)
    if (!evRows && !topoRows && !taskRows) {
      const wMm = 38
      const hMm = 28
      return {
        xMm: frame.widthMm - 4 - wMm,
        yMm: frame.heightMm - 7 - hMm,
        wMm,
        hMm,
        evRows: 0,
        taskRows: 0,
        topoRows: 0,
        overflow: 0,
      }
    }
    const hMm = 2 + (evRows + taskRows + topoRows) * 6 + (overflow > 0 ? 5 : 0) + 2
    const wMm = 64
    return {
      xMm: frame.widthMm - 4 - wMm,
      yMm: frame.heightMm - 7 - hMm,
      wMm,
      hMm,
      evRows,
      taskRows,
      topoRows,
      overflow,
    }
  }
  const fit = Math.max(0, Math.floor((custom.hMm - 4) / 6))
  // Ручний розмір: показуємо стільки, скільки влізає по висоті, без капу 12 —
  // інакше розтягування блока не прибирає «+N». Резервуємо ~1 рядок під «+N»,
  // якщо всі записи не влізли.
  let evRows = Math.min(evCount, fit)
  let taskRows = Math.min(taskCount, Math.max(0, fit - evRows))
  let topoRows = Math.min(topoCount, Math.max(0, fit - evRows - taskRows))
  if (evCount + taskCount + topoCount > fit && fit > 0 && evRows + taskRows + topoRows >= fit) {
    if (topoRows > 0) topoRows -= 1
    else if (taskRows > 0) taskRows -= 1
    else if (evRows > 0) evRows -= 1
  }
  const wMm = Math.min(Math.max(30, custom.wMm), frame.widthMm)
  const hMm = Math.min(Math.max(15, custom.hMm), frame.heightMm)
  return {
    xMm: Math.min(Math.max(0, custom.xMm), Math.max(0, frame.widthMm - wMm)),
    yMm: Math.min(Math.max(0, custom.yMm), Math.max(0, frame.heightMm - hMm)),
    wMm,
    hMm,
    evRows,
    taskRows,
    topoRows,
    overflow: evCount - evRows + (taskCount - taskRows) + (topoCount - topoRows),
  }
}

function App() {
  const [userName, setUserName] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('edit')
  const [busy, setBusy] = useState(true)
  const [busyStep, setBusyStep] = useState('Перевірка сесії…')
  const [signingIn, setSigningIn] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const sessionRef = useRef<MapSession | null>(null)
  const taskIdsRef = useRef<unknown[]>([])
  const printInitRef = useRef(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [taskCodes, setTaskCodes] = useState<unknown[]>([])
  const [taskCode, setTaskCode] = useState('')
  const [legendWarnings, setLegendWarnings] = useState<string[]>([])
  const [legend, setLegend] = useState<CombinedLegend>({
    evidence: [],
    topo: [],
    task: [],
    warnings: [],
    truncated: false,
  })
  const [legendBox, setLegendBox] = useState<LegendBox | null>(null)
  const [northPos, setNorthPos] = useState<NorthPos | null>(null)
  const [logoPos, setLogoPos] = useState<LogoPos | null>(null)
  const [headerPos, setHeaderPos] = useState<HeaderPos | null>(null)
  const [scalePos, setScalePos] = useState<{ xMm: number; yMm: number } | null>(null)
  const [stampPos, setStampPos] = useState<StampPos | null>(null)
  const [headerUrl, setHeaderUrl] = useState<string | null>(null)
  const [stampTable, setStampTable] = useState<StampTable | null>(null)
  const legendCardRef = useRef<HTMLDivElement>(null)
  const legendDragRef = useRef<null | {
    mode: 'move' | 'sizeW' | 'sizeH' | 'sizeWH'
    startX: number
    startY: number
    orig: LegendBox
  }>(null)
  const [evidenceRev, setEvidenceRev] = useState(0)
  const [zoneWkid, setZoneWkid] = useState(32636)
  const [orientation, setOrientation] = useState<Orientation>('landscape')
  const [scale, setScale] = useState(500)
  const [scaleDraft, setScaleDraft] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const customInputRef = useRef<HTMLInputElement>(null)
  const [insets, setInsets] = useState<InsetDef[]>([])
  const [insetScales, setInsetScales] = useState<{ lm: number; bm: number }>({ lm: INSET_DEFAULT_SCALE, bm: INSET_DEFAULT_SCALE })
  const [insetPos, setInsetPos] = useState<Record<string, InsetPos | null>>({})
  const [insetSize, setInsetSize] = useState<Record<string, InsetSize | null>>({})
  const [insetFound, setInsetFound] = useState<Record<string, boolean>>({})
  const [insetEnabled, setInsetEnabled] = useState<Record<string, boolean>>({})
  // Режим переміщення інсетів (дефолт — увімкнено): бокс тягнеться по аркушу,
  // а панорамування/зум усередині вимкнено — інакше Esri перехоплює drag
  // раніше за обробник рамки і їде карта, а не бокс.
  const [insetMove, setInsetMove] = useState(true)
  const [gridVisible, setGridVisible] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [symbolsBusy, setSymbolsBusy] = useState(false)
  const zoneWkidRef = useRef(zoneWkid)
  const scaleRef = useRef(scale)
  const tabRef = useRef<Tab>('edit')
  const insetScalesRef = useRef(insetScales)
  const insetMoveRef = useRef(insetMove)
  useEffect(() => { zoneWkidRef.current = zoneWkid }, [zoneWkid])
  useEffect(() => { scaleRef.current = scale }, [scale])
  useEffect(() => { tabRef.current = tab }, [tab])
  useEffect(() => { insetScalesRef.current = insetScales }, [insetScales])
  useEffect(() => { insetMoveRef.current = insetMove }, [insetMove])
  const editMapRef = useRef<HTMLDivElement>(null)
  const printMapRef = useRef<HTMLDivElement>(null)
  const insetMapRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const insetViewsRef = useRef<Record<string, MapView | null>>({})
  const insetCentersRef = useRef<Record<string, Point>>({})
  /** Канонічні графіки бейджів (не змонтовані): розкладаються копіями по вʼю. */
  const badgeGraphicsRef = useRef<Graphic[]>([])
  /** Посередник на rebuild шевронів: самі функції оголошено нижче за місцем виклику. */
  const rebuildPowerlineArrowsRef = useRef<((code: string) => Promise<void>) | null>(null)
  const rebuildPowerlineArrowsForViewRef = useRef<((view: MapView, code: string) => Promise<void>) | null>(null)
  const frameNodeRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const paperWrapRef = useRef<HTMLDivElement>(null)
  const gridCanvasRef = useRef<HTMLCanvasElement>(null)
  const [paperPx, setPaperPx] = useState({ w: 0, h: 0 })
  const frame = useMemo(() => frameFor(orientation), [orientation])
  const page = useMemo(() => a4Dimensions(orientation), [orientation])
  const scaleSpec = useMemo(() => scaleBarSpec(scale), [scale])
  const scaleUrl = useMemo(() => scaleBarDataUrl(scaleSpec), [scaleSpec])
  const frameStyle = useMemo(() => ({
    left: `${frame.leftMm / page.widthMm * 100}%`,
    top: `${frame.topMm / page.heightMm * 100}%`,
    width: `${frame.widthMm / page.widthMm * 100}%`,
    height: `${frame.heightMm / page.heightMm * 100}%`,
  }) as CSSProperties, [frame, page])

  const paintGrid = useCallback(() => {
    const canvas = gridCanvasRef.current
    const pageNode = pageRef.current
    const printView = sessionRef.current?.printView
    if (!canvas || !pageNode || !printView?.ready || !taskCode) return
    // Свіже полотно на кожне малювання: жодних нашарувань принципово.
    canvas.width = Math.round(page.widthMm * 96 / 25.4)
    canvas.height = Math.round(page.heightMm * 96 / 25.4)
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    const context = canvas.getContext('2d')
    if (!context) return
    // Сітка має сенс лише коли printView реально в обраній UTM-зоні (метри).
    // Інакше не малюємо оманливу сітку — чекаємо завершення reprojection.
    if (!gridVisible || printView.spatialReference?.wkid !== zoneWkid) {
      context.clearRect(0, 0, canvas.width, canvas.height)
      return
    }
    const center = printView.center
    if (!center) return
    // Крок беремо з живого масштабу в’ю, а не зі стану: інакше в перехідний
    // момент сітка малюється під цільовий масштаб поверх старої карти.
    drawUtmGrid(context, frame, { x: center.x, y: center.y }, printView.scale || scale, 96, true)
  }, [frame, page, scale, taskCode, zoneWkid, gridVisible])

  useEffect(() => {
    let mounted = true
    import('./arcgis/auth').then(({ getSignedInUser }) => getSignedInUser())
      .then((user) => { if (mounted) setUserName(user?.username ?? null) })
      .catch(() => { if (mounted) setUserName(null) })
      .finally(() => { if (mounted) setBusy(false) })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!userName || !editMapRef.current) return
    let cancelled = false
    let created: MapSession | null = null
    setBusy(true)
    setBusyStep('Відкриття WebMap…')
    setNotice(null)
    printInitRef.current = false
    taskIdsRef.current = []
    import('./arcgis/mapSession').then(({ createMapSession }) => createMapSession(
      editMapRef.current!,
      (step) => {
        if (!cancelled) setBusyStep(step)
      },
      (message) => {
        if (!cancelled) setNotice({ kind: 'error', message })
      },
    ))
      .then(async (result) => {
        if (cancelled) { result.destroy(); return }
        created = result
        sessionRef.current = result
        setSessionReady(true)
        const requiredLayers = ['task', 'evidence', 'taskGeopoint', 'taskPolygon', 'polygonGeopoint', 'topoPoint', 'topoLines', 'topoPolygons', 'imsmaPolygons'] as const
        const missingLayers = requiredLayers.filter((key) => !result.layers[key])
        if (missingLayers.length) setNotice({ kind: 'error', message: `WebMap завантажена, але не зіставлено шари: ${missingLayers.join(', ')}.` })
        const taskLayer = result.layers.task
        if (taskLayer) {
          if (!cancelled) setBusyStep('Завантаження кодів завдань…')
          const { getTaskCodes } = await import('./arcgis/taskFilter')
          const codes = await Promise.race([
            getTaskCodes(taskLayer),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Завантаження task_code перевищило 60 с. Перевірте мережу та Portal.')), 60000)),
          ])
          if (cancelled) { result.destroy(); return }
          setTaskCodes(codes)
          if (codes.length === 0) setNotice({ kind: 'info', message: 'У шарі task не знайдено записів із заповненим task_code.' })
        }
        const { loadSymbolRegistry, applySymbolRegistry } = await import('./features/symbols/registry')
        const registry = await loadSymbolRegistry()
        if (cancelled) { result.destroy(); return }
        setLegendWarnings([
          ...(registry.symbols.length ? applySymbolRegistry(result.layers, registry) : []),
          ...result.symbolWarnings,
        ])
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice({ kind: 'error', message: describeError(error, 'Не вдалося завантажити WebMap.') })
      })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => {
      cancelled = true
      destroyInsetViews()
      badgeGraphicsRef.current = []
      created?.destroy()
      sessionRef.current = null
      printInitRef.current = false
      taskIdsRef.current = []
      setSessionReady(false)
    }
  }, [userName])

  // Editor створюється один раз і живе постійно: його DOM ніколи не розмонтовується
  // React-ом (ховання лише CSS-ом), інакше Esri і React б’ються за вузли — білий екран.
  useEffect(() => {
    const current = sessionRef.current
    if (!sessionReady || !current || !editorRef.current) return
    try {
      current.ensureEditor(editorRef.current)
    } catch (error) {
      // Помилка ініціалізації зовнішньої системи (Esri) — повідомляємо, а не мовчимо.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNotice({ kind: 'error', message: describeError(error, 'Не вдалося підключити редактор.') })
    }
  }, [sessionReady])

  // Ліниве створення друкованої карти: лише коли вкладка друку видима.
  useEffect(() => {
    if (tab !== 'print' || !sessionReady || printInitRef.current) return
    const session = sessionRef.current
    const container = printMapRef.current
    if (!session || !container || session.printView) return
    printInitRef.current = true
    let alive = true
    setBusy(true)
    setBusyStep('Створення друкованої карти…')
    session.ensurePrintView(container)
      .then(async (printView) => {
        if (!alive) return
        // Спочатку просторова привʼязка: зміна SR перестворює LayerView
        // і зносить їхні фільтри, тому фільтр завдання — лише після неї.
        const { setPrintSpatialReference, findAutomaticUtmZone, goToScale } = await import('./arcgis/utm')
        if (taskIdsRef.current.length) {
          const automatic = await findAutomaticUtmZone(session.layers, taskIdsRef.current)
          if (automatic) {
            await setPrintSpatialReference(printView, zoneWkidRef.current, automatic.point)
          } else {
            await setPrintSpatialReference(printView, zoneWkidRef.current)
          }
        } else {
          await setPrintSpatialReference(printView, zoneWkidRef.current)
        }
        if (!alive) return
        if (taskCode) {
          const { filterLayersByTask } = await import('./arcgis/taskFilter')
          await filterLayersByTask(printView, session.layers, taskCode)
        }
        if (!alive) return
        const fitted = taskIdsRef.current.length
          ? await fitPrintToTaskPolygons(printView).catch(() => false)
          : false
        if (!fitted) await goToScale(printView, scaleRef.current)
        paintGrid()
        if (taskIdsRef.current.length) await reportPrintSuspension(printView, zoneWkidRef.current)
        if (!alive) return
        // Страховка від вічного спінера: будь-яке підвисання завантаження дефів
        // інсетів (мережа) за 60 с стає контрольованою помилкою.
        await Promise.race([
          reloadInsetDefs(taskCode),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Карти LM/BM не завантажились за 60 с. Перевірте мережу та Portal.')), 60000)),
        ]).catch((error: unknown) => {
          if (alive) setNotice({ kind: 'error', message: describeError(error, 'Не вдалося створити карти LM/BM.') })
        })
        if (!alive) return
        await rebuildEvidenceBadges(taskCode)
        if (!alive) return
        await rebuildPowerlineArrowsRef.current?.(taskCode)
      })
      .catch((error: unknown) => {
        printInitRef.current = false
        if (alive) setNotice({ kind: 'error', message: describeError(error, 'Не вдалося створити друковану карту.') })
      })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sessionReady])

  const frameRef = useRef(frame)
  useEffect(() => {
    frameRef.current = frame
  }, [frame])

  // Масштаб друку за дефолтом: найменший зі списку, в який вписуються
  // відфільтровані полігони завдання. Ручний вибір діє до наступної таски.
  async function fitPrintToTaskPolygons(view: MapView) {
    const session = sessionRef.current
    if (!session || taskIdsRef.current.length === 0) return false
    const { getTaskPolygonsExtent } = await import('./arcgis/taskFilter')
    const { projectExtent, goToExtent, goToScale } = await import('./arcgis/utm')
    const extent = await getTaskPolygonsExtent(session.layers, taskIdsRef.current)
    if (!extent) return false
    const printFrame = frameRef.current
    const projected = await projectExtent(extent, zoneWkidRef.current).catch(() => null)
    if (projected && projected.width > 0 && projected.height > 0) {
      const required = Math.max(
        (projected.width / printFrame.widthMm) * 1000,
        (projected.height / printFrame.heightMm) * 1000,
      )
      const preset =
        PRINT_SCALES.find((presetScale) => presetScale >= required) ??
        PRINT_SCALES[PRINT_SCALES.length - 1]
      view.center = projected.center
      setScale(preset)
      await goToScale(view, preset)
      return true
    }
    await goToExtent(view, extent.expand(1.25))
    const fallback =
      PRINT_SCALES.find((presetScale) => presetScale >= view.scale) ??
      PRINT_SCALES[PRINT_SCALES.length - 1]
    setScale(fallback)
    await goToScale(view, fallback)
    return true
  }

  function destroyInsetViews() {
    for (const id of Object.keys(insetViewsRef.current)) {
      const insetView = insetViewsRef.current[id]
      delete insetViewsRef.current[id]
      try {
        if (insetView) {
          insetView.map = null
          insetView.destroy()
        }
      } catch {
        /* вже знищено */
      }
    }
  }

  function toggleInset(id: string) {
    setInsetEnabled((prev) => ({ ...prev, [id]: !(prev[id] !== false) }))
  }

  /** Навігація інсета: рухомий бокс — без пана всередині, і навпаки. */
  function applyInsetNavigation(view: MapView, movable: boolean) {
    view.navigation.actionMap.dragPrimary = movable ? 'none' : 'pan'
  }

  /** Дефи інсетів завдання: LM + усі BM (нумерація як у штампі). */
  const reloadInsetDefs = useCallback(async (code: string) => {
    const session = sessionRef.current
    if (!session || !code) {
      insetCentersRef.current = {}
      setInsets([])
      setInsetFound({})
      return
    }
    const { getInsetTargets } = await import('./features/stamp/stampData')
    const targets = await getInsetTargets(session.editView, session.layers.taskGeopoint)
      .catch((): { id: string; kind: 'lm' | 'bm'; label: string; center: Point; oid: number }[] => [])
    const centers: Record<string, Point> = {}
    for (const target of targets) centers[target.id] = target.center
    insetCentersRef.current = centers
    setInsets(targets.map(({ id, kind, label }) => ({ id, kind, label })))
    const found: Record<string, boolean> = {}
    for (const target of targets) found[target.id] = true
    setInsetFound(found)
  }, [])

  /** SR (опційно) + фільтр завдання на інсетах, далі перезавантаження дефів. */
  const syncInsets = useCallback(async (code: string, wkid: number | null) => {
    const session = sessionRef.current
    if (!session) return
    const { filterLayersByTask } = await import('./arcgis/taskFilter')
    const { setPrintSpatialReference } = await import('./arcgis/utm')
    for (const id of Object.keys(insetViewsRef.current)) {
      const target = insetViewsRef.current[id]
      if (!target) continue
      if (wkid !== null) await setPrintSpatialReference(target, wkid)
      await filterLayersByTask(target, session.layers, code)
    }
    await reloadInsetDefs(code)
  }, [reloadInsetDefs])

  /**
   * Цифри варіантів evidence поверх знаків: один код з 2+ описами нумерується
   * (та сама нумерація, що в легенді). Текстовий оверлей у graphics кожного вʼю:
   * прямо, незалежно від повороту знака; зсув — правий низ бокса знака.
   * Перебудова лише при зміні даних (таска/збереження/бібліотека), не при навігації.
   */
  const rebuildEvidenceBadges = useCallback(async (code: string) => {
    const session = sessionRef.current
    const clearViews = () => {
      if (!session) return
      const views = [session.editView, session.printView, ...Object.values(insetViewsRef.current)]
      for (const view of views) {
        if (!view) continue
        try {
          view.graphics.removeAll()
        } catch {
          /* вʼю знищено */
        }
      }
    }
    badgeGraphicsRef.current = []
    try {
      if (!session || !code) {
        clearViews()
        return
      }
      const evidence = session.layers.evidence
      if (!evidence) {
        clearViews()
        return
      }
      const library = await loadEvidenceLibrary()
      const where = await getEvidenceWhere(session.editView, evidence).catch(() => '1=1')
      const pairRes = await evidence.queryFeatures({
        where,
        outFields: [EVIDENCE_SYMBOL_FIELD, EVIDENCE_DESCR_FIELD],
        returnGeometry: false,
        num: 2000,
      }).catch(() => null)
      const pairs = (pairRes?.features ?? []).map((feature) => {
        const attrs = feature.attributes as Record<string, unknown>
        const symbol = attrs[EVIDENCE_SYMBOL_FIELD]
        const descr = attrs[EVIDENCE_DESCR_FIELD]
        return {
          symbol: typeof symbol === 'string' ? symbol : '',
          descr: typeof descr === 'string' ? descr : '',
        }
      })
      const variantMap = evidenceVariantIndexes(pairs, library)
      const badgedCodes = new Set(
        [...variantMap]
          .filter(([, index]) => index !== null && index !== undefined)
          .map(([key]) => key.split('|||')[0]),
      )
      if (badgedCodes.size === 0) {
        clearViews()
        return
      }
      const inList = [...badgedCodes].map((value) => `'${value.replaceAll("'", "''")}'`).join(',')
      const featRes = await evidence.queryFeatures({
        where: `${where} AND ${EVIDENCE_SYMBOL_FIELD} IN (${inList})`,
        outFields: [EVIDENCE_SYMBOL_FIELD, EVIDENCE_DESCR_FIELD],
        returnGeometry: true,
        num: 1000,
      }).catch(() => null)
      const { default: TextSymbol } = await import('@arcgis/core/symbols/TextSymbol.js')
      const { default: Graphic } = await import('@arcgis/core/Graphic.js')
      const graphics: Graphic[] = []
      for (const feature of featRes?.features ?? []) {
        const attrs = feature.attributes as Record<string, unknown>
        const symbol = attrs[EVIDENCE_SYMBOL_FIELD]
        const descr = attrs[EVIDENCE_DESCR_FIELD]
        const code = typeof symbol === 'string' ? symbol : ''
        const text = typeof descr === 'string' ? descr : ''
        const index = variantMap.get(`${code}|||${text}`)
        if (index === null || index === undefined || !feature.geometry) continue
        const lib = findLibrarySymbol(library, code)
        if (!lib?.svg) continue
        const { width, height } = await markerBox({ svg: lib.svg }, POINT_BASE_PX)
        graphics.push(
          new Graphic({
            geometry: feature.geometry,
            symbol: new TextSymbol({
              text: String(index),
              color: 'black',
              haloColor: 'white',
              haloSize: 1,
              xoffset: width / 2,
              yoffset: -height / 2,
              // Цифра висотою в третину знака (cap-height ≈ 0.7em).
              font: { size: Math.max(width, height) / 3 / 0.7, family: 'Arial', weight: 'bold' },
            }),
          }),
        )
      }
      badgeGraphicsRef.current = graphics
      const views = [session.editView, session.printView, ...Object.values(insetViewsRef.current)]
        .filter((view): view is MapView => !!view)
      for (const view of views) {
        try {
          view.graphics.removeAll()
          view.graphics.addMany(graphics.map((graphic) => graphic.clone()))
        } catch {
          /* вʼю знищено */
        }
      }
    } catch {
      /* бейджі необовʼязкові — карта і легенда працюють без них */
    }
  }, [])

  const applyTask = useCallback(async (code: string) => {
    const current = sessionRef.current
    if (!current) return
    setTaskCode(code)
    setHeaderUrl(null)
    setNotice(null)
    try {
      const { filterLayersByTask, zoomToTaskPolygons } = await import('./arcgis/taskFilter')
      const editIds = await filterLayersByTask(current.editView, current.layers, code)
      taskIdsRef.current = editIds
      if (!code) {
        const printView = current.printView
        if (printView) {
          await filterLayersByTask(printView, current.layers, code)
        }
        await syncInsets('', null)
        await rebuildEvidenceBadges('')
        await rebuildPowerlineArrowsRef.current?.('')
        return
      }
      const hasPolygons = await zoomToTaskPolygons(current.editView, current.layers, editIds)
      if (!hasPolygons) {
        setNotice({ kind: 'info', message: `Для завдання ${code} не знайдено пов’язаних полігонів task polygon.` })
      }
      const { findAutomaticUtmZone, setPrintSpatialReference, whenViewSettled } = await import('./arcgis/utm')
      const automaticZone = await findAutomaticUtmZone(current.layers, editIds)
      if (automaticZone) {
        setZoneWkid(automaticZone.wkid)
        const target = current.printView
        if (target) {
          await setPrintSpatialReference(target, automaticZone.wkid, automaticZone.point)
          // Фільтр друку — після зміни SR, інакше перестворені LayerView його знесуть.
          await filterLayersByTask(target, current.layers, code)
          await syncInsets(code, automaticZone.wkid)
          const fitted = await fitPrintToTaskPolygons(target).catch(() => false)
          if (!fitted) {
            const { goToScale } = await import('./arcgis/utm')
            await goToScale(target, scale)
          }
          await whenViewSettled(target)
          await reportPrintSuspension(target, automaticZone.wkid)
        }
      } else {
        // Зона не змінилась — фільтр можна ставити одразу, зносити нема чому.
        const target = current.printView
        if (target) {
          await filterLayersByTask(target, current.layers, code)
        }
        await syncInsets(code, null)
        setNotice({ kind: 'info', message: 'Не знайдено polygon geopoint у вибраному завданні або точка поза UTM 35N–37N. Залишено поточну зону.' })
      }
      await rebuildEvidenceBadges(code)
      await rebuildPowerlineArrowsRef.current?.(code)
    } catch (error) {
      setNotice({ kind: 'error', message: describeError(error, 'Не вдалося застосувати фільтр завдання.') })
    }
  }, [scale, syncInsets, rebuildEvidenceBadges])

  useEffect(() => {
    const current = sessionRef.current
    const printView = current?.printView
    if (!current || !printView || !taskCode) return
    let active = true
    // Масштаб перевиставляємо лише при дрейфі > 0.5% і з дебаунсом,
    // і лише при валідному живому масштабі — інакше goTo-спам не дає в’ю заспокоїтись.
    const ensureScale = () => {
      if (!active) return
      const live = printView.scale
      if (!Number.isFinite(live) || live <= 0) return
      if (Math.abs(live - scale) / scale > 0.005) {
        void printView.goTo({ center: printView.center, scale }, { animate: false }).catch(() => {
          /* перервано новішим goTo або в’ю знищено */
        })
      }
    }
    // Сітка — лише по зупинці карти (дебаунс), а не на кожен тік руху:
    // перемальовка під час жесту дає мерехтіння/«множення».
    let paintTimer: number | undefined
    const schedulePaint = () => {
      if (!active) return
      window.clearTimeout(paintTimer)
      paintTimer = window.setTimeout(() => {
        if (active) paintGrid()
      }, 150)
    }
    const bootTimer = window.setTimeout(ensureScale, 120)
    const handles = [
      reactiveUtils.watch(() => printView.center, () => {
        ensureScale()
        schedulePaint()
      }),
      reactiveUtils.watch(() => printView.scale, schedulePaint),
      reactiveUtils.watch(() => printView.width, schedulePaint),
      reactiveUtils.watch(() => printView.height, schedulePaint),
    ]
    paintGrid()
    return () => {
      active = false
      window.clearTimeout(paintTimer)
      window.clearTimeout(bootTimer)
      handles.forEach((handle) => handle.remove())
    }
  }, [orientation, scale, sessionReady, taskCode, paintGrid])

  useEffect(() => {
    paintGrid()
    const observer = new ResizeObserver(paintGrid)
    if (pageRef.current) observer.observe(pageRef.current)
    return () => observer.disconnect()
  }, [orientation, zoneWkid, scale, sessionReady, taskCode, paintGrid])

  // Інсети: масштаб тримаємо замкненим на вибраному (з допуском і дебаунсом,
  // як у головної карти), пан — вільний. LM — свій масштаб, усі BM — спільний.
  useEffect(() => {
    const views = insets.flatMap((def) => {
      const view = insetViewsRef.current[def.id]
      return view ? [{ view, target: def.kind === 'lm' ? insetScales.lm : insetScales.bm }] : []
    })
    if (!views.length) return
    let active = true
    const lock = (view: MapView, target: number) => {
      if (!active) return
      const live = view.scale
      if (!Number.isFinite(live) || live <= 0) return
      if (Math.abs(live - target) / target > 0.005) {
        void view.goTo({ center: view.center, scale: target }, { animate: false }).catch(() => {
          /* перервано новішим goTo або вʼю знищено */
        })
      }
    }
    const timers = views.map(({ view, target }) => window.setTimeout(() => lock(view, target), 120))
    let paintTimer: number | undefined
    const handles = views.flatMap(({ view, target }) => [
      reactiveUtils.watch(() => view.scale, () => {
        if (!active) return
        window.clearTimeout(paintTimer)
        paintTimer = window.setTimeout(() => lock(view, target), 150)
      }),
    ])
    return () => {
      active = false
      timers.forEach((timer) => window.clearTimeout(timer))
      window.clearTimeout(paintTimer)
      handles.forEach((handle) => handle.remove())
    }
  }, [orientation, insetScales, insets, insetEnabled, insetFound, sessionReady, tab, taskCode])

  // Перемикач руху інсетів: розблоковує drag бокса, блокуючи пан/зум усередині.
  useEffect(() => {
    for (const def of insets) {
      const insetView = insetViewsRef.current[def.id]
      if (insetView) applyInsetNavigation(insetView, insetMove)
    }
  }, [insetMove, insets])

  // Шеврони ЛЕП: оновлення при зупинці будь-якої вʼю (пан/зум міняє кадр запиту).
  useEffect(() => {
    const session = sessionRef.current
    if (!sessionReady || !session) return
    const views = [session.editView, session.printView, ...Object.values(insetViewsRef.current)]
      .filter((view): view is MapView => !!view)
    let alive = true
    const timers = new Map<MapView, number>()
    const handles = views.map((view) => reactiveUtils.watch(
      () => view.stationary,
      (stationary) => {
        if (!stationary || !alive) return
        window.clearTimeout(timers.get(view))
        timers.set(view, window.setTimeout(() => {
          if (alive) void rebuildPowerlineArrowsRef.current?.(taskCode)
        }, 500))
      },
    ))
    return () => {
      alive = false
      handles.forEach((handle) => handle.remove())
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [sessionReady, taskCode, insets, tab])

  // Шеврони ЛЕП: перебудова при правках тополіній.
  useEffect(() => {
    const topo = sessionReady ? sessionRef.current?.layers.topoLines : undefined
    if (!topo) return
    const handle = topo.on('edits', () => {
      void rebuildPowerlineArrowsRef.current?.(taskCode)
    })
    return () => handle.remove()
  }, [sessionReady, taskCode])

  // Створення/знищення вʼю інсетів за дефами і тоглом видимості.
  // Контейнери рендеряться з `insets`, тож на момент ефекту вони змонтовані.
  useEffect(() => {
    const session = sessionRef.current
    if (!sessionReady || !session || !session.printView) return
    let alive = true
    void (async () => {
      const [{ default: MapView }, { setPrintSpatialReference }, { filterLayersByTask }] = await Promise.all([
        import('@arcgis/core/views/MapView.js'),
        import('./arcgis/utm'),
        import('./arcgis/taskFilter'),
      ])
      for (const def of insets) {
        if (!alive) return
        const on = insetEnabled[def.id] !== false && insetFound[def.id] === true
        const existing = insetViewsRef.current[def.id]
        if (!on) {
          if (existing) {
            try {
              existing.map = null
              existing.destroy()
            } catch {
              /* вже знищено */
            }
            insetViewsRef.current[def.id] = null
          }
          continue
        }
        if (existing) continue
        const container = insetMapRefs.current[def.id]
        if (!container || !taskCode) continue
        const insetView = new MapView({
          map: session.map,
          container,
          popupEnabled: false,
          constraints: { snapToZoom: false, rotationEnabled: false },
        })
        insetView.navigation.actionMap.mouseWheel = 'none'
        insetView.ui.components = []
        applyInsetNavigation(insetView, insetMoveRef.current)
        await insetView.when()
        if (!alive) {
          try {
            insetView.destroy()
          } catch {
            /* вже знищено */
          }
          return
        }
        // Спочатку SR (зносить LayerView), потім фільтр — як у друкованої карти.
        await setPrintSpatialReference(insetView, zoneWkidRef.current)
        if (!alive) return
        await filterLayersByTask(insetView, session.layers, taskCode)
        if (!alive) return
        insetViewsRef.current[def.id] = insetView
        const center = insetCentersRef.current[def.id]
        if (center) {
          try {
            await insetView.goTo(
              { center, scale: def.kind === 'lm' ? insetScalesRef.current.lm : insetScalesRef.current.bm },
              { animate: false },
            )
          } catch {
            /* перервано новішим goTo або вʼю знищено */
          }
        }
        // Накладаємо збережені бейджі варіантів evidence (з taskCode-оновлення).
        const stored = badgeGraphicsRef.current
        if (stored.length) {
          try {
            insetView.graphics.addMany(stored.map((graphic) => graphic.clone()))
          } catch {
            /* вʼю знищено */
          }
        }
        // Шеврони ЛЕП для нової вʼю (кадр уже на місці після goTo вище).
        await rebuildPowerlineArrowsForViewRef.current?.(insetView, taskCode)
      }
      for (const id of Object.keys(insetViewsRef.current)) {
        if (!insets.some((def) => def.id === id)) {
          const stale = insetViewsRef.current[id]
          delete insetViewsRef.current[id]
          try {
            if (stale) {
              stale.map = null
              stale.destroy()
            }
          } catch {
            /* вже знищено */
          }
        }
      }
    })().catch((error: unknown) => {
      if (alive) setNotice({ kind: 'error', message: describeError(error, 'Не вдалося створити карти LM/BM.') })
    })
    return () => {
      alive = false
    }
  }, [insets, insetEnabled, insetFound, sessionReady, tab, taskCode])

  // Точний розмір аркуша в px: вписуємо A4-пропорцію в доступне місце.
  // CSS-фолбек навмисно висотний (height:100% + aspect-ratio): пропорція
  // тримається завжди, гірше — лише поля з боків; JS далі вписує точно.
  useEffect(() => {
    const wrap = paperWrapRef.current
    if (!wrap) return
    let retries = 0
    const fit = () => {
      const availW = wrap.clientWidth
      const availH = wrap.clientHeight
      if (!availW || !availH) {
        // Монтування до розкладки: пробуємо ще кілька кадрів, інакше
        // сторінка лишається на CSS-фолбеку без JS-розміру і її гне.
        if (retries < 10) {
          retries += 1
          window.requestAnimationFrame(fit)
        }
        return
      }
      const ratio = page.widthMm / page.heightMm
      let w = availW
      let h = w / ratio
      if (h > availH) {
        h = availH
        w = h * ratio
      }
      setPaperPx((prev) => {
        const next = { w: Math.floor(w), h: Math.floor(h) }
        return prev.w === next.w && prev.h === next.h ? prev : next
      })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [page, tab])

  // Комбінована легенда макета: evidence + task-шари (живий renderer) + топошари в межах кадру.
  // Оновлюється при зміні завдання, правках, русі/масштабі/зоні друкованої карти.
  useEffect(() => {
    const session = sessionRef.current
    const printView = session?.printView
    const evidence = session?.layers.evidence
    if (!sessionReady || !printView || !evidence || !taskCode) {
      setLegend({ evidence: [], topo: [], task: [], warnings: [], truncated: false })
      return
    }
    let alive = true
    let timer: number | undefined
    const reload = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void (async () => {
          const [{ getCombinedLegend }, { loadEvidenceLibrary }] = await Promise.all([
            import('./features/legend/combinedLegend'),
            import('./features/symbols/library'),
          ])
          const library = await loadEvidenceLibrary()
          const next = await getCombinedLegend(printView, session.layers, library, frame, scale)
          if (alive) setLegend(next)
        })().catch((error: unknown) => {
          if (alive) setNotice({ kind: 'error', message: describeError(error, 'Не вдалося завантажити легенду.') })
        })
      }, 450)
    }
    reload()
    const centerHandle = reactiveUtils.watch(() => printView.center, reload)
    const scaleHandle = reactiveUtils.watch(() => printView.scale, reload)
    const editHandles: { remove(): void }[] = []
    for (const layer of [evidence, session.layers.topoPoint, session.layers.topoLines, session.layers.topoPolygons]) {
      if (layer) editHandles.push(layer.on('edits', reload))
    }
    return () => {
      alive = false
      window.clearTimeout(timer)
      centerHandle.remove()
      scaleHandle.remove()
      editHandles.forEach((handle) => handle.remove())
    }
  }, [sessionReady, tab, taskCode, evidenceRev, zoneWkid, orientation, frame, scale])

  // Перевірка призупинених шарів лише по заспокоєній вʼю: прапорець suspended
  // під час завантаження/оновлення — перехідний, такі шари пропускаємо.
  // Поза діапазоном масштабу або підклад в UTM — очікувано, мʼяке інфо.
  // Решта призупинених операційних — реальна поломка, помилка.
  async function reportPrintSuspension(view: MapView, wkid: number) {
    try {
      const { listSuspendedLayerInfos, whenViewSettled } = await import('./arcgis/utm')
      await whenViewSettled(view, 30000, 'Друкована карта').catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (view.destroyed) return
      const settled = new Set(
        view.allLayerViews.toArray()
          .filter((layerView) => !!layerView.suspended && !layerView.updating)
          .map((layerView) => layerView.layer?.title || 'без назви'),
      )
      const infos = listSuspendedLayerInfos(view).filter((info) => settled.has(info.title))
      if (!infos.length) return
      // Поза діапазоном масштабу (min/maxScale веб-карти) — очікувано за авторством,
      // мʼяке інфо. Решта призупинених — реальна поломка, помилка.
      const rangeByTitle = new Map<string, { min: number; max: number }>()
      for (const layerView of view.allLayerViews.toArray()) {
        const title = layerView.layer?.title || 'без назви'
        if (!settled.has(title) || rangeByTitle.has(title)) continue
        const layer = layerView.layer as unknown as { minScale?: number; maxScale?: number } | null
        rangeByTitle.set(title, { min: layer?.minScale ?? 0, max: layer?.maxScale ?? 0 })
      }
      const outOfScale = (title: string) => {
        const range = rangeByTitle.get(title)
        if (!range) return false
        return (range.max > 0 && view.scale < range.max) || (range.min > 0 && view.scale > range.min)
      }
      const operational = infos.filter((info) => !info.isBasemap).map((info) => info.title)
      const broken = operational.filter((title) => !outOfScale(title))
      const outOfRange = operational.filter((title) => outOfScale(title))
      const base = infos.filter((info) => info.isBasemap).map((info) => info.title)
      if (broken.length) {
        setNotice({ kind: 'error', message: `EPSG:${wkid}: не відображаються шари: ${broken.join(', ')}. Друк буде без них.` })
      } else {
        const parts = [
          ...outOfRange.map((title) => `${title} (поза діапазоном масштабу)`),
          ...base.map((title) => `підклад «${title}» (недоступний в UTM)`),
        ]
        setNotice({ kind: 'info', message: `У друк не потраплять: ${parts.join('; ')}.` })
      }
    } catch {
      /* в’ю знищено або шари ще не готові — мовчимо */
    }
  }

  // Інфо-тости зникають самі, помилки — лише хрестиком.
  useEffect(() => {
    if (!notice || notice.kind !== 'info') return
    const timer = window.setTimeout(() => setNotice(null), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])

  /** Живе оновлення знаків після ручних правок library.json/SVG: без перезавантаження вкладки. */
  async function reloadSymbols() {
    const session = sessionRef.current
    if (!session || symbolsBusy) return
    setSymbolsBusy(true)
    setNotice(null)
    try {
      const {
        loadEvidenceLibrary,
        applyLibraryRenderers,
        applyLayerTemplates,
        clearSymbolImageCache,
      } = await import('./features/symbols/library')
      // Картинки першими: інакше перебудова візьме старі з ін-memory кешу.
      clearSymbolImageCache()
      const library = await loadEvidenceLibrary(true)
      const warnings = [
        ...(await applyLibraryRenderers(session.layers, library, { force: true })),
        ...(await applyLayerTemplates(session.layers, library)),
      ]
      session.library = library
      setLegendWarnings(warnings)
      setEvidenceRev((rev) => rev + 1)
      await rebuildEvidenceBadges(taskCode)
      setNotice({ kind: 'info', message: `Бібліотеку оновлено: ${library.symbols.length} знаків.` })
    } catch (error) {
      setNotice({ kind: 'error', message: describeError(error, 'Не вдалося оновити бібліотеку знаків.') })
    } finally {
      setSymbolsBusy(false)
    }
  }

  async function exportJpeg() {
    const current = sessionRef.current
    const printView = current?.printView
    if (!current || !printView || !pageRef.current) {
      setNotice({ kind: 'error', message: 'Друкована карта ще не створена. Відкрийте вкладку «Макет друку» і дочекайтеся завантаження.' })
      return
    }
    setExporting(true)
    setNotice(null)
    try {
      const { whenViewSettled } = await import('./arcgis/utm')
      await printView.when()
      await whenViewSettled(printView, 30000, 'Друкована карта')
      const viewWkid = printView.spatialReference?.wkid
      if (viewWkid !== zoneWkid) {
        throw new Error(`Друкована карта в EPSG:${viewWkid ?? 'невідомо'}, а обрано EPSG:${zoneWkid}. Дочекайтеся перепроєктування або оберіть іншу зону.`)
      }
      const dpi = 300
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(page.widthMm / 25.4 * dpi)
      canvas.height = Math.round(page.heightMm / 25.4 * dpi)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Браузер не зміг створити полотно для експорту.')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const frameWidth = Math.round(frame.widthMm / 25.4 * dpi)
      const frameHeight = Math.round(frame.heightMm / 25.4 * dpi)
      // Скріншот — строго пропорційно в’ю (той самий аспект): SDK масштабує рівномірно,
      // масштаб і пропорції знаків на папері точні. Знаки в екранних px (без перебудов) — upscale робить решту.
      const shotScale = 300 / 96
      const shotWidth = Math.max(1, Math.round(printView.width * shotScale))
      const shotHeight = Math.max(1, Math.round(printView.height * shotScale))
      const screenshot = await printView.takeScreenshot({ width: shotWidth, height: shotHeight })
      const mapImage = new Image()
      mapImage.src = screenshot.dataUrl
      await mapImage.decode()
      // takeScreenshot може повернути інший аспект, ніж фрейм, якщо екранний
      // контейнер в’юхи не збігається з A4-пропорцією. Стретч ламає масштаб,
      // тому малюємо cover-crop по центру: масштаб зберігається, зайве обрізається.
      const destX = frame.leftMm / 25.4 * dpi
      const destY = frame.topMm / 25.4 * dpi
      const srcAspect = mapImage.naturalWidth / mapImage.naturalHeight
      const destAspect = frameWidth / frameHeight
      let sx = 0
      let sy = 0
      let sw = mapImage.naturalWidth
      let sh = mapImage.naturalHeight
      if (Math.abs(srcAspect - destAspect) / destAspect > 0.005) {
        if (srcAspect > destAspect) {
          sw = Math.round(mapImage.naturalHeight * destAspect)
          sx = Math.round((mapImage.naturalWidth - sw) / 2)
        } else {
          sh = Math.round(mapImage.naturalWidth / destAspect)
          sy = Math.round((mapImage.naturalHeight - sh) / 2)
        }
      }
      context.drawImage(mapImage, sx, sy, sw, sh, destX, destY, frameWidth, frameHeight)
      const center = printView.center
      if (gridVisible && center) drawUtmGrid(context, frame, { x: center.x, y: center.y }, scale, dpi)
      // Інсет-карти поверх головної карти: ті самі мм-прямокутники, що в превʼю.
      for (const def of insets) {
        if (insetEnabled[def.id] === false || !insetFound[def.id]) continue
        const insetView = insetViewsRef.current[def.id]
        if (!insetView) continue
        await whenViewSettled(insetView, 30000, def.kind === 'lm' ? 'Карта LM' : `Карта ${def.label}`)
        const insetShotScale = 300 / 96
        const insetShot = await insetView.takeScreenshot({
          width: Math.max(1, Math.round(insetView.width * insetShotScale)),
          height: Math.max(1, Math.round(insetView.height * insetShotScale)),
        })
        const insetImage = new Image()
        insetImage.src = insetShot.dataUrl
        await insetImage.decode()
        const insetPosEff = insetPos[def.id] ?? defaultPosFor(frame, insets, def.id)
        const insetSizeEff = insetSize[def.id] ?? { wMm: INSET_W_MM, hMm: INSET_H_MM }
        const insetDestX = (frame.leftMm + insetPosEff.xMm) / 25.4 * dpi
        const insetDestY = (frame.topMm + insetPosEff.yMm) / 25.4 * dpi
        const insetDestW = insetSizeEff.wMm / 25.4 * dpi
        const insetDestH = insetSizeEff.hMm / 25.4 * dpi
        const insetAspect = insetImage.naturalWidth / insetImage.naturalHeight
        const insetWant = insetSizeEff.wMm / insetSizeEff.hMm
        let insetSx = 0
        let insetSy = 0
        let insetSw = insetImage.naturalWidth
        let insetSh = insetImage.naturalHeight
        if (Math.abs(insetAspect - insetWant) / insetWant > 0.005) {
          if (insetAspect > insetWant) {
            insetSw = Math.round(insetImage.naturalHeight * insetWant)
            insetSx = Math.round((insetImage.naturalWidth - insetSw) / 2)
          } else {
            insetSh = Math.round(insetImage.naturalWidth / insetWant)
            insetSy = Math.round((insetImage.naturalHeight - insetSh) / 2)
          }
        }
        context.drawImage(insetImage, insetSx, insetSy, insetSw, insetSh, insetDestX, insetDestY, insetDestW, insetDestH)
        context.strokeStyle = '#333333'
        context.lineWidth = Math.max(1, Math.round(INSET_FRAME_MM / 25.4 * dpi))
        context.strokeRect(insetDestX, insetDestY, insetDestW, insetDestH)
      }
      // Стрілка півночі: той самий SVG і та сама позиція (мм кадру), що в превʼю.
      const northExport = northPos ?? defaultNorthPos(frame)
      try {
        const arrow = await loadPrintImage(`${import.meta.env.BASE_URL}${NORTH_ARROW_SRC}`)
        context.drawImage(
          arrow,
          (frame.leftMm + northExport.xMm) / 25.4 * dpi,
          (frame.topMm + northExport.yMm) / 25.4 * dpi,
          NORTH_ARROW_W_MM / 25.4 * dpi,
          NORTH_ARROW_H_MM / 25.4 * dpi,
        )
      } catch {
        // SVG недоступний — текстовий фолбек, щоб друк не лишився без півночі.
        context.fillStyle = '#172b45'
        context.textAlign = 'left'
        context.font = `bold ${Math.round(3 * dpi / 25.4)}px Arial, sans-serif`
        context.fillText('N ▲', (frame.leftMm + northExport.xMm) / 25.4 * dpi, (frame.topMm + northExport.yMm + 4) / 25.4 * dpi)
      }
      // Логотип: той самий SVG і та сама позиція (мм кадру), що в превʼю.
      const logoExport = logoPos ?? defaultLogoPos()
      try {
        const logo = await loadPrintImage(`${import.meta.env.BASE_URL}${HALO_LOGO_SRC}`)
        context.drawImage(
          logo,
          (frame.leftMm + logoExport.xMm) / 25.4 * dpi,
          (frame.topMm + logoExport.yMm) / 25.4 * dpi,
          HALO_LOGO_W_MM / 25.4 * dpi,
          HALO_LOGO_H_MM / 25.4 * dpi,
        )
      } catch {
        // Без логотипа друк все одно відбувається — знак необовʼязковий.
      }
      // Шапка: той самий SVG з task_code і та сама позиція (мм кадру), що в превʼю.
      if (taskCode) {
        const headerExport = headerPos ?? defaultHeaderPos(frame)
        try {
          const headerDataUrl = await buildHeaderDataUrl(taskCode)
          const headerImage = await loadPrintImage(headerDataUrl)
          context.drawImage(
            headerImage,
            (frame.leftMm + headerExport.xMm) / 25.4 * dpi,
            (frame.topMm + headerExport.yMm) / 25.4 * dpi,
            HEADER_W_MM / 25.4 * dpi,
            HEADER_H_MM / 25.4 * dpi,
          )
        } catch {
          // Без шапки друк все одно відбувається — елемент необовʼязковий.
        }
      }
      const legendBoxExport = legendLayout(frame, legendBox, legend.evidence.length, legend.topo.length, legend.task.length)
      const legendEvidence = legend.evidence.slice(0, legendBoxExport.evRows)
      const legendTask = legend.task.slice(0, legendBoxExport.taskRows)
      const legendTopo = legend.topo.slice(0, legendBoxExport.topoRows)
      const legendOverflow = legendBoxExport.overflow
      const hasLegendRows = legendEvidence.length > 0 || legendTask.length > 0 || legendTopo.length > 0
      const legendWmm = hasLegendRows ? legendBoxExport.wMm : 38
      const legendHmm = hasLegendRows ? legendBoxExport.hMm : 28
      const legendX = (frame.leftMm + legendBoxExport.xMm) / 25.4 * dpi
      const legendY = (frame.topMm + legendBoxExport.yMm) / 25.4 * dpi
      context.fillStyle = '#ffffffed'
      context.fillRect(legendX, legendY, legendWmm / 25.4 * dpi, legendHmm / 25.4 * dpi)
      context.strokeStyle = '#71808a'
      context.lineWidth = 1
      context.strokeRect(legendX, legendY, legendWmm / 25.4 * dpi, legendHmm / 25.4 * dpi)
      context.fillStyle = '#34495a'
      context.textAlign = 'left'
      context.font = `${Math.round(2.1 * dpi / 25.4)}px Arial, sans-serif`
      // Перенос підпису максимум у 2 рядки в межах ширини блока.
      const wrapLegendLabel = (text: string, maxWidthPx: number): string[] => {
        const words = text.split(/\s+/).filter(Boolean)
        const lines: string[] = []
        let line = ''
        let truncated = false
        for (const word of words) {
          const trial = line ? `${line} ${word}` : word
          if (context.measureText(trial).width <= maxWidthPx || line === '') {
            line = trial
          } else if (lines.length === 0) {
            lines.push(line)
            line = word
          } else {
            truncated = true
            break
          }
        }
        if (line) {
          if (lines.length >= 2) truncated = true
          else lines.push(line)
        }
        if (truncated && lines.length) {
          let last = lines[lines.length - 1]
          while (last.length > 1 && context.measureText(`${last}…`).width > maxWidthPx) {
            last = last.slice(0, -1)
          }
          lines[lines.length - 1] = `${last}…`
        }
        return lines.length ? lines : ['']
      }
      const drawLabelLines = (label: string, x: number, rowTop: number) => {
        const lines = wrapLegendLabel(label, (legendWmm - 10) / 25.4 * dpi)
        context.fillStyle = '#34495a'
        // Рядок 6мм, патч 4.5мм по центру (центр 3мм): текст центруємо так само.
        if (lines.length === 1) {
          context.fillText(lines[0], x, rowTop + 3.7 / 25.4 * dpi)
        } else {
          context.fillText(lines[0], x, rowTop + 2.4 / 25.4 * dpi)
          context.fillText(lines[1], x, rowTop + 5.1 / 25.4 * dpi)
        }
      }
      const drawPatch = async (imageSrc: string | null, x: number, y: number, size: number) => {
        if (imageSrc) {
          try {
            const icon = await loadPrintImage(imageSrc)
            // Contain: пропорції знака зберігаються, як на карті.
            const naturalW = icon.naturalWidth || size
            const naturalH = icon.naturalHeight || size
            const fit = Math.min(size / naturalW, size / naturalH)
            const drawW = naturalW * fit
            const drawH = naturalH * fit
            context.drawImage(icon, x + (size - drawW) / 2, y + (size - drawH) / 2, drawW, drawH)
            return
          } catch {
            /* нижче сірий квадрат */
          }
        }
        context.fillStyle = '#9aa5ad'
        context.fillRect(x, y, size, size)
        context.fillStyle = '#34495a'
      }
      if (!hasLegendRows) {
        context.fillText('У кадрі немає об’єктів', legendX + 2 / 25.4 * dpi, legendY + 11 / 25.4 * dpi)
        context.fillText('evidence · завдання · топо', legendX + 2 / 25.4 * dpi, legendY + 16 / 25.4 * dpi)
      } else {
        let cursorMm = 2
        for (const row of legendEvidence) {
          const rowTop = legendY + cursorMm / 25.4 * dpi
          await drawPatch(row.svgUrl, legendX + 2 / 25.4 * dpi, rowTop + 0.75 / 25.4 * dpi, 4.5 / 25.4 * dpi)
          drawLabelLines(row.descr || row.name, legendX + 8 / 25.4 * dpi, rowTop)
          cursorMm += 6
        }
        for (const row of legendTask) {
          const rowTop = legendY + cursorMm / 25.4 * dpi
          await drawPatch(row.patchUrl, legendX + 2 / 25.4 * dpi, rowTop + 0.75 / 25.4 * dpi, 4.5 / 25.4 * dpi)
          drawLabelLines(row.label, legendX + 8 / 25.4 * dpi, rowTop)
          cursorMm += 6
        }
        for (const row of legendTopo) {
          const rowTop = legendY + cursorMm / 25.4 * dpi
          await drawPatch(row.patchUrl, legendX + 2 / 25.4 * dpi, rowTop + 0.75 / 25.4 * dpi, 4.5 / 25.4 * dpi)
          drawLabelLines(row.name, legendX + 8 / 25.4 * dpi, rowTop)
          cursorMm += 6
        }
        if (legendOverflow > 0) {
          context.fillText(
            `+${legendOverflow} записів`,
            legendX + 2 / 25.4 * dpi,
            legendY + cursorMm / 25.4 * dpi,
          )
        }
      }
      // Масштабний штамп: той самий SVG і та сама позиція (мм кадру), що в превʼю.
      const scaleExport = scalePos ?? defaultScaleBarPos(frame, scaleSpec)
      const scaleImage = await loadPrintImage(scaleBarDataUrl(scaleSpec))
      context.drawImage(
        scaleImage,
        (frame.leftMm + scaleExport.xMm) / 25.4 * dpi,
        (frame.topMm + scaleExport.yMm) / 25.4 * dpi,
        scaleSpec.blockWMm / 25.4 * dpi,
        scaleSpec.blockHMm / 25.4 * dpi,
      )
      // Кутовий штамп: свіжі рядки під фільтром; висота блока — за кількістю рядків.
      const stampTableExport = await getStampTable(
        current.editView,
        {
          task: current.layers.task,
          taskGeopoint: current.layers.taskGeopoint,
          taskPolygon: current.layers.taskPolygon,
          polygonGeopoint: current.layers.polygonGeopoint,
        },
        taskCode,
      )
      const stampExportH = stampBlockHeightMm(
        stampTableExport.rows.length + (stampTableExport.overflow > 0 ? 1 : 0),
      )
      const stampExport = stampPos ?? defaultStampPos(frame, stampExportH)
      const stampImage = await loadPrintImage(
        stampDataUrl(stampTableExport.rows, stampTableExport.overflow),
      )
      context.drawImage(
        stampImage,
        (frame.leftMm + stampExport.xMm) / 25.4 * dpi,
        (frame.topMm + stampExport.yMm) / 25.4 * dpi,
        STAMP_W_MM / 25.4 * dpi,
        stampExportH / 25.4 * dpi,
      )
      // Привʼязка до системи координат — всередині кадру внизу ліворуч (як у превʼю).
      context.textAlign = 'left'
      context.font = `${Math.round(2.2 * dpi / 25.4)}px Arial, sans-serif`
      context.fillStyle = '#344054'
      context.save()
      context.shadowColor = '#ffffff'
      context.shadowBlur = Math.round(1 * dpi / 25.4)
      context.fillText(
        coordLabel,
        (frame.leftMm + 1) / 25.4 * dpi,
        (frame.topMm + frame.heightMm - 1) / 25.4 * dpi,
      )
      context.restore()
      const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не вдалося сформувати JPEG.')), 'image/jpeg', 0.94))
      const url = URL.createObjectURL(jpeg)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `sketch-map-${taskCode}-1-${scale}-EPSG${zoneWkid}.jpg`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setNotice({ kind: 'error', message: describeError(error, 'Не вдалося експортувати карту.') })
    } finally {
      setExporting(false)
    }
  }

  async function handleSignIn() {
    setSigningIn(true)
    try {
      const { signInToPortal } = await import('./arcgis/auth')
      const user = await signInToPortal()
      setUserName(user?.username ?? null)
    } catch (error) {
      setNotice({ kind: 'error', message: describeError(error, 'Не вдалося ввійти через ArcGIS Portal.') })
    } finally {
      setSigningIn(false)
    }
  }

  const editSession = sessionReady ? sessionRef.current : null
  const evidenceLayer = editSession?.layers.evidence
  // Прапорець графік шевронів ЛЕП у view.graphics (бейджі evidence — без прапорця).
  const POWERLINE_FLAG = '__powerline'

  /**
   * Шеврони ЛЕП біля вершин для ОДНІЄЇ вʼю: точки — земля (вершина ± screen-відстань
   * уздовж сегмента), кути — екран (азимут, 0 — північ). Тому привʼязка точна
   * в будь-якій СК і масштабі, а цифра прямо незалежно від повороту знака.
   */
  const rebuildPowerlineArrowsForView = useCallback(async (view: MapView, code: string) => {
    try {
      for (const graphic of [...view.graphics.toArray()]) {
        const flagged = (graphic.attributes as Record<string, unknown> | null)?.[POWERLINE_FLAG]
        if (flagged) {
          try {
            view.graphics.remove(graphic)
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (!view || !code) return
      const session = sessionRef.current
      const topo = session?.layers.topoLines
      if (!topo) return
      const library = await loadEvidenceLibrary()
      const entries = library.symbols.filter(
        (s) => (s.geometry ?? 'point') === 'line'
          && (s.layers ?? []).includes('topoLines')
          && !!s.pattern?.pairedArrows,
      )
      if (!entries.length) return
      const inList = entries.map((entry) => `'${entry.code.replaceAll("'", "''")}'`).join(',')
      // Просторовий запит — у рідній СК шару: геометрію чужої СК (UTM друку)
      // сервіс може не прийняти, а без неї запит необмежений.
      const { projectExtent } = await import('./arcgis/utm')
      const layerWkid = topo.spatialReference?.wkid
      const queryGeometry = layerWkid && view.extent
        ? await projectExtent(view.extent, layerWkid).catch(() => view.extent)
        : view.extent
      const result = await topo.queryFeatures({
        where: `${EVIDENCE_SYMBOL_FIELD} IN (${inList})`,
        geometry: queryGeometry,
        outFields: [EVIDENCE_SYMBOL_FIELD],
        returnGeometry: true,
        num: 200,
      }).catch(() => null)
      const features = result?.features ?? []
      if (!features.length) return
      const [{ default: PointImpl }, { default: PictureMarkerSymbol }, { default: GraphicImpl }, operators] = await Promise.all([
        import('@arcgis/core/geometry/Point.js'),
        import('@arcgis/core/symbols/PictureMarkerSymbol.js'),
        import('@arcgis/core/Graphic.js'),
        import('@arcgis/core/geometry/operators/projectOperator.js'),
      ])
      if (!operators.isLoaded()) await operators.load()
      const viewSR = view.spatialReference
      const layerSR = topo.spatialReference ?? viewSR
      const chevUrl = `${import.meta.env.BASE_URL}symbols/topo/power_chevron.svg`
      const budget = 600
      let placed = 0
      const graphics: Graphic[] = []
      for (const feature of features) {
        const attrs = feature.attributes as Record<string, unknown>
        const entry = entries.find((candidate) => candidate.code === attrs[EVIDENCE_SYMBOL_FIELD])
        const spec = entry?.pattern?.pairedArrows
        if (!spec) continue
        const size = spec.size && spec.size > 0 ? spec.size : 5
        const distPx = spec.distance && spec.distance > 0 ? spec.distance : 14
        const gapPx = spec.gap && spec.gap > 0 ? spec.gap : 7
        const geometry = feature.geometry as unknown as { paths?: number[][][] } | null
        const paths = geometry?.paths ?? []
        for (const path of paths) {
          for (let index = 0; index < path.length; index++) {
            const vertex = path[index]
            if (!vertex || vertex.length < 2) continue
            const neighbors: number[][] = []
            if (index > 0 && path[index - 1]?.length >= 2) neighbors.push(path[index - 1])
            if (index < path.length - 1 && path[index + 1]?.length >= 2) neighbors.push(path[index + 1])
            for (const neighbor of neighbors) {
              if (placed >= budget) break
              let projectedV: { x: number; y: number }
              let projectedN: { x: number; y: number }
              try {
                projectedV = operators.execute(
                  new PointImpl({ x: vertex[0], y: vertex[1], spatialReference: layerSR }),
                  viewSR,
                ) as { x: number; y: number }
                projectedN = operators.execute(
                  new PointImpl({ x: neighbor[0], y: neighbor[1], spatialReference: layerSR }),
                  viewSR,
                ) as { x: number; y: number }
              } catch {
                continue
              }
              const screenV = view.toScreen(
                new PointImpl({ x: projectedV.x, y: projectedV.y, spatialReference: viewSR }),
              )
              const screenN = view.toScreen(
                new PointImpl({ x: projectedN.x, y: projectedN.y, spatialReference: viewSR }),
              )
              if (!screenV || !screenN) continue
              const dx = screenN.x - screenV.x
              const dy = screenN.y - screenV.y
              const length = Math.hypot(dx, dy)
              if (!(length > 0)) continue
              const ux = dx / length
              const uy = dy / length
              // Азимут напряму (0 — північ, за годинниковою); знак дивиться на північ.
              const azimuth = (Math.atan2(ux, -uy) * 180) / Math.PI
              for (const step of [distPx, distPx + gapPx]) {
                if (placed >= budget) break
                let mapPoint: Point | null = null
                try {
                  mapPoint = view.toMap({ x: screenV.x + ux * step, y: screenV.y + uy * step })
                } catch {
                  continue
                }
                if (!mapPoint) continue
                graphics.push(
                  new GraphicImpl({
                    geometry: mapPoint,
                    attributes: { [POWERLINE_FLAG]: 1 },
                    symbol: new PictureMarkerSymbol({
                      url: chevUrl,
                      angle: azimuth,
                      width: size,
                      height: size,
                    }),
                  }),
                )
                placed += 1
              }
            }
          }
        }
      }
      if (graphics.length) {
        try {
          view.graphics.addMany(graphics)
        } catch {
          /* вʼю знищено */
        }
      }
    } catch {
      /* шеврони необовʼязкові — лінія і крапки працюють без них */
    }
  }, [])

  /** Шеврони в усіх вʼю (дані/таска). Навігація — окремо по вʼю (зупинка карти). */
  const rebuildPowerlineArrows = useCallback(async (code: string) => {
    const session = sessionRef.current
    if (!session) return
    const views = [session.editView, session.printView, ...Object.values(insetViewsRef.current)]
      .filter((view): view is MapView => !!view)
    await Promise.all(views.map((view) => rebuildPowerlineArrowsForView(view, code)))
  }, [rebuildPowerlineArrowsForView])
  useEffect(() => {
    rebuildPowerlineArrowsRef.current = rebuildPowerlineArrows
    rebuildPowerlineArrowsForViewRef.current = rebuildPowerlineArrowsForView
  })
  // ТИМЧАСОВО false: порівнюємо штатне створення Editor з власним TemplatePicker.
  const SHOW_TEMPLATE_PICKER = false
  const editMapView = editSession?.editView
  const legendLayoutBox = legendLayout(frame, legendBox, legend.evidence.length, legend.topo.length, legend.task.length)
  const northEff = northPos ?? defaultNorthPos(frame)
  const logoEff = logoPos ?? defaultLogoPos()
  const headerEff = headerPos ?? defaultHeaderPos(frame)
  const scaleEff = scalePos ?? defaultScaleBarPos(frame, scaleSpec)
  // Висота штампа — за кількістю рядків; без даних — fallback як у референсі.
  const stampHMm = stampBlockHeightMm(
    stampTable
      ? stampTable.rows.length + (stampTable.overflow > 0 ? 1 : 0)
      : STAMP_FALLBACK_ROWS,
  )
  const stampUrl = stampTable
    ? stampDataUrl(stampTable.rows, stampTable.overflow)
    : null
  const stampEff = stampPos ?? defaultStampPos(frame, stampHMm)
  const coordLabel = `Система координат WGS84 UTM Zone ${zoneWkid - 32600}N`

  // SVG шапки з актуальним task_code для превʼю; старий скидається в applyTask.
  useEffect(() => {
    let alive = true
    if (!taskCode) return
    void buildHeaderDataUrl(taskCode)
      .then((url) => { if (alive) setHeaderUrl(url) })
      .catch(() => { if (alive) setHeaderUrl(null) })
    return () => { alive = false }
  }, [taskCode])

  // Рядки штампа LM/BM/SP: читаємо точки під фільтром завдання
  // і SP каскадом через task polygon; стежимо за фільтром LayerView,
  // щоб не змагатися з applyTask.
  useEffect(() => {
    const session = sessionRef.current
    const view = session?.editView
    if (!sessionReady || !session || !view) return
    const layers = {
      task: session.layers.task,
      taskGeopoint: session.layers.taskGeopoint,
      taskPolygon: session.layers.taskPolygon,
      polygonGeopoint: session.layers.polygonGeopoint,
    }
    if (!layers.taskGeopoint) return
    let alive = true
    let timer: number | undefined
    let watchHandle: { remove(): void } | undefined
    const reload = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void (async () => {
          if (!taskCode) {
            if (alive) setStampTable(null)
            return
          }
          const table = await getStampTable(view, layers, taskCode)
          if (!alive) return
          if (table.warnings.length) {
            setNotice({ kind: 'info', message: table.warnings.join(' ') })
          }
          setStampTable(table)
        })().catch((error: unknown) => {
          if (alive) setNotice({ kind: 'error', message: describeError(error, 'Не вдалося завантажити координати штампа.') })
        })
      }, 350)
    }
    reload()
    void view.whenLayerView(layers.taskGeopoint).then((layerView) => {
      if (!alive) return
      watchHandle = reactiveUtils.watch(
        () => (layerView as unknown as { filter?: { where?: string } | null }).filter?.where ?? '',
        () => reload(),
      )
    })
    return () => {
      alive = false
      window.clearTimeout(timer)
      watchHandle?.remove()
    }
  }, [sessionReady, taskCode])

  function changeOrientation(next: Orientation) {
    setOrientation(next)
    setLegendBox(null)
    setNorthPos(null)
    setLogoPos(null)
    setHeaderPos(null)
    setScalePos(null)
    setStampPos(null)
    setInsetPos({ lm: null, bm: null })
    setInsetSize({ lm: null, bm: null })
  }

  // Довільний масштаб з поля вводу (напр. 3500): ціле число в межах MIN..MAX.
  function applyCustomScale(raw: string) {
    const value = Math.round(Number(raw.replace(/[\s_]/g, '').replace(',', '.')))
    if (!Number.isFinite(value) || value < CUSTOM_SCALE_MIN || value > CUSTOM_SCALE_MAX) {
      setNotice({ kind: 'error', message: `Масштаб має бути цілим числом від ${CUSTOM_SCALE_MIN} до ${CUSTOM_SCALE_MAX.toLocaleString('uk-UA')}.` })
      setScaleDraft('')
      return
    }
    setScale(value)
    setScaleDraft('')
  }

  // Відкрили «Інший масштаб» — одразу фокус у поле вводу.
  useEffect(() => {
    if (customOpen) customInputRef.current?.focus()
  }, [customOpen])

  // Перетягування легенди: лівий/верхній край — рух, правий — ширина, нижній — висота.
  function legendEdgeDown(mode: 'move' | 'sizeW' | 'sizeH' | 'sizeWH', event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const card = legendCardRef.current
    if (!card) return
    const printFrame = frameRef.current
    const mmPerPx = legendLayoutBox.wMm / Math.max(1, card.clientWidth)
    const origHmm = legendLayoutBox.hMm
    legendDragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      orig: { xMm: legendLayoutBox.xMm, yMm: legendLayoutBox.yMm, wMm: legendLayoutBox.wMm, hMm: origHmm },
    }
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const drag = legendDragRef.current
      if (!drag) return
      const dxMm = (moveEvent.clientX - drag.startX) * mmPerPx
      const dyMm = (moveEvent.clientY - drag.startY) * mmPerPx
      const next = { ...drag.orig }
      if (drag.mode === 'move') {
        next.xMm = Math.min(Math.max(0, drag.orig.xMm + dxMm), Math.max(0, printFrame.widthMm - next.wMm))
        next.yMm = Math.min(Math.max(0, drag.orig.yMm + dyMm), Math.max(0, printFrame.heightMm - next.hMm))
      } else if (drag.mode === 'sizeW') {
        next.wMm = Math.min(Math.max(30, drag.orig.wMm + dxMm), printFrame.widthMm - next.xMm)
      } else if (drag.mode === 'sizeH') {
        next.hMm = Math.min(Math.max(15, drag.orig.hMm + dyMm), printFrame.heightMm - next.yMm)
      } else {
        next.wMm = Math.min(Math.max(30, drag.orig.wMm + dxMm), printFrame.widthMm - next.xMm)
        next.hMm = Math.min(Math.max(15, drag.orig.hMm + dyMm), printFrame.heightMm - next.yMm)
      }
      setLegendBox(next)
    }
    const onUp = () => {
      legendDragRef.current = null
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Перетягування стрілки півночі в межах кадру (мм кадру — ті самі, що в JPEG).
  function northDragDown(event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const node = frameNodeRef.current
    if (!node) return
    const printFrame = frameRef.current
    const mmPerPx = printFrame.widthMm / Math.max(1, node.clientWidth)
    const orig = northEff
    const startX = event.clientX
    const startY = event.clientY
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const dxMm = (moveEvent.clientX - startX) * mmPerPx
      const dyMm = (moveEvent.clientY - startY) * mmPerPx
      setNorthPos({
        xMm: Math.min(Math.max(0, orig.xMm + dxMm), Math.max(0, printFrame.widthMm - NORTH_ARROW_W_MM)),
        yMm: Math.min(Math.max(0, orig.yMm + dyMm), Math.max(0, printFrame.heightMm - NORTH_ARROW_H_MM)),
      })
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Перетягування інсет-карт поверх кадру (мм кадру — ті самі, що в JPEG).
  // Слухаємо pointerdown у CAPTURE-фазі рамки і ріжемо спливання: Esri слухає
  // pointerdown на внутрішньому контейнері, і звичайний onMouseDown-бульбашка
  // приходить уже після старту панорамування — тому бокс «не їхав».
  // Приймає і mouse-, і pointer-події (ручка-хваталка кидає mousedown).
  function insetDragDown(id: string, event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }) {
    event.preventDefault()
    event.stopPropagation()
    const node = frameNodeRef.current
    if (!node) return
    const printFrame = frameRef.current
    const mmPerPx = printFrame.widthMm / Math.max(1, node.clientWidth)
    const orig = insetPos[id] ?? defaultPosFor(frame, insets, id)
    const size = insetSize[id] ?? { wMm: INSET_W_MM, hMm: INSET_H_MM }
    const startX = event.clientX
    const startY = event.clientY
    document.body.style.userSelect = 'none'
    // Рух/відпускання — pointer-подіями: preventDefault на pointerdown гасить
    // сумісні mouse-події, тож mousemove/mouseup сюди б не прийшли.
    const onMove = (moveEvent: PointerEvent) => {
      const dxMm = (moveEvent.clientX - startX) * mmPerPx
      const dyMm = (moveEvent.clientY - startY) * mmPerPx
      const next = {
        xMm: Math.min(Math.max(0, orig.xMm + dxMm), Math.max(0, printFrame.widthMm - size.wMm)),
        yMm: Math.min(Math.max(0, orig.yMm + dyMm), Math.max(0, printFrame.heightMm - size.hMm)),
      }
      setInsetPos((prev) => ({ ...prev, [id]: next }))
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Зміна розміру інсета за правий нижній кут (як кут легенди): ручка — сусід
  // Esri-контейнера, тож події до карти не доходять; звичайні mouse-події.
  function insetCornerDown(id: string, event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const node = frameNodeRef.current
    if (!node) return
    const printFrame = frameRef.current
    const mmPerPx = printFrame.widthMm / Math.max(1, node.clientWidth)
    const pos0 = insetPos[id] ?? defaultPosFor(frame, insets, id)
    const size0 = insetSize[id] ?? { wMm: INSET_W_MM, hMm: INSET_H_MM }
    const startX = event.clientX
    const startY = event.clientY
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const dxMm = (moveEvent.clientX - startX) * mmPerPx
      const dyMm = (moveEvent.clientY - startY) * mmPerPx
      const next = {
        wMm: Math.min(Math.max(INSET_MIN_MM, size0.wMm + dxMm), Math.max(INSET_MIN_MM, printFrame.widthMm - pos0.xMm)),
        hMm: Math.min(Math.max(INSET_MIN_MM, size0.hMm + dyMm), Math.max(INSET_MIN_MM, printFrame.heightMm - pos0.yMm)),
      }
      setInsetSize((prev) => ({ ...prev, [id]: next }))
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Перетягування логотипа в межах кадру (мм кадру — ті самі, що в JPEG).
  function logoDragDown(event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const node = frameNodeRef.current
    if (!node) return
    const printFrame = frameRef.current
    const mmPerPx = printFrame.widthMm / Math.max(1, node.clientWidth)
    const orig = logoEff
    const startX = event.clientX
    const startY = event.clientY
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const dxMm = (moveEvent.clientX - startX) * mmPerPx
      const dyMm = (moveEvent.clientY - startY) * mmPerPx
      setLogoPos({
        xMm: Math.min(Math.max(0, orig.xMm + dxMm), Math.max(0, printFrame.widthMm - HALO_LOGO_W_MM)),
        yMm: Math.min(Math.max(0, orig.yMm + dyMm), Math.max(0, printFrame.heightMm - HALO_LOGO_H_MM)),
      })
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Перетягування шапки в межах кадру (мм кадру — ті самі, що в JPEG).
  function headerDragDown(event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const node = frameNodeRef.current
    if (!node) return
    const printFrame = frameRef.current
    const mmPerPx = printFrame.widthMm / Math.max(1, node.clientWidth)
    const orig = headerEff
    const startX = event.clientX
    const startY = event.clientY
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const dxMm = (moveEvent.clientX - startX) * mmPerPx
      const dyMm = (moveEvent.clientY - startY) * mmPerPx
      setHeaderPos({
        xMm: Math.min(Math.max(0, orig.xMm + dxMm), Math.max(0, printFrame.widthMm - HEADER_W_MM)),
        yMm: Math.min(Math.max(0, orig.yMm + dyMm), Math.max(0, printFrame.heightMm - HEADER_H_MM)),
      })
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Перетягування масштабного штампа в межах кадру (мм кадру — ті самі, що в JPEG).
  function scaleDragDown(event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const node = frameNodeRef.current
    if (!node) return
    const printFrame = frameRef.current
    const mmPerPx = printFrame.widthMm / Math.max(1, node.clientWidth)
    const orig = scaleEff
    const spec = scaleSpec
    const startX = event.clientX
    const startY = event.clientY
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const dxMm = (moveEvent.clientX - startX) * mmPerPx
      const dyMm = (moveEvent.clientY - startY) * mmPerPx
      setScalePos({
        xMm: Math.min(Math.max(0, orig.xMm + dxMm), Math.max(0, printFrame.widthMm - spec.blockWMm)),
        yMm: Math.min(Math.max(0, orig.yMm + dyMm), Math.max(0, printFrame.heightMm - spec.blockHMm)),
      })
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Перетягування кутового штампа в межах кадру (мм кадру — ті самі, що в JPEG).
  function stampDragDown(event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    const node = frameNodeRef.current
    if (!node) return
    const printFrame = frameRef.current
    const mmPerPx = printFrame.widthMm / Math.max(1, node.clientWidth)
    const orig = stampEff
    const startX = event.clientX
    const startY = event.clientY
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const dxMm = (moveEvent.clientX - startX) * mmPerPx
      const dyMm = (moveEvent.clientY - startY) * mmPerPx
      setStampPos({
        xMm: Math.min(Math.max(0, orig.xMm + dxMm), Math.max(0, printFrame.widthMm - STAMP_W_MM)),
        yMm: Math.min(Math.max(0, orig.yMm + dyMm), Math.max(0, printFrame.heightMm - stampHMm)),
      })
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!userName) {
    return <main className="auth-screen">
      <div className="auth-card">
        <div className="brand-mark">N</div>
        <p className="eyebrow">GEOSPATIAL WORKSPACE</p>
        <h1>Sketch map</h1>
        <p className="auth-copy">Увійдіть через організаційний ArcGIS Portal, щоб працювати з завданнями та готувати карти до друку.</p>
        {notice && <div className="notice notice-error">{notice.message}</div>}
        <button className="button button-primary auth-button" onClick={handleSignIn} disabled={busy || signingIn}>
          {busy || signingIn ? <span className="spinner" /> : <PortalGlyph />}
          {busy ? 'Перевірка сесії…' : signingIn ? 'Переходимо до Portal…' : 'Увійти через ArcGIS Portal'}
        </button>
        <span className="auth-host">{PORTAL_URL}</span>
      </div>
      <div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" />
    </main>
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark small">N</div><div><strong>Sketch map</strong><span>Картографічна майстерня</span></div></div>
        <div className="topbar-right"><span className="portal-status"><i /> ArcGIS Portal</span><span className="user-chip"><span className="avatar">{userName.slice(0, 1).toUpperCase()}</span>{userName}</span><button className="icon-button" title="Вийти" onClick={() => void import('./arcgis/auth').then(({ signOutFromPortal }) => signOutFromPortal())}><LogoutGlyph /></button></div>
      </header>

      <nav className="tabbar" aria-label="Робочі режими">
        <button className={tab === 'edit' ? 'tab active' : 'tab'} onClick={() => setTab('edit')}><EditGlyph />Редагування <span className="tab-index">01</span></button>
        <button className={tab === 'print' ? 'tab active' : 'tab'} onClick={() => setTab('print')}><PrintGlyph />Макет друку <span className="tab-index">02</span></button>
        <div className="tabbar-meta"><span className="live-dot" />{taskCode ? `Завдання ${taskCode}` : 'Оберіть завдання для початку'}</div>
      </nav>

      <section className={`work-area ${tab === 'edit' ? 'mode-edit' : 'mode-print'}`}>
        <aside className="side-panel">
          <div className={`panel-block ${tab === 'edit' ? '' : 'block-hidden'}`}>
            <TaskSearch
              codes={taskCodes}
              value={taskCode}
              disabled={!sessionReady}
              onSelect={(code) => void applyTask(code)}
            />
            <button
              className="button button-secondary symbols-reload"
              onClick={() => void reloadSymbols()}
              disabled={!sessionReady || symbolsBusy}
              title="Перечитати library.json і SVG-файли, перебудувати знаки без перезавантаження вкладки"
            >
              {symbolsBusy ? <span className="spinner" /> : '↻'} Оновити знаки
            </button>
            {/* ТИМЧАСОВО приховано для порівняння зі штатним створенням Editor.
                Щоб повернути: SHOW_TEMPLATE_PICKER → true (і addEnabled: false в mapSession). */}
            {editSession && SHOW_TEMPLATE_PICKER && (
              <TemplatePicker
                view={editSession.editView}
                layers={editSession.layers}
                library={editSession.library}
                editor={editSession.editor}
                suspended={tab !== 'edit'}
                onError={(message) => setNotice({ kind: 'error', message })}
              />
            )}
            <div className="editor-host" ref={editorRef} />
          </div>
          <div className={`panel-block ${tab === 'print' ? '' : 'block-hidden'}`}>
            <div className="panel-heading"><div><span className="panel-kicker">LAYOUT STUDIO</span><h2>Параметри аркуша</h2></div><span className="icon-tile"><PrintGlyph /></span></div>
            <div className="control-group"><label>ОРІЄНТАЦІЯ</label><div className="segmented"><button className={orientation === 'portrait' ? 'selected' : ''} onClick={() => changeOrientation('portrait')}><PortraitGlyph />Портрет</button><button className={orientation === 'landscape' ? 'selected' : ''} onClick={() => changeOrientation('landscape')}><LandscapeGlyph />Альбом</button></div></div>
            <div className="control-group"><label>МАСШТАБ ОСНОВНОЇ КАРТИ</label><select value={PRINT_SCALES.includes(scale) ? scale : 'custom'} onChange={(event) => { const raw = event.target.value; if (raw === 'custom') { setCustomOpen(true); setScaleDraft('') } else { setScale(Number(raw)); setScaleDraft(''); setCustomOpen(false) } }}>{PRINT_SCALES.map((item) => <option key={item} value={item}>1:{item.toLocaleString('uk-UA')}</option>)}<option value="custom">{PRINT_SCALES.includes(scale) ? 'Інший масштаб…' : `Інший масштаб (1:${scale.toLocaleString('uk-UA')})`}</option></select>{(customOpen || !PRINT_SCALES.includes(scale)) && <div className="scale-custom-row"><input ref={customInputRef} value={scaleDraft} onChange={(event) => setScaleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyCustomScale(scaleDraft); if (event.key === 'Escape') { setScaleDraft(''); if (PRINT_SCALES.includes(scale)) setCustomOpen(false) } }} placeholder="Власний, напр. 3500" inputMode="numeric" aria-label="Власний масштаб" /><button onClick={() => applyCustomScale(scaleDraft)} title="Застосувати власний масштаб" aria-label="Застосувати власний масштаб">→</button></div>}</div>
            <button className={`grid-toggle${gridVisible ? ' on' : ''}`} onClick={() => setGridVisible((visible) => !visible)} aria-pressed={gridVisible} title="Увімкнути або вимкнути UTM-сітку на листі"><span className="grid-preview"><i/><i/><i/></span><div><strong>UTM-сітка {gridVisible ? 'увімкнена' : 'вимкнена'}</strong><small>1 мм · координати кожні 10 мм</small></div></button>
            <button className={`grid-toggle${insetMove ? ' on' : ''}`} onClick={() => setInsetMove((value) => !value)} aria-pressed={insetMove} title="Розблокувати переміщення карт LM/BM по аркушу (панорамування всередині при цьому вимкнено)"><span className="move-mark"><MoveGlyph /></span><div><strong>Переміщення інсетів {insetMove ? 'увімкнено' : 'вимкнено'}</strong><small>{insetMove ? 'Тягніть карти по аркушу' : 'Тягніть вміст усередині карт'}</small></div></button>
            <div className="control-group"><label>КАРТА LM</label><select value={insetScales.lm} onChange={(event) => setInsetScales((prev) => ({ ...prev, lm: Number(event.target.value) }))} aria-label="Масштаб карти LM">{PRINT_SCALES.map((item) => <option key={item} value={item}>1:{item.toLocaleString('uk-UA')}</option>)}</select></div>
            <div className="control-group"><label>МАСШТАБ BM-КАРТ</label><select value={insetScales.bm} onChange={(event) => setInsetScales((prev) => ({ ...prev, bm: Number(event.target.value) }))} aria-label="Спільний масштаб BM-карт">{PRINT_SCALES.map((item) => <option key={item} value={item}>1:{item.toLocaleString('uk-UA')}</option>)}</select><small>Один на всі карти BM</small></div>
            <div className="control-group"><label>ПОКАЗУВАТИ НА АРКУШІ BM</label>{insets.some((def) => def.kind === 'bm') ? <div className="inset-checks">{insets.filter((def) => def.kind === 'bm').map((def) => (<label className="inset-check" key={def.id}><input type="checkbox" checked={insetEnabled[def.id] !== false} onChange={() => toggleInset(def.id)} /><span>{def.label}</span></label>))}</div> : <small>{taskCode ? 'BM-точок у завданні нема' : 'Оберіть завдання'}</small>}</div>
            <button className="button button-primary export-button" onClick={() => void exportJpeg()} disabled={!sessionReady || !taskCode || exporting}>{exporting ? <span className="spinner"/> : <DownloadGlyph/>}{exporting ? 'Формування JPEG…' : 'Експортувати в JPEG'}</button>
          </div>
        </aside>

        <div className="map-stage">
          {busy && <div className="loading-overlay"><span className="spinner dark"/><strong>Завантаження карти</strong><small>{busyStep}</small></div>}
          {!busy && !sessionReady && <div className="loading-overlay"><span className="error-mark">!</span><strong>Не вдалося відкрити WebMap</strong><small>Перевірте доступ до карти та підключення до Portal.</small><button className="button button-secondary" onClick={() => window.location.reload()}>Повторити</button></div>}
          {notice && <div className={`toast toast-${notice.kind}`} role="status"><span className="toast-mark">{notice.kind === 'error' ? '!' : 'i'}</span><span className="toast-text">{notice.message}</span><button aria-label="Закрити повідомлення" onClick={() => setNotice(null)}>×</button></div>}
          <div className={`map-pane edit-map ${tab === 'edit' ? 'pane-visible' : ''}`}>
            <div className="edit-map-body"><div className="map-canvas" ref={editMapRef}/><div className="map-attribution">© ArcGIS · джерела карти</div></div>
            {evidenceLayer && editMapView && (
              <EvidenceTable
                view={editMapView}
                layer={evidenceLayer}
                taskCode={taskCode}
                onSaved={() => {
                  setEvidenceRev((rev) => rev + 1)
                  void rebuildEvidenceBadges(taskCode)
                }}
              />
            )}
          </div>
          <div className={`map-pane print-map ${tab === 'print' ? 'pane-visible' : ''}`}>
            <div ref={paperWrapRef} className={`paper-wrap ${orientation}`}>
              <div ref={pageRef} className={`print-page ${orientation}`} style={{ aspectRatio: `${page.widthMm} / ${page.heightMm}`, width: paperPx.w || undefined, height: paperPx.h || undefined }}>
                <div className="print-map-frame" ref={frameNodeRef} style={frameStyle}><div className="map-canvas" ref={printMapRef}/><img
  src={`${import.meta.env.BASE_URL}${NORTH_ARROW_SRC}`}
  alt="Північ"
  className="north-arrow-img"
  draggable={false}
  style={{
    left: `${(northEff.xMm / frame.widthMm) * 100}%`,
    top: `${(northEff.yMm / frame.heightMm) * 100}%`,
    height: `${(NORTH_ARROW_H_MM / frame.heightMm) * 100}%`,
  }}
  onMouseDown={northDragDown}
  title="Тягнути — перемістити стрілку півночі"
/><img
  src={`${import.meta.env.BASE_URL}${HALO_LOGO_SRC}`}
  alt="HALO"
  className="halo-logo-img"
  draggable={false}
  style={{
    left: `${(logoEff.xMm / frame.widthMm) * 100}%`,
    top: `${(logoEff.yMm / frame.heightMm) * 100}%`,
    height: `${(HALO_LOGO_H_MM / frame.heightMm) * 100}%`,
  }}
  onMouseDown={logoDragDown}
  title="Тягнути — перемістити логотип"
/>{headerUrl && <img
  src={headerUrl}
  alt="Шапка аркуша"
  className="header-block-img"
  draggable={false}
  style={{
    left: `${(headerEff.xMm / frame.widthMm) * 100}%`,
    top: `${(headerEff.yMm / frame.heightMm) * 100}%`,
    width: `${(HEADER_W_MM / frame.widthMm) * 100}%`,
  }}
  onMouseDown={headerDragDown}
  title="Тягнути — перемістити шапку"
/>}<div
  className="frame-coord-label"
  style={{
    left: `${(1 / frame.widthMm) * 100}%`,
    bottom: `${(1 / frame.heightMm) * 100}%`,
  }}
>{coordLabel}</div><img
  src={scaleUrl}
  alt={`Масштаб ${scaleSpec.scaleText}`}
  className="scale-block-img"
  draggable={false}
  style={{
    left: `${(scaleEff.xMm / frame.widthMm) * 100}%`,
    top: `${(scaleEff.yMm / frame.heightMm) * 100}%`,
    width: `${(scaleSpec.blockWMm / frame.widthMm) * 100}%`,
  }}
  onMouseDown={scaleDragDown}
  title="Тягнути — перемістити масштаб"
/>{taskCode && stampUrl && <img
  src={stampUrl}
  alt="Кутовий штамп"
  className="stamp-table-img"
  draggable={false}
  style={{
    left: `${(stampEff.xMm / frame.widthMm) * 100}%`,
    top: `${(stampEff.yMm / frame.heightMm) * 100}%`,
    width: `${(STAMP_W_MM / frame.widthMm) * 100}%`,
  }}
  onMouseDown={stampDragDown}
  title="Тягнути — перемістити штамп"
/>}</div><canvas ref={gridCanvasRef} className="grid-overlay"/>{insets.map((def) => {
  // Контейнери завжди в DOM (ховання лише visibility): розмонтування вбило б
  // MapView (той самий урок, що з панелями/табами), а створення без контейнера
  // мовчки пропускалось — звідси були вічні «не знайдено» без діагностики.
  const visible = !!taskCode && insetEnabled[def.id] !== false && insetFound[def.id] === true
  const pos = insetPos[def.id] ?? defaultPosFor(frame, insets, def.id)
  const size = insetSize[def.id] ?? { wMm: INSET_W_MM, hMm: INSET_H_MM }
  const hint = def.kind === 'lm' ? 'Карта LM — тягнути для переміщення' : `Карта ${def.label} — тягнути для переміщення`
  return (
    <div
      key={def.id}
      className={`inset-map${insetMove ? ' movable' : ''}`}
      style={{
        left: `${((frame.leftMm + pos.xMm) / page.widthMm) * 100}%`,
        top: `${((frame.topMm + pos.yMm) / page.heightMm) * 100}%`,
        width: `${(size.wMm / page.widthMm) * 100}%`,
        height: `${(size.hMm / page.heightMm) * 100}%`,
        // visibility (а не display:none): нульовий контейнер вішає
        // view.when()/goTo назавжди — звідси був вічний спінер друку.
        visibility: visible ? undefined : 'hidden',
        pointerEvents: visible ? undefined : 'none',
      }}
      onPointerDownCapture={insetMove && visible ? (event) => {
        // Ручки (переміщення/кут) обробляють самі: capture рамки їх пропускає,
        // інакше будь-який клік всередині бокса ставав би переміщенням.
        const target = event.target as HTMLElement | null
        if (target && typeof target.closest === 'function' && target.closest('.inset-grip, .inset-corner')) return
        insetDragDown(def.id, event)
      } : undefined}
      title={hint}
    >
      <div className="map-canvas" ref={(node) => { insetMapRefs.current[def.id] = node }} />
      {insetMove && visible && (
        <div
          className="inset-grip"
          title={hint}
          onMouseDown={(event) => insetDragDown(def.id, event)}
        />
      )}
      {insetMove && visible && (
        <div
          className="inset-corner"
          title="Тягнути — змінити розмір карти"
          onMouseDown={(event) => insetCornerDown(def.id, event)}
        />
      )}
    </div>
  )
})}<div
  ref={legendCardRef}
  className="legend-card"
  style={{
    left: `${((frame.leftMm + legendLayoutBox.xMm) / page.widthMm) * 100}%`,
    top: `${((frame.topMm + legendLayoutBox.yMm) / page.heightMm) * 100}%`,
    width: `${(legendLayoutBox.wMm / page.widthMm) * 100}%`,
    height: `${(legendLayoutBox.hMm / page.heightMm) * 100}%`,
    minWidth: 0,
  }}
>
  <div className="legend-edge edge-left" onMouseDown={(event) => legendEdgeDown('move', event)} title="Тягнути — перемістити легенду" />
  <div className="legend-edge edge-top" onMouseDown={(event) => legendEdgeDown('move', event)} title="Тягнути — перемістити легенду" />
  <div className="legend-edge edge-right" onMouseDown={(event) => legendEdgeDown('sizeW', event)} title="Тягнути — ширина легенди" />
  <div className="legend-edge edge-bottom" onMouseDown={(event) => legendEdgeDown('sizeH', event)} title="Тягнути — висота легенди" />
  <div className="legend-edge edge-corner" onMouseDown={(event) => legendEdgeDown('sizeWH', event)} title="Тягнути — ширина і висота" />
  {legend.evidence.length === 0 && legend.topo.length === 0 && legend.task.length === 0 ? <><div>У кадрі немає об’єктів</div><small>evidence · завдання · топо</small></> : <div className="legend-rows">{legend.evidence.slice(0, legendLayoutBox.evRows).map((row) => <div className="legend-row" key={`e:${row.symbol}|||${row.descr}`}>{row.svgUrl ? <img src={row.svgUrl} alt={row.name} /> : <span className="legend-patch" /> }<span>{row.descr || row.name}</span></div>)}{legend.task.slice(0, legendLayoutBox.taskRows).map((row) => <div className="legend-row" key={`a:${row.layerKey}:${row.label}`}><img src={row.patchUrl} alt={row.label} /><span>{row.label}</span></div>)}{legend.topo.slice(0, legendLayoutBox.topoRows).map((row) => <div className="legend-row" key={`t:${row.layerKey}:${row.code}`}><img src={row.patchUrl} alt={row.name} /><span>{row.name}</span></div>)}{legendLayoutBox.overflow > 0 && <small>+{legendLayoutBox.overflow} записів</small>}{legend.truncated && <small>…перші 2000 об’єктів</small>}</div>}{[...legendWarnings, ...legend.warnings].slice(0, 3).map((warning) => <small className="legend-warn" key={warning}>⚠ {warning}</small>)}</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

function PortalGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M5.64 5.64l12.72 12.72m0-12.72L5.64 18.36"/><circle cx="12" cy="12" r="8"/></svg> }
function MoveGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg> }
function EditGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4.2-.8L19 8.4a2.1 2.1 0 0 0-3-3L5.2 16.2 4 20Z"/><path d="M13 20h7"/></svg> }
function PrintGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/><path d="M18 12h.01"/></svg> }
function LogoutGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg> }
function DownloadGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></svg> }
function PortraitGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="1.5"/></svg> }
function LandscapeGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="1.5"/></svg> }

export default App
