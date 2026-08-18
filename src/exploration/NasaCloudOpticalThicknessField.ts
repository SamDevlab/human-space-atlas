export type CloudOpticalThicknessSampler = (longitudeDeg: number, latitudeDeg: number) => number | null

const NASA_GIBS_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const NASA_GIBS_CLOUD_OPTICAL_THICKNESS_LAYER = 'MODIS_Terra_Cloud_Optical_Thickness'
const NASA_GIBS_CLOUD_OPTICAL_THICKNESS_COLORMAP = 'https://gibs.earthdata.nasa.gov/colormaps/v1.0/MODIS_VIIRS_Cloud_Optical_Thickness.xml'
const FIELD_WIDTH = 1024
const FIELD_HEIGHT = 512

type CloudOpticalThicknessField = {
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

/** Decode the numeric midpoint represented by a GIBS ColorMapEntry value. */
export function parseOpticalThicknessRangeMidpoint(value: string | null): number | null {
  if (!value) return null
  const trimmed = value.trim()
  const range = trimmed.match(/^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*[\)\]]$/)
  if (range) return (Number(range[1]) + Number(range[2])) * 0.5
  const openRange = trimmed.match(/^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*\+?INF\s*[\)\]]$/i)
  if (openRange) return Number(openRange[1])
  const scalar = Number(trimmed)
  return Number.isFinite(scalar) ? scalar : null
}

export function opticalThicknessDensity(opticalThickness: number | null): number {
  if (opticalThickness === null || !Number.isFinite(opticalThickness) || opticalThickness <= 0) return 0
  // Optical thickness spans a large dynamic range. A logarithmic mapping keeps
  // thin cloud distinguishable while still giving deep convective systems a
  // visibly denser reconstruction without letting extreme values dominate.
  return clamp(Math.log1p(opticalThickness) / Math.log1p(80), 0, 1)
}

function parseColorMap(xml: string): Map<number, number> {
  const lookup = new Map<number, number>()
  if (typeof DOMParser === 'undefined') return lookup
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const entries = Array.from(document.querySelectorAll('ColorMapEntry'))
  for (const entry of entries) {
    if (entry.getAttribute('transparent') === 'true') continue
    const rgb = entry.getAttribute('rgb')?.split(',').map((part) => Number(part.trim()))
    if (!rgb || rgb.length !== 3 || rgb.some((component) => !Number.isFinite(component))) continue
    const thickness = parseOpticalThicknessRangeMidpoint(entry.getAttribute('value'))
    if (thickness === null) continue
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    lookup.set(key, thickness)
  }
  return lookup
}

function opticalThicknessMapUrl(observationDate: string): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: NASA_GIBS_CLOUD_OPTICAL_THICKNESS_LAYER,
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

async function loadCloudOpticalThicknessField(observationDate: string): Promise<CloudOpticalThicknessField> {
  const [mapResponse, colorMapResponse] = await Promise.all([
    fetch(opticalThicknessMapUrl(observationDate), { mode: 'cors' }),
    fetch(NASA_GIBS_CLOUD_OPTICAL_THICKNESS_COLORMAP, { mode: 'cors' }),
  ])
  if (!mapResponse.ok) throw new Error(`NASA cloud-optical-thickness layer unavailable (${mapResponse.status})`)
  if (!colorMapResponse.ok) throw new Error(`NASA cloud-optical-thickness colormap unavailable (${colorMapResponse.status})`)

  const lookup = parseColorMap(await colorMapResponse.text())
  if (lookup.size === 0) throw new Error('NASA cloud-optical-thickness colormap could not be decoded')

  const bitmap = await createImageBitmap(await mapResponse.blob())
  const canvas = Object.assign(document.createElement('canvas'), { width: FIELD_WIDTH, height: FIELD_HEIGHT })
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new Error('Cloud-optical-thickness canvas unavailable')
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
    const thickness = lookup.get(key)
    if (thickness !== undefined) values[pixel] = thickness
  }
  return { width: FIELD_WIDTH, height: FIELD_HEIGHT, values }
}

function createSampler(field: CloudOpticalThicknessField): CloudOpticalThicknessSampler {
  return (longitudeDeg, latitudeDeg) => {
    const longitude = wrapLongitude(longitudeDeg)
    const latitude = clamp(latitudeDeg, -89.999, 89.999)
    const x = clamp(Math.floor((longitude + 180) / 360 * field.width), 0, field.width - 1)
    const y = clamp(Math.floor((90 - latitude) / 180 * field.height), 0, field.height - 1)
    const value = field.values[y * field.width + x]
    return Number.isFinite(value) ? value : null
  }
}

const fieldPromises = new Map<string, Promise<CloudOpticalThicknessSampler | null>>()

/**
 * Loads NASA MODIS cloud optical thickness once per observation date. Failure
 * is non-fatal: coverage and cloud-top height continue to drive the cinematic
 * cloud field while density falls back to the coverage-based profile.
 */
export function preloadNasaCloudOpticalThicknessSampler(observationDate: string): Promise<CloudOpticalThicknessSampler | null> {
  const cached = fieldPromises.get(observationDate)
  if (cached) return cached
  const pending = loadCloudOpticalThicknessField(observationDate).then(createSampler).catch(() => null)
  fieldPromises.set(observationDate, pending)
  return pending
}
