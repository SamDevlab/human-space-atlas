import { Credit, Rectangle, SingleTileImageryProvider } from 'cesium'

/** Kept as metadata for the earlier NASA-backed layer contract. */
export const NASA_GIBS_CLOUD_LAYER = 'MODIS_Terra_Cloud_Fraction_Day'
export const NASA_GIBS_CLOUD_OBSERVATION_DATE = '2026-08-16'
export const NASA_GIBS_CLOUD_SOURCE = 'Cinematic atmospheric cloud shell'

const CLOUD_MIN_BRIGHTNESS = 0.52
const CLOUD_MAX_SATURATION = 0.22
const CLOUD_MIN_FRACTION = 24
const CLOUD_FLOOR_ALPHA = 7
const CLOUD_TEXTURE_WIDTH = 1024
const CLOUD_TEXTURE_HEIGHT = 512

/** Extract a soft white cloud alpha from natural-color satellite pixels. */
export function cloudAlphaFromRgb(red: number, green: number, blue: number): number {
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const brightness = (red + green + blue) / (255 * 3)
  if (maximum < 100 || brightness < CLOUD_MIN_BRIGHTNESS) return 0
  const saturation = maximum === 0 ? 1 : (maximum - minimum) / maximum
  if (saturation > CLOUD_MAX_SATURATION) return 0
  const brightnessWeight = Math.min(1, Math.max(0, (brightness - CLOUD_MIN_BRIGHTNESS) / (1 - CLOUD_MIN_BRIGHTNESS)))
  const saturationWeight = Math.min(1, Math.max(0, (CLOUD_MAX_SATURATION - saturation) / CLOUD_MAX_SATURATION))
  return Math.round(brightnessWeight * saturationWeight * 0.55 * 255)
}

/** Preserve the published NASA GIBS palette helpers for catalog consumers. */
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

export function cloudAlphaFromFraction(fraction: number | null): number {
  if (fraction === null || fraction < CLOUD_MIN_FRACTION) return 0
  return Math.round((0.04 + ((fraction - CLOUD_MIN_FRACTION) / (100 - CLOUD_MIN_FRACTION)) * 0.45) * 255)
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value)
}

function seededNoise(column: number, row: number): number {
  const value = Math.sin(column * 127.1 + row * 311.7) * 43758.5453
  return value - Math.floor(value)
}

function gridNoise(x: number, y: number, columns: number, rows: number): number {
  const wrappedX = ((Math.floor(x) % columns) + columns) % columns
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(y)))
  const x1 = (wrappedX + 1) % columns
  const y1 = Math.min(rows - 1, y0 + 1)
  const tx = smoothstep(x - Math.floor(x))
  const ty = smoothstep(y - Math.floor(y))
  const top = seededNoise(wrappedX, y0) * (1 - tx) + seededNoise(x1, y0) * tx
  const bottom = seededNoise(wrappedX, y1) * (1 - tx) + seededNoise(x1, y1) * tx
  return top * (1 - ty) + bottom * ty
}

function proceduralCloudAlpha(x: number, y: number): number {
  const normalizedX = x / CLOUD_TEXTURE_WIDTH
  const normalizedY = y / CLOUD_TEXTURE_HEIGHT
  const warpX = gridNoise(normalizedX * 9, normalizedY * 5, 9, 5) - 0.5
  const warpY = gridNoise(normalizedX * 9 + 17, normalizedY * 5 + 11, 9, 5) - 0.5
  const warpedX = normalizedX + warpX * 0.1
  const warpedY = normalizedY + warpY * 0.06
  const broad = gridNoise(warpedX * 24, warpedY * 12, 24, 12)
  const medium = gridNoise(warpedX * 58, warpedY * 30, 58, 30)
  const detail = gridNoise(warpedX * 150, warpedY * 76, 150, 76)
  const fine = gridNoise(warpedX * 320, warpedY * 160, 320, 160)
  const coverage = broad * 0.46 + medium * 0.29 + detail * 0.17 + fine * 0.08
  const cloudShape = smoothstep(Math.max(0, Math.min(1, (coverage - 0.48) / 0.3)))
  const wispyDetail = smoothstep(Math.max(0, Math.min(1, (detail + fine * 0.5 - 0.42) / 0.38)))
  const latitude = y / CLOUD_TEXTURE_HEIGHT
  const bandWeight = 0.82 + 0.18 * Math.sin(latitude * Math.PI)
  return Math.round(cloudShape * (38 + wispyDetail * 84) * bandWeight)
}

function renderCloudImage(width: number, height: number): HTMLCanvasElement {
  const canvas = Object.assign(document.createElement('canvas'), { width, height })
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas
  const pixels = context.getImageData(0, 0, width, height)
  for (let index = 0; index < pixels.data.length; index += 4) {
    const pixel = index / 4
    const x = pixel % width
    const y = Math.floor(pixel / width)
    const alpha = Math.max(CLOUD_FLOOR_ALPHA, proceduralCloudAlpha(x, y))
    pixels.data[index] = 255
    pixels.data[index + 1] = 255
    pixels.data[index + 2] = 255
    pixels.data[index + 3] = alpha
  }
  context.putImageData(pixels, 0, 0)
  return canvas
}

/** Create a seamless cloud shell; the imagery provider keeps it synchronized with the globe. */
export async function createNasaCloudProvider(observationDate = NASA_GIBS_CLOUD_OBSERVATION_DATE): Promise<SingleTileImageryProvider> {
  void observationDate
  const canvas = renderCloudImage(CLOUD_TEXTURE_WIDTH, CLOUD_TEXTURE_HEIGHT)
  return SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
    rectangle: Rectangle.fromDegrees(-180, -90, 180, 90),
    credit: new Credit(NASA_GIBS_CLOUD_SOURCE),
  })
}
