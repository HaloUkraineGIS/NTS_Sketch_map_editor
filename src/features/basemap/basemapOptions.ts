/** Вибір підкладу для вкладки редагування (чисті константи — без SDK, можна статично імпортувати). */
export const BASEMAP_OPTIONS = [
  { id: 'hybrid', label: 'Imagery Hybrid' },
  { id: 'osm', label: 'OpenStreetMap' },
  { id: 'topo-vector', label: 'Topographic' },
] as const

export type BasemapId = (typeof BASEMAP_OPTIONS)[number]['id']

/** Стартовий підклад редагування (детерміновано замість авторського з WebMap). */
export const DEFAULT_BASEMAP_ID: BasemapId = 'topo-vector'

/** Підклад інсет-карт LM/BM (той самий вибір, що в редагуванні). */
export const DEFAULT_INSET_BASEMAP_ID: BasemapId = 'osm'
