import { Credit, Rectangle, SingleTileImageryProvider, WebMapServiceImageryProvider, WebMercatorTilingScheme } from 'cesium'

/** NASA GIBS MODIS Terra cloud-fraction product, not a land-color heuristic. */
export const NASA_GIBS_CLOUD_LAYER = 'MODIS_Terra_Cloud_Fraction_Day'
const NASA_GIBS_TRUE_COLOR_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor'
export const NASA_GIBS_CLOUD_OBSERVATION_DATE = '2026-08-16'
export const NASA_GIBS_CLOUD_SOURCE = 'MODIS Terra Cloud Fraction · NASA GIBS'
export const NASA_GIBS_NIGHT_LIGHTS_SOURCE = 'Luzes urbanas noturnas VIIRS · NASA'
const NASA_GIBS_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi'
const NASA_GIBS_CLOUD_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'

// Low cloud-fraction values are useful scientifically, but turning all of
// them into visible white alpha made the Atlas layer read as a global haze.
// Keep the observed field authoritative while only visualising formations
// strong enough to read as discrete systems from orbit.
const CLOUD_MIN_FRACTION = 42
const CLOUD_FLOOR_ALPHA = 0
const CLOUD_TEXTURE_WIDTH = 2048
const CLOUD_TEXTURE_HEIGHT = 1024
const CLOUD_EDGE_BLUR_PX = 1.25
// Bump the cache whenever the visual extraction changes. Otherwise browsers
// can keep showing the older fog-like texture for days after a deployment.
const CLOUD_CACHE_NAME = 'human-space-atlas-cloud-textures-v2'

const CLOUD_PALETTE_TOLERANCE = 8
const near = (actual: number, expected: number) => Math.abs(actual - expected) <= CLOUD_PALETTE_TOLERANCE

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Extract a structured alpha from NASA's published cloud-fraction color map. */
export function cloudAlphaFromRgb(red: number, green: number, blue: number): number {
  const fraction = cloudFractionFromRgb(red, green, blue)
  if (fraction === null || fraction < CLOUD_MIN_FRACTION) return 0
  const coverage = clamp01((fraction - CLOUD_MIN_FRACTION) / (100 - CLOUD_MIN_FRACTION))
  const featheredCoverage = smoothstep(coverage)
  // High-confidence formations get enough opacity to read as cloud systems,
  // while the low end stays transparent instead of becoming a white veil.
  return Math.round((0.012 + Math.pow(featheredCoverage, 1.12) * 0.76) * 255)
}

/** Preserve the published NASA GIBS palette helpers for catalog consumers. */
export function cloudFractionFromRgb(red: number, green: number, blue: number): number | null {
  if (near(red, 192) && near(green, 192) && near(blue, 192)) return null
  if (near(red, 102) && near(blue, 119)) return green
  if (near(red, 183) && near(blue, 141)) return 6 + green - 15
  if (near(red, 0) && near(blue, 100)) return 12 + green
  if (near(red, 0) && near(blue, 170)) return 19 + green
  if (near(red, 0) && near(blue, 255)) return 25 + green
  if (near(green, 136) && near(blue, 238)) return 31 + red
  if (near(green, 80) && near(blue, 0)) return 38 + red
  if (near(green, 136) && near(blue, 0)) return 44 + red
  if (near(green, 220) && near(blue, 0)) return 50 + red
  if (near(red, 255) && near(green, 255)) return 57 + blue
  if (near(red, 240) && near(green, 190)) return 63 + blue - 64
  if (near(red, 187) && near(green, 136)) return 69 + blue
  if (near(red, 122) && near(green, 90)) return 76 + blue - 3
  if (near(red, 110) && near(green, 0)) return 82 + blue
  if (near(red, 170) && near(green, 0)) return 88 + blue
  if (near(red, 255) && near(green, 0)) return 95 + blue
  return null
}

export function cloudAlphaFromFraction(fraction: number | null): number {
  if (fraction === null || fraction < CLOUD_MIN_FRACTION) return 0
  const coverage = clamp01((fraction - CLOUD_MIN_FRACTION) / (100 - CLOUD_MIN_FRACTION))
  return Math.round(Math.pow(smoothstep(coverage), 1.08) * 0.72 * 255)
}

function smoothstep(value: number): number {
  const clamped = clamp01(value)
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * Convert the NASA coverage alpha plus the same-day true-colour observation
 * into a neutral cloud pixel for the Atlas view. The coverage product decides
 * where clouds exist; true colour only provides internal light/dark structure.
 */
export function atlasCloudVisualFromSignals(realAlpha: number, red: number, green: number, blue: number): [number, number, number, number] {
  if (realAlpha <= 0 || red + green + blue < 42) return [255, 255, 255, 0]

  const brightness = (red + green + blue) / (255 * 3)
  const trueColorMax = Math.max(red, green, blue)
  const saturation = (trueColorMax - Math.min(red, green, blue)) / Math.max(trueColorMax, 1)
  const brightCloud = smoothstep((brightness - 0.42) / 0.34)
  const lowSaturation = smoothstep((0.58 - saturation) / 0.4)
  const detail = clamp01(brightCloud * lowSaturation)
  const coverage = realAlpha / 255

  // Preserve some observed luminance variation so large weather systems have
  // visible cores and filaments instead of becoming one flat white fog layer.
  const tone = Math.round(Math.min(255, Math.max(184, 190 + brightness * 34 + detail * 40)))
  const alpha = Math.round(clamp01(coverage * (0.34 + detail * 0.66)) * 255)
  return [tone, Math.min(255, tone + 2), Math.min(255, tone + 7), alpha]
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
  // The fallback is intentionally sparse. It is only visible while the NASA
  // observation downloads, so it should never cover the planet like fog.
  const cloudShape = smoothstep((coverage - 0.5) / 0.17)
  const wispyDetail = smoothstep((detail + fine * 0.5 - 0.45) / 0.29)
  const latitude = y / CLOUD_TEXTURE_HEIGHT
  const bandWeight = 0.8 + 0.2 * Math.sin(latitude * Math.PI)
  return Math.round(cloudShape * (12 + wispyDetail * 150) * bandWeight)
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
    pixels.data[index] = 238
    pixels.data[index + 1] = 244
    pixels.data[index + 2] = 250
    pixels.data[index + 3] = alpha
  }
  context.putImageData(pixels, 0, 0)
  return canvas
}

/**
 * Feather only the pixel-scale edge stair-stepping from the source grid.
 * A large blur radius turns distinct cloud systems into atmospheric haze.
 * The three-tile draw keeps the longitude seam continuous.
 */
function softenCloudTexture(source: HTMLCanvasElement, blurRadius = CLOUD_EDGE_BLUR_PX): HTMLCanvasElement {
  if (source.width <= 0 || source.height <= 0) return source
  const expanded = document.createElement('canvas')
  expanded.width = source.width * 3
  expanded.height = source.height
  const expandedContext = expanded.getContext('2d')
  if (!expandedContext) return source
  expandedContext.clearRect(0, 0, expanded.width, expanded.height)
  expandedContext.filter = `blur(${blurRadius}px)`
  expandedContext.drawImage(source, 0, 0)
  expandedContext.drawImage(source, source.width, 0)
  expandedContext.drawImage(source, source.width * 2, 0)
  expandedContext.filter = 'none'
  const softened = document.createElement('canvas')
  softened.width = source.width
  softened.height = source.height
  const softenedContext = softened.getContext('2d')
  if (!softenedContext) return source
  softenedContext.drawImage(expanded, source.width, 0, source.width, source.height, 0, 0, source.width, source.height)
  return softened
}

/** Shared fallback texture for the mapped layer and low-orbit cloud systems. */
export function createNasaCloudTexture(): HTMLCanvasElement {
  return softenCloudTexture(renderCloudImage(CLOUD_TEXTURE_WIDTH, CLOUD_TEXTURE_HEIGHT))
}

function cloudCacheKey(observationDate: string): string {
  const origin = typeof window === 'undefined' ? 'https://human-space-atlas.invalid' : window.location.origin
  return `${origin}/__hsa-cloud-cache/${observationDate}/${CLOUD_TEXTURE_WIDTH}x${CLOUD_TEXTURE_HEIGHT}.png`
}

async function canvasFromBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const canvas = Object.assign(document.createElement('canvas'), { width: CLOUD_TEXTURE_WIDTH, height: CLOUD_TEXTURE_HEIGHT })
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error('Cloud cache canvas unavailable')
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

async function readCachedCloudTexture(observationDate: string): Promise<HTMLCanvasElement | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(CLOUD_CACHE_NAME)
    const response = await cache.match(cloudCacheKey(observationDate))
    return response ? await canvasFromBlob(await response.blob()) : null
  } catch {
    return null
  }
}

async function writeCachedCloudTexture(observationDate: string, canvas: HTMLCanvasElement): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const blob = await canvasBlob(canvas)
    if (!blob) return
    const cache = await caches.open(CLOUD_CACHE_NAME)
    await cache.put(cloudCacheKey(observationDate), new Response(blob, { headers: { 'Content-Type': 'image/png' } }))
  } catch {
    // Private browsing and storage quotas can disable CacheStorage. The
    // in-memory promise below still prevents duplicate work in this session.
  }
}

function cloudObservationDate(): string {
  // GIBS products can arrive a day after acquisition; request a recent stable
  // composite instead of tying the visual layer to the simulated clock.
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
}

function cloudMapUrl(observationDate = cloudObservationDate()): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: NASA_GIBS_CLOUD_LAYER,
    STYLES: 'default',
    SRS: 'EPSG:4326',
    BBOX: '-180,-90,180,90',
    WIDTH: String(CLOUD_TEXTURE_WIDTH),
    HEIGHT: String(CLOUD_TEXTURE_HEIGHT),
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    TIME: observationDate,
  })
  return `${NASA_GIBS_CLOUD_WMS_URL}?${params.toString()}`
}

function trueColorMapUrl(observationDate = cloudObservationDate()): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: NASA_GIBS_TRUE_COLOR_LAYER,
    STYLES: 'default',
    SRS: 'EPSG:4326',
    BBOX: '-180,-90,180,90',
    WIDTH: String(CLOUD_TEXTURE_WIDTH),
    HEIGHT: String(CLOUD_TEXTURE_HEIGHT),
    FORMAT: 'image/jpeg',
    TRANSPARENT: 'FALSE',
    TIME: observationDate,
  })
  return `${NASA_GIBS_CLOUD_WMS_URL}?${params.toString()}`
}

/** Combine NASA's observed coverage with its true-color satellite texture. */
async function loadNasaCloudTextureFromApi(observationDate: string): Promise<HTMLCanvasElement> {
  const cached = await readCachedCloudTexture(observationDate)
  if (cached) return cached
  const [coverageResponse, trueColorResponse] = await Promise.all([
    fetch(cloudMapUrl(observationDate), { mode: 'cors' }),
    fetch(trueColorMapUrl(observationDate), { mode: 'cors' }),
  ])
  if (!coverageResponse.ok) throw new Error(`NASA cloud layer unavailable (${coverageResponse.status})`)
  if (!trueColorResponse.ok) throw new Error(`NASA true-color layer unavailable (${trueColorResponse.status})`)
  const [coverageBitmap, trueColorBitmap] = await Promise.all([
    createImageBitmap(await coverageResponse.blob()),
    createImageBitmap(await trueColorResponse.blob()),
  ])
  const canvas = Object.assign(document.createElement('canvas'), { width: CLOUD_TEXTURE_WIDTH, height: CLOUD_TEXTURE_HEIGHT })
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Cloud texture canvas unavailable')
  const trueColorCanvas = Object.assign(document.createElement('canvas'), { width: CLOUD_TEXTURE_WIDTH, height: CLOUD_TEXTURE_HEIGHT })
  const trueColorContext = trueColorCanvas.getContext('2d', { willReadFrequently: true })
  if (!trueColorContext) throw new Error('True-color cloud texture canvas unavailable')
  context.drawImage(coverageBitmap, 0, 0, canvas.width, canvas.height)
  trueColorContext.drawImage(trueColorBitmap, 0, 0, canvas.width, canvas.height)
  coverageBitmap.close()
  trueColorBitmap.close()
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const trueColorPixels = trueColorContext.getImageData(0, 0, canvas.width, canvas.height)
  for (let index = 0; index < pixels.data.length; index += 4) {
    const realAlpha = cloudAlphaFromRgb(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2])
    const [red, green, blue, alpha] = atlasCloudVisualFromSignals(
      realAlpha,
      trueColorPixels.data[index],
      trueColorPixels.data[index + 1],
      trueColorPixels.data[index + 2],
    )
    pixels.data[index] = red
    pixels.data[index + 1] = green
    pixels.data[index + 2] = blue
    pixels.data[index + 3] = alpha
  }
  context.putImageData(pixels, 0, 0)
  const softened = softenCloudTexture(canvas)
  void writeCachedCloudTexture(observationDate, softened)
  return softened
}

const cloudTexturePromises = new Map<string, Promise<HTMLCanvasElement>>()

/** Start the daily cloud download early and reuse it across globe remounts. */
export function preloadNasaCloudTexture(observationDate = cloudObservationDate()): Promise<HTMLCanvasElement> {
  const cached = cloudTexturePromises.get(observationDate)
  if (cached) return cached
  const pending = loadNasaCloudTextureFromApi(observationDate)
  cloudTexturePromises.set(observationDate, pending)
  pending.catch(() => cloudTexturePromises.delete(observationDate))
  return pending
}

export function createNasaCloudTextureFromApi(observationDate = cloudObservationDate()): Promise<HTMLCanvasElement> {
  return preloadNasaCloudTexture(observationDate)
}

/** Create the mapped NASA cloud layer; the same field seeds Explore volumes. */
export async function createNasaCloudProvider(observationDate = NASA_GIBS_CLOUD_OBSERVATION_DATE, texture?: HTMLCanvasElement): Promise<SingleTileImageryProvider> {
  const canvas = texture ?? await createNasaCloudTextureFromApi(observationDate)
  return SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
    rectangle: Rectangle.fromDegrees(-180, -90, 180, 90),
    credit: new Credit(NASA_GIBS_CLOUD_SOURCE),
  })
}

/** Real global night-light radiance layer. Black fill pixels are removed by the globe layer. */
export function createNasaNightLightsProvider(): WebMapServiceImageryProvider {
  return new WebMapServiceImageryProvider({
    url: NASA_GIBS_WMS_URL,
    layers: 'VIIRS_SNPP_DayNightBand_ENCC',
    tilingScheme: new WebMercatorTilingScheme(),
    crs: 'EPSG:3857',
    enablePickFeatures: false,
    rectangle: Rectangle.fromDegrees(-180, -80, 180, 80),
    parameters: {
      transparent: 'true',
      format: 'image/png',
      version: '1.3.0',
      styles: 'default',
    },
    credit: new Credit(NASA_GIBS_NIGHT_LIGHTS_SOURCE),
  })
}