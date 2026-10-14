import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js'
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js'
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js'
import UniqueValueRenderer from '@arcgis/core/renderers/UniqueValueRenderer.js'
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer.js'
import type { LayerKey } from '../../arcgis/mapSession'

export type SymbolGeometry = 'point' | 'line' | 'polygon'

/**
 * Запис локального каталогу символів.
 * - layerKey: логічний ключ шару (topoPoint | topoLines | topoPolygons | ...).
 * - field: атрибут із symbol_code.
 * - value: значення symbol_code.
 * - label: текст легенди (мова за погодженням, див. PROJECT_SPEC 9).
 * - color/size/width/fillOpacity: простий стиль; складні CIM/hatch — окремим етапом.
 */
export type SymbolEntry = {
  layerKey: string
  field: string
  value: string | number
  geometry: SymbolGeometry
  label: string
  color?: string
  size?: number
  width?: number
  fillOpacity?: number
}

export type SymbolRegistry = {
  version: number
  description?: string
  symbols: SymbolEntry[]
}

let cache: SymbolRegistry | null | undefined

export async function loadSymbolRegistry(): Promise<SymbolRegistry> {
  if (cache !== undefined) return cache ?? { version: 1, symbols: [] }
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}symbols/registry.json`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as Partial<SymbolRegistry>
    cache = { version: data.version ?? 1, description: data.description, symbols: Array.isArray(data.symbols) ? data.symbols : [] }
  } catch {
    cache = { version: 1, symbols: [] }
  }
  return cache
}

function entryProblems(entry: SymbolEntry, layers: Partial<Record<LayerKey, FeatureLayer>>): string | null {
  const layer = (layers as Partial<Record<string, FeatureLayer>>)[entry.layerKey]
  if (!layer) return `Невідомий шар у каталозі: ${entry.layerKey} (symbol_code ${String(entry.value)}).`
  const field = layer.fields?.find((f) => f.name.toLowerCase() === entry.field.toLowerCase())?.name
  if (!field) return `Поле ${entry.field} не знайдено в шарі ${entry.layerKey} (symbol_code ${String(entry.value)}).`
  if (!['point', 'line', 'polygon'].includes(entry.geometry)) {
    return `Невідома геометрія ${entry.geometry} для ${entry.layerKey}:${String(entry.value)}.`
  }
  return null
}

/**
 * Застосовує каталог до клієнтських renderer (сервісну символіку не чіпає).
 * Повертає контрольовані попередження для невідомих/непідтримуваних записів.
 */
export function applySymbolRegistry(
  layers: Partial<Record<LayerKey, FeatureLayer>>,
  registry: SymbolRegistry,
): string[] {
  const warnings: string[] = []
  const byLayer = new Map<string, SymbolEntry[]>()
  for (const entry of registry.symbols) {
    const problem = entryProblems(entry, layers)
    if (problem) {
      warnings.push(problem)
      continue
    }
    const list = byLayer.get(entry.layerKey) ?? []
    list.push(entry)
    byLayer.set(entry.layerKey, list)
  }

  for (const [layerKey, entries] of byLayer) {
    const layer = (layers as Partial<Record<string, FeatureLayer>>)[layerKey]
    if (!layer) continue
    const fields = [...new Set(entries.map((e) => e.field.toLowerCase()))]
    if (fields.length > 1) {
      warnings.push(`Шар ${layerKey} має записи за кількома полями (${fields.join(', ')}); використано ${entries[0].field}.`)
    }
    const field = entries[0].field
    try {
      layer.renderer = new UniqueValueRenderer({
        field,
        defaultLabel: 'Інше',
        uniqueValueInfos: entries.map((entry) => ({
          value: entry.value,
          label: entry.label,
          symbol:
            entry.geometry === 'point'
              ? new SimpleMarkerSymbol({
                  color: entry.color ?? '#d35400',
                  size: entry.size ?? 10,
                  outline: { color: '#ffffff', width: 1 },
                })
              : entry.geometry === 'line'
                ? new SimpleLineSymbol({ color: entry.color ?? '#7b3f00', width: entry.width ?? 2 })
                : new SimpleFillSymbol({
                    color: withOpacity(entry.color ?? '#7b3f00', entry.fillOpacity ?? 0.25),
                    outline: new SimpleLineSymbol({ color: entry.color ?? '#7b3f00', width: entry.width ?? 2 }),
                  }),
        })),
      })
    } catch (error) {
      warnings.push(`Не вдалося застосувати символи до ${layerKey}: ${error instanceof Error ? error.message : 'невідома помилка'}.`)
    }
  }
  return [...new Set(warnings)]
}

function withOpacity(hex: string, opacity: number): [number, number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return [123, 63, 0, opacity]
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, opacity]
}
