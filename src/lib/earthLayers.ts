import { Credit, GeographicTilingScheme, WebMapTileServiceImageryProvider } from 'cesium'
import type { ImageryTypes } from 'cesium'

/** Verified against the current NASA GIBS EPSG:4326 WMTS capabilities document. */
export const NASA_GIBS_CLOUD_LAYER = 'MODIS_Terra_Cloud_Fraction_Day'
export const NASA_GIBS_CLOUD_OBSERVATION_DATE = '2026-08-16'
export const NASA_GIBS_CLOUD_SOURCE = 'NASA GIBS · MODIS Terra Cloud Fraction (Day)'

const CLOUD_MIN_FRACTION = 24

/** Decode the RGB palette published by NASA GIBS for MODIS Cloud Fraction. */
export function cloudFractionFromRgb(red: number, green: number, blue: number): number | null {
  if (red === 192 && green === 192 && blue === 192) return null
  if (red === 102 && blue === 119) return green
  if (red === 183 && blue === 141) return 6 + green - 15
  if (red === 0 && blue === 100) return 12 + green
  if (red === 0 && blue === 170) return 19 + green
  if (red === 0 && blue === 255) return 25 + green
  if (green === 136 && blue === 238) return 31 + red
  if (green === 80 && blue === 0) return 38 + red
  if (green === 136 && blue === 0) return 44 + red
  if (green === 220 && blue === 0) return 50 + red
  if (red === 255 && green === 255) return 57 + blue
  if (red === 240 && green === 190) return 63 + blue - 64
  if (red === 187 && green === 136) return 69 + blue
  if (red === 122 && green === 90) return 76 + blue - 3
  if (red === 110 && green === 0) return 82 + blue
  if (red === 170 && green === 0) return 88 + blue
  if (red === 255 && green === 0) return 95 + blue
  return null
}

/** Convert a cloud fraction into a restrained white overlay alpha. */
export function cloudAlphaFromFraction(fraction: number | null): number {
  if (fraction === null || fraction < CLOUD_MIN_FRACTION) return 0
  return Math.round((0.04 + ((fraction - CLOUD_MIN_FRACTION) / (100 - CLOUD_MIN_FRACTION)) * 0.45) * 255)
}

function renderCloudTile(image: ImageryTypes): ImageryTypes {
  const width = image.width
  const height = image.height
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height })
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return image
  context.drawImage(image as CanvasImageSource, 0, 0)
  const pixels = context.getImageData(0, 0, width, height)
  for (let index = 0; index < pixels.data.length; index += 4) {
    const fraction = cloudFractionFromRgb(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2])
    pixels.data[index] = 255
    pixels.data[index + 1] = 255
    pixels.data[index + 2] = 255
    pixels.data[index + 3] = cloudAlphaFromFraction(fraction)
  }
  context.putImageData(pixels, 0, 0)
  return canvas
}

export function createNasaCloudProvider(observationDate = NASA_GIBS_CLOUD_OBSERVATION_DATE): WebMapTileServiceImageryProvider {
  const provider = new WebMapTileServiceImageryProvider({
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
  const requestImage = provider.requestImage.bind(provider)
  provider.requestImage = (x, y, level, request) => {
    const image = requestImage(x, y, level, request)
    return image?.then(renderCloudTile)
  }
  return provider
}
