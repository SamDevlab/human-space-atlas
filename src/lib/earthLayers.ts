import { Credit, Rectangle, SingleTileImageryProvider, WebMapServiceImageryProvider, WebMercatorTilingScheme } from 'cesium'

/** NASA GIBS MODIS Terra cloud-fraction product, not a land-color heuristic. */
export const NASA_GIBS_CLOUD_LAYER = 'MODIS_Terra_Cloud_Fraction_Day'
const NASA_GIBS_TRUE_COLOR_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor'
export const NASA_GIBS_CLOUD_OBSERVATION_DATE = '2026-08-16'
export const NASA_GIBS_CLOUD_SOURCE = 'MODIS Terra Cloud Fraction · NASA GIBS'
export const NASA_GIBS_NIGHT_LIGHTS_SOURCE = 'Luzes urbanas noturnas VIIRS · NASA'
const NASA_GIBS_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi'
const NASA_GIBS_CLOUD_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'

// Ignore very low confidence coverage. Keeping the low end transparent makes
// the layer read as separate cloud systems instead of a white global veil.
const CLOUD_MIN_FRACTION = 30
const CLOUD_FLOOR_ALPHA = 2
const CLOUD_TEXTURE_WIDTH = 1024
const CLOUD_TEXTURE_HEIGHT = 512
const CLOUD_EDGE_BLUR_PX = 6

/** Extract a soft alpha from NASA's published cloud-fraction color map. */
export function cloudAlphaFromRgb(red: number, green: number, blue: number): number {
  const fraction = cloudFractionFromRgb(red, green, blue)
  if (fraction === null || fraction < CLOUD_MIN_FRACTION) return 0
  const coverage = Math.min(1, Math.max(0, (fraction - CLOUD_MIN_FRACTION) / (100 - CLOUD_MIN_FRACTION)))
  const featheredCoverage = coverage * coverage * (3 - 2 * coverage)
  return Math.round((0.018 + featheredCoverage * 0.68) * 255)
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
  return Math.round((0.012 + ((fraction - CLOUD_MIN_FRACTION) / (100 - CLOUD_MIN_FRACTION)) * 0.34) * 255)
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
  // Keep broad systems readable from low orbit, then let the higher
  // frequencies carve softer edges into them. The previous threshold made
  // most of the shell effectively transparent in Explore mode.
  const cloudShape = smoothstep(Math.max(0, Math.min(1, (coverage - 0.39) / 0.23)))
  const wispyDetail = smoothstep(Math.max(0, Math.min(1, (detail + fine * 0.5 - 0.38) / 0.34)))
  const latitude = y / CLOUD_TEXTURE_HEIGHT
  const bandWeight = 0.82 + 0.18 * Math.sin(latitude * Math.PI)
  return Math.round(cloudShape * (72 + wispyDetail * 168) * bandWeight)
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

/**
 * Feather the satellite mask before it reaches Cesium's elevated shell.
 * GIBS imagery is sampled on a regular grid; without this pass the grid is
 * readable as square cloud plates when the camera is close to the surface.
 * The three-tile draw also keeps the longitude seam continuous.
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

/** Shared texture for the mapped layer and the low-orbit cloud shell. */
export function createNasaCloudTexture(): HTMLCanvasElement {
  return softenCloudTexture(renderCloudImage(CLOUD_TEXTURE_WIDTH, CLOUD_TEXTURE_HEIGHT))
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
export async function createNasaCloudTextureFromApi(observationDate = cloudObservationDate()): Promise<HTMLCanvasElement> {
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
    const red = trueColorPixels.data[index]
    const green = trueColorPixels.data[index + 1]
    const blue = trueColorPixels.data[index + 2]
    const brightness = (red + green + blue) / (255 * 3)
    const trueColorMax = Math.max(red, green, blue)
    const saturation = (trueColorMax - Math.min(red, green, blue)) / Math.max(trueColorMax, 1)
    const brightCloud = smoothstep(Math.min(1, Math.max(0, (brightness - 0.48) / 0.28)))
    const lowSaturation = smoothstep(Math.min(1, Math.max(0, (0.5 - saturation) / 0.32)))
    // Clouds are bright and comparatively desaturated in the true-colour
    // composite; using the product of both signals rejects blue ocean haze.
    const trueColorDetail = brightCloud * lowSaturation
    // Require a clear bright/desaturated signal from the true-colour image;
    // the coverage product alone is too broad and would read as blue haze.
    const detail = smoothstep(Math.min(1, Math.max(0, (trueColorDetail - 0.18) / 0.48)))
    const noData = red + green + blue < 42
    const alpha = noData ? 0 : Math.min(255, Math.round(realAlpha * detail * 1.45))
    // Render the observed formations as soft white cloud volume. The NASA
    // coverage mask supplies their location; the true-colour signal only
    // controls edge density so oceans do not become a blue veil.
    pixels.data[index] = 255
    pixels.data[index + 1] = 255
    pixels.data[index + 2] = 255
    pixels.data[index + 3] = alpha
  }
  context.putImageData(pixels, 0, 0)
  return softenCloudTexture(canvas)
}

/** Create a soft, transparent and slightly varied sprite used for low-orbit cloud banks. */
export function createCloudBillboardTexture(seed = 0): HTMLCanvasElement {
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 })
  const context = canvas.getContext('2d')
  if (!context) return canvas

  const random = (index: number) => {
    const value = Math.sin((seed + 1) * 97.13 + index * 41.71) * 43758.5453
    return value - Math.floor(value)
  }
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.filter = 'blur(1.6px)'
  for (let index = 0; index < 16; index += 1) {
    const x = 34 + random(index * 4) * 252
    const y = 52 + random(index * 4 + 1) * 78
    const radiusX = 20 + random(index * 4 + 2) * 34
    const radiusY = 11 + random(index * 4 + 3) * 20
    context.save()
    context.translate(x, y)
    context.scale(1, radiusY / radiusX)
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusX)
    const opacity = 0.24 + random(index * 4 + 4) * 0.42
    gradient.addColorStop(0, `rgba(255, 255, 255, ${opacity.toFixed(3)})`)
    gradient.addColorStop(0.46, `rgba(242, 250, 255, ${(opacity * 0.68).toFixed(3)})`)
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
    context.fillStyle = gradient
    context.beginPath()
    context.arc(0, 0, radiusX, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }
  context.filter = 'none'
  return canvas
}

/** A soft cloud-bank sprite that remains legible from low orbit. */
export function createCloudBillboardSvg(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">
    <defs>
      <filter id="soft" x="-20%" y="-35%" width="140%" height="170%"><feGaussianBlur stdDeviation="6"/></filter>
      <radialGradient id="cloud" cx="50%" cy="48%" r="55%">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.92"/>
        <stop offset="0.55" stop-color="#eaf7ff" stop-opacity="0.62"/>
        <stop offset="1" stop-color="#d8eff8" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <g fill="url(#cloud)" filter="url(#soft)">
      <ellipse cx="44" cy="88" rx="48" ry="30"/>
      <ellipse cx="86" cy="65" rx="58" ry="40"/>
      <ellipse cx="139" cy="80" rx="56" ry="38"/>
      <ellipse cx="193" cy="56" rx="50" ry="34"/>
      <ellipse cx="242" cy="78" rx="62" ry="40"/>
      <ellipse cx="285" cy="91" rx="42" ry="27"/>
      <ellipse cx="130" cy="111" rx="74" ry="24"/>
      <ellipse cx="231" cy="112" rx="74" ry="24"/>
    </g>
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Create a seamless cloud shell; the imagery provider keeps it synchronized with the globe. */
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
