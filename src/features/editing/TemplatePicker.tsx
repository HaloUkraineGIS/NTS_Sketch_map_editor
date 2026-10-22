import { useEffect, useRef, useState } from 'react'
import Graphic from '@arcgis/core/Graphic.js'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type Editor from '@arcgis/core/widgets/Editor.js'
import type SketchViewModel from '@arcgis/core/widgets/Sketch/SketchViewModel.js'
import type { LayerKey } from '../../arcgis/mapSession'
import {
  buildCreateSymbol,
  fillCss,
  resolveSymbolField,
  type EvidenceLibrary,
  type LibrarySymbol,
} from '../symbols/library'
import './templates.css'

type Props = {
  view: MapView
  layers: Partial<Record<LayerKey, FeatureLayer>>
  library: EvidenceLibrary | null
  editor: Editor | null
  /** У прихованій вкладці малювання заборонене — активний скетч скасовуємо. */
  suspended: boolean
  onError: (message: string) => void
}

type ActiveTemplate = {
  layerKey: LayerKey
  layer: FeatureLayer
  field: string
  symbol: LibrarySymbol
}

const GROUPS: { layerKey: LayerKey; label: string }[] = [
  { layerKey: 'topoPoint', label: 'Точки' },
  { layerKey: 'topoLines', label: 'Лінії' },
  { layerKey: 'topoPolygons', label: 'Полігони' },
]

function toolFor(symbol: LibrarySymbol): 'point' | 'polyline' | 'polygon' {
  const geometry = symbol.geometry ?? 'point'
  return geometry === 'line' ? 'polyline' : geometry === 'polygon' ? 'polygon' : 'point'
}

export default function TemplatePicker({ view, layers, library, editor, suspended, onError }: Props) {
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const [busyCode, setBusyCode] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const effectiveLibrary = library
  const sketchRef = useRef<SketchViewModel | null>(null)
  const sketchLayerRef = useRef<GraphicsLayer | null>(null)
  const activeRef = useRef<ActiveTemplate | null>(null)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  })

  // Панель приховано (друк) — гасимо активне малювання, щоб скетч не висів без UI.
  useEffect(() => {
    if (!suspended) return
    if (!activeRef.current) return
    activeRef.current = null
    try {
      sketchRef.current?.cancel()
    } catch {
      /* ignore */
    }
    // Синхронізація стану зовнішньої системи (скетч) в UI.
    setActiveCode(null)
  }, [suspended])

  useEffect(
    () => () => {
      try {
        sketchRef.current?.cancel()
      } catch {
        /* ignore */
      }
      try {
        sketchRef.current?.destroy()
      } catch {
        /* ignore */
      }
      sketchRef.current = null
      activeRef.current = null
      const sketchLayer = sketchLayerRef.current
      sketchLayerRef.current = null
      if (sketchLayer) {
        try {
          view.map?.remove(sketchLayer)
        } catch {
          /* ignore */
        }
        try {
          sketchLayer.destroy()
        } catch {
          /* ignore */
        }
      }
    },
    [view],
  )

  async function ensureSketch(): Promise<SketchViewModel> {
    if (sketchRef.current) return sketchRef.current
    const { default: SketchViewModel } = await import('@arcgis/core/widgets/Sketch/SketchViewModel.js')
    // Малюємо у власному прихованому GraphicsLayer (SketchViewModel не працює
    // напряму з FeatureLayer), готовий об’єкт пишемо в сервіс через applyEdits.
    const sketchLayer = new GraphicsLayer({ listMode: 'hide' })
    view.map?.add(sketchLayer)
    sketchLayerRef.current = sketchLayer
    const sketch = new SketchViewModel({
      view,
      layer: sketchLayer,
      snappingOptions: { enabled: true, featureEnabled: true, selfEnabled: true },
    })
    sketch.on('create', (event) => {
      if (event.state === 'cancel') {
        activeRef.current = null
        setActiveCode(null)
        return
      }
      if (event.state !== 'complete') return
      const info = activeRef.current
      const geometry = event.graphic?.geometry
      activeRef.current = null
      setActiveCode(null)
      sketchLayer.removeAll()
      if (!info || !geometry) return
      void (async () => {
        try {
          const result = await info.layer.applyEdits({
            addFeatures: [
              new Graphic({
                geometry,
                attributes: { [info.field]: info.symbol.code },
              }),
            ],
          })
          const first = result.addFeatureResults?.[0]
          const editError = first?.error as { message?: string } | undefined
          if (!first || editError) {
            throw new Error(editError?.message ?? 'Сервіс відхилив створення об’єкта.')
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Не вдалося створити об’єкт.'
          setLocalError(message)
          onErrorRef.current(message)
        }
      })()
    })
    sketchRef.current = sketch
    return sketch
  }

  function cancelDrawing() {
    activeRef.current = null
    setActiveCode(null)
    try {
      sketchRef.current?.cancel()
    } catch {
      /* ignore */
    }
  }

  async function startTemplate(layerKey: LayerKey, symbol: LibrarySymbol) {
    setLocalError(null)
    if (activeCode === symbol.code) {
      cancelDrawing()
      return
    }
    const layer = layers[layerKey]
    if (!layer) {
      onError(`Шар ${layerKey} не знайдено у WebMap.`)
      return
    }
    const field = resolveSymbolField(layer, symbol)
    if (!field) {
      onError(`Поле ${symbol.field ?? 'symbol_code'} не знайдено в шарі ${layerKey} — шаблон недоступний.`)
      return
    }
    if (layer.editingEnabled === false) {
      onError(`Шар ${layerKey} недоступний для редагування з вашими правами.`)
      return
    }
    setBusyCode(symbol.code)
    try {
      try {
        editor?.cancelWorkflow()
      } catch {
        /* ignore */
      }
      const sketch = await ensureSketch()
      sketch.cancel()
      const createSymbol = await buildCreateSymbol(symbol, { scale: view.scale, dpi: 96 })
      const geometry = symbol.geometry ?? 'point'
      if (geometry === 'point') sketch.pointSymbol = createSymbol as SketchViewModel['pointSymbol']
      else if (geometry === 'line') sketch.polylineSymbol = createSymbol as SketchViewModel['polylineSymbol']
      else sketch.polygonSymbol = createSymbol as SketchViewModel['polygonSymbol']
      activeRef.current = { layerKey, layer, field, symbol }
      setActiveCode(symbol.code)
      sketch.create(toolFor(symbol))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не вдалося почати малювання.'
      setLocalError(message)
      onError(message)
      activeRef.current = null
      setActiveCode(null)
    } finally {
      setBusyCode(null)
    }
  }

  if (!effectiveLibrary || effectiveLibrary.symbols.length === 0) return null
  const groups = GROUPS.map((group) => ({
    ...group,
    symbols: (effectiveLibrary.symbols ?? []).filter((s) => (s.layers ?? []).includes(group.layerKey)),
  })).filter((group) => group.symbols.length > 0)
  if (groups.length === 0) return null

  const activeName = activeCode
    ? (effectiveLibrary.symbols ?? []).find((s) => s.code === activeCode)?.name ?? activeCode
    : null

  return (
    <section className="template-picker" aria-label="Шаблони створення">
      <div className="section-label">СТВОРИТИ ОБ’ЄКТ</div>
      {groups.map((group) => (
        <div key={group.layerKey}>
          <div className="template-group-label">{group.label}</div>
          <div className="template-grid">
            {group.symbols.map((symbol) => (
              <button
                key={symbol.code}
                className={`template-card${activeCode === symbol.code ? ' active' : ''}`}
                title={`${symbol.name} (${symbol.code}) — клікнути і малювати на карті`}
                disabled={busyCode !== null}
                onClick={() => void startTemplate(group.layerKey, symbol)}
              >
                <TemplatePreview symbol={symbol} />
                <span>{symbol.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {activeName && (
        <button className="template-cancel" onClick={cancelDrawing}>
          Скасувати малювання: {activeName}
        </button>
      )}
      {localError && <div className="template-error">{localError}</div>}
    </section>
  )
}

function TemplatePreview({ symbol }: { symbol: LibrarySymbol }) {
  const geometry = symbol.geometry ?? 'point'
  // Скидання при зміні знака — render-phase (не в ефекті): картки ключуються кодом.
  const [patternPatch, setPatternPatch] = useState<{ code: string; url: string | null }>({
    code: symbol.code,
    url: null,
  })
  if (patternPatch.code !== symbol.code) {
    setPatternPatch({ code: symbol.code, url: null })
  }
  useEffect(() => {
    let alive = true
    const needsPatternPatch =
      (geometry === 'line' && symbol.pattern && !symbol.svg) ||
      (geometry === 'polygon' && symbol.polygonPattern)
    if (needsPatternPatch) {
      void import('../symbols/library').then(({ buildLegendPatch }) => buildLegendPatch(symbol, 48))
        .then((base64) => {
          if (alive) setPatternPatch({ code: symbol.code, url: `data:image/png;base64,${base64}` })
        })
        .catch(() => {
          if (alive) setPatternPatch({ code: symbol.code, url: null })
        })
    }
    return () => {
      alive = false
    }
  }, [geometry, symbol])
  if (symbol.hidden) {
    return <span className="template-ghost" title={symbol.name} aria-hidden="true" />
  }
  if (geometry === 'point' && symbol.svg) {
    return (
      <img
        className="template-img"
        src={`${import.meta.env.BASE_URL}${symbol.svg}`}
        alt={symbol.name}
      />
    )
  }
  if (geometry === 'line' && symbol.svg) {
    return (
      <img
        className="template-line-img"
        src={`${import.meta.env.BASE_URL}${symbol.svg}`}
        alt={symbol.name}
      />
    )
  }
  if (geometry === 'line' && patternPatch.url) {
    return (
      <img
        className="template-line-img"
        src={patternPatch.url}
        alt={symbol.name}
      />
    )
  }
  if (geometry === 'line') {
    return (
      <span
        className="template-line"
        style={{ background: symbol.stroke?.color ?? symbol.color ?? '#555' }}
        aria-hidden="true"
      />
    )
  }
  if (geometry === 'polygon' && patternPatch.url) {
    return (
      <img
        className="template-img"
        src={patternPatch.url}
        alt={symbol.name}
      />
    )
  }
  return (
    <span
      className="template-poly"
      style={{
        borderColor: symbol.outline?.color ?? symbol.color ?? '#7b3f00',
        borderStyle: symbol.outline?.style === 'solid' || !symbol.outline?.style ? 'solid' : 'dotted',
        background: fillCss(symbol),
      }}
      aria-hidden="true"
    />
  )
}
