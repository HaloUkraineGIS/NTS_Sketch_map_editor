export const PORTAL_URL = 'https://gis.htgoims.org/portal'
export const OAUTH_CLIENT_ID = 'vckaS5e4gVWlsAg9'
export const WEBMAP_ITEM_ID = '346b8032e4ae40e582249ba5f9dfe872'

export const LAYER_URLS = {
  task: 'https://gis-services.htgoims.org/arcgis/rest/services/ukraine/ukr_task_hazardous_areas/FeatureServer/0',
  evidence: 'https://gis-services.htgoims.org/arcgis/rest/services/ukraine/ukr_evidence_point_s123/FeatureServer/0',
  taskGeopoint: 'https://gis-services.htgoims.org/arcgis/rest/services/ukraine/ukr_task_hazardous_areas/FeatureServer/2',
  taskPolygon: 'https://gis-services.htgoims.org/arcgis/rest/services/ukraine/ukr_task_hazardous_areas/FeatureServer/4',
  polygonGeopoint: 'https://gis-services.htgoims.org/arcgis/rest/services/ukraine/ukr_task_hazardous_areas/FeatureServer/5',
  topoPoint: 'https://gis.htgoims.org/server/rest/services/Hosted/topo_for_sketch_map/FeatureServer/0',
  topoLines: 'https://gis.htgoims.org/server/rest/services/Hosted/topo_for_sketch_map/FeatureServer/1',
  topoPolygons: 'https://gis.htgoims.org/server/rest/services/Hosted/topo_for_sketch_map/FeatureServer/2',
  imsmaPolygons: 'https://gis.htgoims.org/server/rest/services/Ukraine/ukr_imsma_hazardous_area_status/MapServer/3',
} as const

export const UTM_ZONES = [
  { wkid: 32635, label: 'UTM 35N · EPSG:32635', minLongitude: 24, maxLongitude: 30 },
  { wkid: 32636, label: 'UTM 36N · EPSG:32636', minLongitude: 30, maxLongitude: 36 },
  { wkid: 32637, label: 'UTM 37N · EPSG:32637', minLongitude: 36, maxLongitude: 42 },
] as const

export const PRINT_SCALES = [
  500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000,
  6000, 7500, 10000,
]

/** Межі довільного масштабу з поля вводу (знаменник, 1:N). */
export const CUSTOM_SCALE_MIN = 100
export const CUSTOM_SCALE_MAX = 100000

export const LAYER_ROLES = {
  task: 'filter-parent',
  evidence: 'attribute-only',
  taskGeopoint: 'filter-child',
  taskPolygon: 'filter-child',
  polygonGeopoint: 'filter-grandchild',
  topoPoint: 'editable',
  topoLines: 'editable',
  topoPolygons: 'editable',
  imsmaPolygons: 'reference',
} as const
