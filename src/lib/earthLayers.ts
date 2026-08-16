import { Credit, GeographicTilingScheme, WebMapTileServiceImageryProvider } from 'cesium'

/** Verified against the current NASA GIBS EPSG:4326 WMTS capabilities document. */
export const NASA_GIBS_CLOUD_LAYER = 'MODIS_Terra_Cloud_Fraction_Day'
export const NASA_GIBS_CLOUD_OBSERVATION_DATE = '2026-08-16'
export const NASA_GIBS_CLOUD_SOURCE = 'NASA GIBS · MODIS Terra Cloud Fraction (Day)'

export function createNasaCloudProvider(observationDate = NASA_GIBS_CLOUD_OBSERVATION_DATE): WebMapTileServiceImageryProvider {
  return new WebMapTileServiceImageryProvider({
    url: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${NASA_GIBS_CLOUD_LAYER}/default/${observationDate}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png`,
    layer: NASA_GIBS_CLOUD_LAYER,
    style: 'default',
    format: 'image/png',
    tileMatrixSetID: '2km',
    tilingScheme: new GeographicTilingScheme(),
    tileWidth: 512,
    tileHeight: 512,
    maximumLevel: 8,
    tileMatrixLabels: Array.from({ length: 9 }, (_, index) => String(index)),
    credit: new Credit(NASA_GIBS_CLOUD_SOURCE),
  })
}
