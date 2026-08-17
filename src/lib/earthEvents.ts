export interface RawEarthEventGeometry {
  date?: string
  type?: string
  coordinates?: unknown
  magnitudeValue?: number
  magnitudeUnit?: string
}

export interface RawEarthEvent {
  id: string
  title: string
  description?: string
  link?: string
  categories?: Array<{ id: string; title: string }>
  sources?: Array<{ id: string; url: string }>
  geometry?: RawEarthEventGeometry[]
  geometries?: RawEarthEventGeometry[]
}

export type EarthEventGeometry =
  | { type: 'Point'; coordinates: [number, number]; date: string | null }
  | { type: 'Polygon'; coordinates: Array<[number, number]>; date: string | null }

export interface EarthEvent {
  id: string
  title: string
  description: string | null
  link: string | null
  categoryId: string
  categoryTitle: string
  source: string | null
  magnitudeValue: number | null
  magnitudeUnit: string | null
  geometry: EarthEventGeometry
}

export const EARTH_EVENT_CATEGORIES = [
  { id: 'severeStorms', label: 'Tempestades severas' },
  { id: 'wildfires', label: 'Incêndios' },
  { id: 'floods', label: 'Inundações' },
  { id: 'drought', label: 'Secas' },
  { id: 'dustHaze', label: 'Poeira / neblina' },
  { id: 'tempExtremes', label: 'Temperaturas extremas' },
  { id: 'snow', label: 'Neve / gelo' },
  { id: 'volcanoes', label: 'Vulcões' },
  { id: 'earthquakes', label: 'Terremotos' },
  { id: 'landslides', label: 'Deslizamentos' },
] as const

function pointCoordinates(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number') return null
  return [value[0], value[1]]
}

function polygonCoordinates(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value)) return null
  const ring = Array.isArray(value[0]?.[0]) ? value[0] : value
  const points = ring.map((point: unknown) => pointCoordinates(point)).filter((point: [number, number] | null): point is [number, number] => point !== null)
  return points.length >= 3 ? points : null
}

export function normalizeEarthEvents(rawEvents: RawEarthEvent[]): EarthEvent[] {
  return rawEvents.flatMap((event) => {
    const geometry = [...(event.geometry ?? event.geometries ?? [])].reverse().find((item) => item.type === 'Point' || item.type === 'Polygon')
    if (!geometry) return []
    const category = event.categories?.[0]
    const categoryDefinition = EARTH_EVENT_CATEGORIES.find((item) => item.id === category?.id)
    const point = geometry.type === 'Point' ? pointCoordinates(geometry.coordinates) : null
    const polygon = geometry.type === 'Polygon' ? polygonCoordinates(geometry.coordinates) : null
    if (!point && !polygon) return []
    return [{
      id: event.id,
      title: event.title,
      description: event.description ?? null,
      link: event.link ?? null,
      categoryId: category?.id ?? 'other',
      categoryTitle: categoryDefinition?.label ?? category?.title ?? 'Outro',
      source: event.sources?.[0]?.id ?? null,
      magnitudeValue: typeof geometry.magnitudeValue === 'number' ? geometry.magnitudeValue : null,
      magnitudeUnit: geometry.magnitudeUnit ?? null,
      geometry: point
        ? { type: 'Point' as const, coordinates: point, date: geometry.date ?? null }
        : { type: 'Polygon' as const, coordinates: polygon!, date: geometry.date ?? null },
    }]
  })
}

export function eventColor(categoryId: string): string {
  if (categoryId === 'severeStorms') return '#93a5ff'
  if (categoryId === 'wildfires') return '#ffb15c'
  if (categoryId === 'floods') return '#6dd7ff'
  if (categoryId === 'volcanoes') return '#ff7e55'
  return '#d1d9e8'
}
