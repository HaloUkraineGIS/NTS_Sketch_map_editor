import Basemap from '@arcgis/core/Basemap.js'
import type Layer from '@arcgis/core/layers/Layer.js'
import OpenStreetMapLayer from '@arcgis/core/layers/OpenStreetMapLayer.js'
import TileLayer from '@arcgis/core/layers/TileLayer.js'
import type MapView from '@arcgis/core/views/MapView.js'
import type WebMap from '@arcgis/core/WebMap.js'
import type { BasemapId } from './basemapOptions'

/**
 * Підклад читається з карти (`map.basemap`), а карти в усіх вʼю спільна —
 * тому «різні підклади в різних вʼю» робляться видимістю LayerView:
 * - редагування (WebMercator): підклад на вибір користувача;
 * - друк, головна (UTM): взагалі без підкладу;
 * - інсети LM/BM (WebMercator): підклад на вибір (той самий список),
 *   реалізований окремими шарами — щоб вибір інсетів не чіпав редагування.
 *
 * Інсети СВІДОМО лишаються у WebMercator: тайлові шари (і растр, і вектор)
 * мусять збігатися з SR вʼю, в замкненому UTM вони призупиняються.
 * Масштаб вʼю — справжній у центрі, екстент інсета малий, тож 1:1000 чесний.
 */

export type InsetBasemapLayers = Record<BasemapId, { base: Layer[]; reference: Layer[] }>

/**
 * Набори шарів для підкладу інсетів: базові + референсні (підписи поверх даних).
 * Свіжі інстанси з явними сервісами Esri (НЕ перетягнуті з `Basemap.fromId` —
 * ті несуть батьківські колекції підкладу і на спільну карту не стають).
 * Інсети живуть у WebMercator, тож растрові тайли тут рідні.
 */
export function createInsetBasemapLayers(): InsetBasemapLayers {
  const imagery = new TileLayer({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    title: 'Супутник (інсети)',
  })
  const boundaries = new TileLayer({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer',
    title: 'Підписи (інсети)',
  })
  const transportation = new TileLayer({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer',
    title: 'Дороги (інсети)',
  })
  const osm = new OpenStreetMapLayer({ title: 'OSM (інсети)' })
  const topo = new TileLayer({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer',
    title: 'Топо (інсети)',
  })
  return {
    hybrid: { base: [imagery], reference: [boundaries, transportation] },
    osm: { base: [osm], reference: [] },
    'topo-vector': { base: [topo], reference: [] },
  }
}

/** Усі шари наборів одним списком (додавання на карту, ховання). */
export function allInsetBasemapLayers(sets: InsetBasemapLayers): Layer[] {
  return (Object.keys(sets) as BasemapId[]).flatMap((id) => [...sets[id].base, ...sets[id].reference])
}

/** Підклад вкладки редагування (діє на всю спільну карту). */
export function setEditBasemap(map: WebMap, id: string): void {
  const next = Basemap.fromId(id)
  if (!next) throw new Error(`Невідомий підклад: ${id}.`)
  map.basemap = next
}

async function setVisibleInView(view: MapView, layer: Layer, visible: boolean): Promise<void> {
  try {
    const layerView = await view.whenLayerView(layer)
    layerView.visible = visible
  } catch {
    /* LayerView ще нема — політику застосують пізніше */
  }
}

function basemapLayersOf(map: WebMap): Layer[] {
  return [
    ...(map.basemap?.baseLayers?.toArray() ?? []),
    ...(map.basemap?.referenceLayers?.toArray() ?? []),
  ]
}

/**
 * Розкласти видимість підкладів по вʼю (ідемпотентно).
 * Викликати після кожної зміни SR (вона перестворює LayerView і зносить
 * visible — той самий урок, що з фільтрами), створення інсета і зміни підкладу.
 */
export async function syncBasemapVisibility(args: {
  map: WebMap
  editView: MapView
  printView: MapView | null
  insetViews: MapView[]
  insetLayers: InsetBasemapLayers | null
  insetBasemapId: string
}): Promise<void> {
  const { map, editView, printView, insetViews, insetLayers, insetBasemapId } = args
  const jobs: Promise<unknown>[] = []
  const basemapLayers = basemapLayersOf(map)
  const insetAll = insetLayers ? allInsetBasemapLayers(insetLayers) : []
  const selected = insetLayers
    ? [...(insetLayers[insetBasemapId as BasemapId]?.base ?? []), ...(insetLayers[insetBasemapId as BasemapId]?.reference ?? [])]
    : []
  const selectedIds = new Set(selected.map((layer) => layer.id))
  // Друк (головна): взагалі без підкладу.
  if (printView) {
    for (const layer of basemapLayers) jobs.push(setVisibleInView(printView, layer, false))
    for (const layer of insetAll) jobs.push(setVisibleInView(printView, layer, false))
  }
  // Редагування: підклад на вибір + ховаємо шари інсетів.
  for (const layer of insetAll) jobs.push(setVisibleInView(editView, layer, false))
  // Інсети: вибраний набір видимий, решта наборів і підклад редагування сховані
  // (інакше в інсеті було б кілька підкладів поверх одне одного).
  for (const insetView of insetViews) {
    for (const layer of basemapLayers) jobs.push(setVisibleInView(insetView, layer, false))
    for (const layer of insetAll) {
      jobs.push(setVisibleInView(insetView, layer, selectedIds.has(layer.id)))
    }
  }
  await Promise.all(jobs)
}
