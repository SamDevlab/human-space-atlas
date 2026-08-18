export type CloudTopHeightSampler = (longitudeDeg: number, latitudeDeg: number) => number | null

const NASA_GIBS_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const NASA_GIBS_CLOUD_TOP_HEIGHT_LAYER = 'MODIS_Terra_Cloud_Top_Height_Day'
const NASA_GIBS_CLOUD_TOP_HEIGHT_COLORMAP = 'https://gibs.earthdata.nasa.gov/colormaps/v1.0/MODIS_VIIRS_Cloud_Top_Height.xml'
const FIELD_WIDTH = 1024
const FIELD_HEIGHT = 512

type CloudTopField = {
  width: number
  height: number
  values: Float32Array
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function wrapLongitude(longitudeDeg: number): number {
  return ((longitudeDeg + 180) % 360 + 360) % 360 - 180
}

export function parseCloudTopHeightRangeMidpoint(value: string | null): number | null {
  if (!value) return null
  const finiteRange = value.match(/^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/)
  if (finiteRange) return (Number(finiteRange[1]) + Number(finiteRange[2])) * 0.5
  const openRange = value.match(/^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*\+INF\s*\)$/i)
  if (openRange) return Number(openRange[1]) + 250
  const scalar = Number(value)
  return Number.isFinite(scalar) ? scalar : null
}

export function parseCloudTopHeightColorMap(xml: string): Map<number, number> {
  const lookup = new Map<number, number>()
  if (typeof DOMParser === 'undefined') return lookup
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const entries = Array.from(document.querySelectorAll('ColorMapEntry'))
  for (const entry of entries) {
    if (entry.getAttribute('transparent') === 'true') continue
    const rgb = entry.getAttribute('rgb')?.split(',').map((part) => Number(part.trim()))
    if (!rgb || rgb.length !== 3 || rgb.some((value) => !Number.isFinite(value))) continue
    const meters = parseCloudTopHeightRangeMidpoint(entry.getAttribute('value'))
    if (meters === null) continue
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    lookup.set(key, meters)
  }
  return lookup
}

function cloudTopHeightMapUrl(observationDate: string): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: NASA_GIBS_CLOUD_TOP_HEIGHT_LAYER,
    STYLES: 'default',
    SRS: 'EPSG:4326',
    BBOX: '-180,-90,180,90',
    WIDTH: String(FIELD_WIDTH),
    HEIGHT: String(FIELD_HEIGHT),
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    TIME: observationDate,
  })
  return `${NASA_GIBS_WMS_URL}?${params.toString()}`
}

async function loadCloudTopField(observationDate: string): Promise<CloudTopField> {
  const [mapResponse, colorMapResponse] = await Promise.all([
    fetch(cloudTopHeightMapUrl(observationDate), { mode: 'cors' }),
    fetch(NASA_GIBS_CLOUD_TOP_HEIGHT_COLORMAP, { mode: 'cors' }),
  ])
  if (!mapResponse.ok) throw new Error(`NASA cloud-top-height layer unavailable (${mapResponse.status})`)
  if (!colorMapResponse.ok) throw new Error(`NASA cloud-top-height colormap unavailable (${colorMapResponse.status})`)

  const lookup = parseCloudTopHeightColorMap(await colorMapResponse.text())
  if (lookup.size === 0) throw new Error('NASA cloud-top-height colormap could not be decoded')

  const bitmap = await createImageBitmap(await mapResponse.blob())
  const canvas = Object.assign(document.createElement('canvas'), { width: FIELD_WIDTH, height: FIELD_HEIGHT })
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new Error('Cloud-top-height canvas unavailable')
  }
  context.drawImage(bitmap, 0, 0, FIELD_WIDTH, FIELD_HEIGHT)
  bitmap.close()

  const pixels = context.getImageData(0, 0, FIELD_WIDTH, FIELD_HEIGHT).data
  const values = new Float32Array(FIELD_WIDTH * FIELD_HEIGHT)
  values.fill(Number.NaN)
  for (let pixel = 0; pixel < values.length; pixel += 1) {
    const offset = pixel * 4
    if (pixels[offset + 3] === 0) continue
    const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]
    const meters = lookup.get(key)
    if (meters !== undefined) values[pixel] = meters
  }
  return { width: FIELD_WIDTH, height: FIELD_HEIGHT, values }
}

function createSampler(field: CloudTopField): CloudTopHeightSampler {
  return (longitudeDeg, latitudeDeg) => {
    const longitude = wrapLongitude(longitudeDeg)
    const latitude = clamp(latitudeDeg, -89.999, 89.999)
    const x = clamp(Math.floor((longitude + 180) / 360 * field.width), 0, field.width - 1)
    const y = clamp(Math.floor((90 - latitude) / 180 * field.height), 0, field.height - 1)
    const value = field.values[y * field.width + x]
    return Number.isFinite(value) ? value : null
  }
}

const fieldPromises = new Map<string, Promise<CloudTopHeightSampler | null>>()

/**
 * Loads the daily NASA MODIS cloud-top-height field once per observation date.
 * Failure is intentionally non-fatal: Explore falls back to its procedural
 * vertical profile while keeping NASA cloud coverage authoritative.
 */
export function preloadNasaCloudTopHeightSampler(observationDate: string): Promise<CloudTopHeightSampler | null> {
  const cached = fieldPromises.get(observationDate)
  if (cached) return cached
  const pending = loadCloudTopField(observationDate).then(createSampler).catch(() => null)
  fieldPromises.set(observationDate, pending)
  return pending
}
