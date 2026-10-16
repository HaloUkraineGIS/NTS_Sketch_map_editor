import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import * as reactiveUtils from '@arcgis/core/core/reactiveUtils.js'
import type Point from '@arcgis/core/geometry/Point.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'
import { EVIDENCE_ANGLE_FIELD, EVIDENCE_DESCR_MAX, EVIDENCE_HIDDEN_CODE, loadEvidenceLibrary, type EvidenceLibrary } from '../symbols/library'
import {
  EVIDENCE_PAGE_SIZE,
  findEvidencePage,
  queryEvidencePage,
  saveEvidenceRow,
  type EvidenceRow,
} from './evidenceData'
import SymbolSearch from './SymbolSearch'
import { symbolDisplayName } from './symbolDisplay'
import './evidence.css'

type Props = {
  view: MapView
  layer: FeatureLayer
  taskCode: string
  onSaved: () => void
}

type Draft = { symbol_code: string; symbol_angle: string; legend_decr: string }

/** Порожньо — без повороту; інакше число 1–360 (0 — північ, за годинниковою). */
function parseAngle(raw: string): { ok: true; value: number | null } | { ok: false } {
  const text = raw.trim().replace(',', '.')
  if (text === '') return { ok: true, value: null }
  const value = Number(text)
  if (!Number.isFinite(value) || value < 1 || value > 360) return { ok: false }
  return { ok: true, value }
}

const TABLE_MIN_HEIGHT = 132
const TABLE_MAX_HEIGHT = 600
const TABLE_DEFAULT_HEIGHT = 248

function categoryLabel(value: string): string {
  if (value === '1') return 'Direct'
  if (value === '2') return 'Indirect'
  return value || '—'
}

export default function EvidenceTable({ view, layer, taskCode, onSaved }: Props) {
  const [library, setLibrary] = useState<EvidenceLibrary | null>(null)
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [rows, setRows] = useState<EvidenceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [tableHeight, setTableHeight] = useState(TABLE_DEFAULT_HEIGHT)
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [savingFid, setSavingFid] = useState<number | null>(null)
  const [rowError, setRowError] = useState<Record<number, string>>({})
  const [selectedFid, setSelectedFid] = useState<number | null>(null)
  const highlightRef = useRef<{ remove(): void } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  // Дзеркала для колбеків карти (клік-хендлер підписується один раз).
  const pageRef = useRef(page)
  pageRef.current = page
  const selectedRef = useRef<number | null>(null)
  selectedRef.current = selectedFid
  const pendingScrollRef = useRef<number | null>(null)

  const highlightFid = useCallback(
    async (fid: number) => {
      try {
        const layerView = await view.whenLayerView(layer)
        highlightRef.current?.remove()
        highlightRef.current = (
          layerView as unknown as { highlight: (id: number) => { remove(): void } }
        ).highlight(fid)
      } catch {
        /* підсвітка необовʼязкова */
      }
    },
    [view, layer],
  )

  const scrollToRow = useCallback((fid: number) => {
    scrollRef.current?.querySelector(`[data-fid="${fid}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [])

  /** Вибір кліком по точці на карті: підсвітка + розгорнута таблиця + стрибок на сторінку + прокрутка. */
  const revealFromMap = useCallback(
    async (fid: number) => {
      if (selectedRef.current === fid) {
        scrollToRow(fid)
        return
      }
      setCollapsed(false)
      setSelectedFid(fid)
      await highlightFid(fid)
      try {
        const targetPage = await findEvidencePage(view, layer, fid)
        if (targetPage < 0) return
        if (targetPage === pageRef.current) {
          scrollToRow(fid)
        } else {
          pendingScrollRef.current = fid
          setPage(targetPage)
        }
      } catch {
        /* стрибок на сторінку необовʼязковий — підсвітка вже є */
      }
    },
    [view, layer, highlightFid, scrollToRow],
  )

  useEffect(() => {
    setPage(0)
    setDrafts({})
    setRowError({})
    setSelectedFid(null)
    pendingScrollRef.current = null
    highlightRef.current?.remove()
    highlightRef.current = null
  }, [taskCode])

  useEffect(() => {
    let alive = true
    loadEvidenceLibrary().then((lib) => {
      if (alive) setLibrary(lib)
    })
    return () => {
      alive = false
    }
  }, [])

  const loadPage = useCallback(async () => {
    if (!taskCode) {
      setRows([])
      setTotal(0)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await queryEvidencePage(view, layer, page)
      setRows(result.rows)
      setTotal(result.total)
      const maxPage = Math.max(0, Math.ceil(result.total / EVIDENCE_PAGE_SIZE) - 1)
      if (page > maxPage) setPage(maxPage)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося завантажити таблицю.')
    } finally {
      setLoading(false)
    }
  }, [view, layer, page, taskCode])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  // Таблиця сама стежить за фільтром шару: task змінили будь-де — дані оновились.
  useEffect(() => {
    let alive = true
    let watchHandle: { remove(): void } | undefined
    void view.whenLayerView(layer).then((layerView) => {
      if (!alive) return
      watchHandle = reactiveUtils.watch(
        () =>
          (layerView as unknown as { filter?: { where?: string } | null }).filter?.where ?? '',
        () => {
          void loadPage()
        },
      )
    })
    return () => {
      alive = false
      watchHandle?.remove()
    }
  }, [view, layer, loadPage])

  // Зовнішні правки (карта/Editor) — оновлюємо сторінку.
  useEffect(() => {
    const handle = layer.on('edits', () => {
      void loadPage()
    })
    return () => handle.remove()
  }, [layer, loadPage])

  // Клік по точці evidence на карті — вибрати її рядок у таблиці.
  // Порожній клік вибір не скидає (для цього є кнопка Clear).
  useEffect(() => {
    const handle = view.on('click', (event) => {
      void (async () => {
        try {
          const response = await view.hitTest(event)
          const hit = response.results.find((result) => {
            const graphic = (result as { graphic?: { layer?: unknown } }).graphic
            return graphic?.layer === layer
          }) as { graphic?: { attributes?: Record<string, unknown> } } | undefined
          const fid = hit?.graphic?.attributes?.[layer.objectIdField]
          if (typeof fid !== 'number') return
          await revealFromMap(fid)
        } catch {
          /* hitTest необовʼязковий */
        }
      })()
    })
    return () => handle.remove()
  }, [view, layer, revealFromMap])

  // Після стрибка на сторінку з карти — прокрутити таблицю до рядка.
  useEffect(() => {
    const fid = pendingScrollRef.current
    if (fid == null) return
    pendingScrollRef.current = null
    scrollToRow(fid)
  }, [rows, scrollToRow])

  useEffect(
    () => () => {
      highlightRef.current?.remove()
      highlightRef.current = null
    },
    [],
  )

  function onResizeStart(event: React.MouseEvent) {
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startHeight: tableHeight }
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      setTableHeight(
        Math.min(TABLE_MAX_HEIGHT, Math.max(TABLE_MIN_HEIGHT, drag.startHeight + (drag.startY - moveEvent.clientY))),
      )
    }
    const onUp = () => {
      dragRef.current = null
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  async function selectRow(fid: number) {
    if (selectedFid === fid) {
      clearSelection()
      return
    }
    setSelectedFid(fid)
    await highlightFid(fid)
  }

  function clearSelection() {
    setSelectedFid(null)
    highlightRef.current?.remove()
    highlightRef.current = null
  }

  async function zoomToSelected() {
    if (selectedFid == null) return
    try {
      const result = await layer.queryFeatures({
        objectIds: [selectedFid],
        outFields: [],
        returnGeometry: true,
      })
      const geometry = result.features[0]?.geometry
      if (!geometry) {
        setError('Не знайдено геометрію вибраного об’єкта.')
        return
      }
      await view.goTo({ center: geometry as Point })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося наблизити карту.')
    }
  }

  function startEdit(row: EvidenceRow) {
    setRowError((prev) => {
      const next = { ...prev }
      delete next[row.fid]
      return next
    })
    setDrafts((prev) => ({
      ...prev,
      [row.fid]: { symbol_code: row.symbol_code, symbol_angle: row.symbol_angle, legend_decr: row.legend_decr },
    }))
  }

  function cancelEdit(fid: number) {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[fid]
      return next
    })
    setRowError((prev) => {
      const next = { ...prev }
      delete next[fid]
      return next
    })
  }

  async function saveRow(row: EvidenceRow) {
    const draft = drafts[row.fid]
    if (!draft) return
    const angle = parseAngle(draft.symbol_angle)
    if (!angle.ok) {
      setRowError((prev) => ({
        ...prev,
        [row.fid]: 'Кут — число від 1 до 360 або порожньо (без повороту).',
      }))
      return
    }
    if (draft.symbol_code === row.symbol_code && draft.legend_decr === row.legend_decr && draft.symbol_angle === row.symbol_angle) {
      cancelEdit(row.fid)
      return
    }
    setSavingFid(row.fid)
    try {
      await saveEvidenceRow(layer, row.fid, {
        symbol_code: draft.symbol_code,
        symbol_angle: angle.value,
        legend_decr: draft.legend_decr.slice(0, EVIDENCE_DESCR_MAX),
      })
      cancelEdit(row.fid)
      await loadPage()
      onSaved()
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [row.fid]: err instanceof Error ? err.message : 'Не вдалося зберегти.',
      }))
    } finally {
      setSavingFid(null)
    }
  }

  const from = total === 0 ? 0 : page * EVIDENCE_PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * EVIDENCE_PAGE_SIZE)
  // Випадайка показує лише точкові знаки, дозволені для шару evidence.
  const evidenceSymbols = (library?.symbols ?? []).filter(
    (symbol) => (symbol.geometry ?? 'point') === 'point' && (symbol.layers ?? []).includes('evidence'),
  )
  // Колонки symbol_angle може не бути в старому сервісі — тоді лише перегляд.
  const angleEditable = (layer.fields ?? []).some(
    (field) => field.name.toLowerCase() === EVIDENCE_ANGLE_FIELD,
  )

  return (
    <section
      className={`evidence-table${collapsed ? ' collapsed' : ''}`}
      aria-label="Таблиця evidence"
      style={collapsed ? undefined : { height: tableHeight }}
    >
      <div
        className="table-resizer"
        title="Тягнути для зміни висоти таблиці"
        onMouseDown={onResizeStart}
      />
      <header className="evidence-table-head">
        <button
          className="collapse-button"
          aria-label={collapsed ? 'Розгорнути таблицю' : 'Згорнути таблицю'}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '▲' : '▼'}
        </button>
        <strong>EVIDENCE</strong>
        <span className="evidence-count">
          {loading ? 'Завантаження…' : total === 0 ? 'Немає записів' : `${from}–${to} з ${total}`}
        </span>
        <span className="evidence-pager">
          <button
            className="header-button"
            title="Зблизити карту до вибраного об’єкта"
            disabled={selectedFid == null}
            onClick={() => void zoomToSelected()}
          >
            Zoom to
          </button>
          <button
            className="header-button"
            title="Зняти виділення рядків"
            disabled={selectedFid == null}
            onClick={clearSelection}
          >
            Clear
          </button>
          <button aria-label="Оновити" disabled={loading} onClick={() => void loadPage()}>
            ↻
          </button>
        </span>
      </header>
      {error && <div className="evidence-error">{error}</div>}
      <div className="evidence-scroll" ref={scrollRef}>
        <table>
          <thead>
            <tr>
              <th className="col-actions" />
              <th className="col-symbol">Умовний знак</th>
              <th className="col-angle">Кут,°</th>
              <th className="col-descr">Підпис в легенді</th>
              <th className="col-category">Категорія</th>
              <th className="col-type">Тип точки</th>
              <th className="col-x">X</th>
              <th className="col-y">Y</th>
              <th className="col-evidence">Опис доказу</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const draft = drafts[row.fid]
              const editing = !!draft
              const unknownCode =
                row.symbol_code && !library?.symbols.some((s) => s.code === row.symbol_code)
                  ? row.symbol_code
                  : null
              return (
                <tr
                  key={row.fid}
                  data-fid={row.fid}
                  className={`${editing ? 'editing' : ''}${selectedFid === row.fid ? ' selected' : ''}`}
                  onClick={() => void selectRow(row.fid)}
                >
                  <td className="col-actions" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                      <>
                        <button
                          className="icon-action primary"
                          title="Зберегти"
                          aria-label="Зберегти"
                          disabled={savingFid === row.fid}
                          onClick={() => void saveRow(row)}
                        >
                          {savingFid === row.fid ? '…' : <CheckGlyph />}
                        </button>
                        <button
                          className="icon-action"
                          title="Скасувати"
                          aria-label="Скасувати"
                          onClick={() => cancelEdit(row.fid)}
                        >
                          <CrossGlyph />
                        </button>
                      </>
                    ) : (
                      <button
                        className="icon-action"
                        title="Редагувати"
                        aria-label="Редагувати"
                        onClick={() => startEdit(row)}
                      >
                        <EditGlyph />
                      </button>
                    )}
                    {rowError[row.fid] && <small className="row-error">{rowError[row.fid]}</small>}
                  </td>
                  <td
                    className="col-symbol"
                    onClick={editing ? (event) => event.stopPropagation() : undefined}
                  >
                    {editing ? (
                      <span className="symbol-edit">
                        <SymbolPreview library={library} code={draft.symbol_code} />
                        <SymbolSearch
                          library={library}
                          symbols={evidenceSymbols}
                          value={draft.symbol_code}
                          unknownCode={unknownCode}
                          onChange={(code) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [row.fid]: { ...draft, symbol_code: code },
                            }))
                          }
                        />
                      </span>
                    ) : (
                      <span className="symbol-view">
                        <SymbolPreview library={library} code={row.symbol_code} />
                        <span className={row.symbol_code === EVIDENCE_HIDDEN_CODE ? 'symbol-code-hidden' : undefined} title={symbolDisplayName(library, row.symbol_code)}>{symbolDisplayName(library, row.symbol_code)}</span>
                      </span>
                    )}
                  </td>
                  <td
                    className="col-angle"
                    title={angleEditable ? 'Кут повороту знака: порожньо — без повороту, 1–360 (0 — північ, за годинниковою)' : 'Поля symbol_angle нема в сервісі'}
                    onClick={editing ? (event) => event.stopPropagation() : undefined}
                  >
                    {editing && angleEditable ? (
                      <input
                        value={draft.symbol_angle}
                        onChange={(event) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [row.fid]: { ...draft, symbol_angle: event.target.value },
                          }))
                        }
                        placeholder="—"
                        inputMode="decimal"
                        aria-label="Кут повороту знака в градусах"
                      />
                    ) : (
                      <span>{row.symbol_angle || '—'}</span>
                    )}
                  </td>
                  <td
                    className="col-descr"
                    onClick={editing ? (event) => event.stopPropagation() : undefined}
                  >
                    {editing ? (
                      <span className="descr-edit">
                        <input
                          value={draft.legend_decr}
                          maxLength={EVIDENCE_DESCR_MAX}
                          placeholder="Підпис до легенди…"
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [row.fid]: {
                                ...draft,
                                legend_decr: event.target.value.slice(0, EVIDENCE_DESCR_MAX),
                              },
                            }))
                          }
                        />
                        <small>
                          {draft.legend_decr.length}/{EVIDENCE_DESCR_MAX}
                        </small>
                      </span>
                    ) : (
                      <span className="descr-view">{row.legend_decr || '—'}</span>
                    )}
                  </td>
                  <td className="col-category">{categoryLabel(row.category)}</td>
                  <td className="col-type">{row.type_name || '—'}</td>
                  <td className="col-x">{row.coord_x || '—'}</td>
                  <td className="col-y">{row.coord_y || '—'}</td>
                  <td className="col-evidence" title={row.evidence || undefined}>
                    <span className="cell-clip">{row.evidence || '—'}</span>
                  </td>
                </tr>
              )
            })}
            {!loading && rows.length === 0 && !error && (
              <tr>
                <td colSpan={8} className="empty-row">
                  {taskCode
                    ? 'Немає об’єктів evidence для цього завдання.'
                    : 'Оберіть завдання, щоб побачити evidence.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function SymbolPreview({ library, code }: { library: EvidenceLibrary | null; code: string }) {
  const symbol = library?.symbols.find((s) => s.code === code)
  if (!symbol) return <span className="symbol-dot" aria-hidden="true" />
  if (symbol.hidden) return <span className="symbol-ghost" title={symbol.name} aria-hidden="true" />
  if (!symbol.svg) return <span className="symbol-dot" aria-hidden="true" />
  return (
    <img
      className="symbol-img"
      src={`${import.meta.env.BASE_URL}${symbol.svg}`}
      alt={symbol.name}
      title={symbol.name}
    />
  )
}

function EditGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m14 5 5 5M4 20l4.2-.8L19 8.4a2.1 2.1 0 0 0-3-3L5.2 16.2 4 20Z" />
      <path d="M13 20h7" />
    </svg>
  )
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  )
}

function CrossGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}
