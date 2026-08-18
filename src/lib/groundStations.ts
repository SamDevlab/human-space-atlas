export type GroundStation = {
  id: string
  name: string
  network: 'NASA DSN' | 'ESA ESTRACK'
  latitudeDeg: number
  longitudeDeg: number
  altitudeMeters: number
  role: 'deep-space' | 'near-earth'
  sourceLabel: string
}

/**
 * Curated public tracking sites used as observer presets. Coordinates are
 * intentionally rounded to mapping precision; this is not an antenna-pointing
 * or RF link-budget database.
 */
export const GROUND_STATIONS: GroundStation[] = [
  { id: 'dsn-goldstone', name: 'Goldstone', network: 'NASA DSN', latitudeDeg: 35.4267, longitudeDeg: -116.89, altitudeMeters: 1000, role: 'deep-space', sourceLabel: 'NASA/JPL DSN' },
  { id: 'dsn-madrid', name: 'Madrid', network: 'NASA DSN', latitudeDeg: 40.4314, longitudeDeg: -4.2486, altitudeMeters: 730, role: 'deep-space', sourceLabel: 'NASA/JPL DSN' },
  { id: 'dsn-canberra', name: 'Canberra', network: 'NASA DSN', latitudeDeg: -35.3983, longitudeDeg: 148.9819, altitudeMeters: 690, role: 'deep-space', sourceLabel: 'NASA/JPL DSN' },
  { id: 'esa-new-norcia', name: 'New Norcia', network: 'ESA ESTRACK', latitudeDeg: -31.0482, longitudeDeg: 116.191, altitudeMeters: 252, role: 'deep-space', sourceLabel: 'ESA ESTRACK' },
  { id: 'esa-cebreros', name: 'Cebreros', network: 'ESA ESTRACK', latitudeDeg: 40.4527, longitudeDeg: -4.3675, altitudeMeters: 794, role: 'deep-space', sourceLabel: 'ESA ESTRACK' },
  { id: 'esa-malargue', name: 'Malargüe', network: 'ESA ESTRACK', latitudeDeg: -35.776, longitudeDeg: -69.398, altitudeMeters: 1550, role: 'deep-space', sourceLabel: 'ESA ESTRACK' },
  { id: 'esa-kiruna', name: 'Kiruna', network: 'ESA ESTRACK', latitudeDeg: 67.8571, longitudeDeg: 20.9643, altitudeMeters: 410, role: 'near-earth', sourceLabel: 'ESA ESTRACK' },
  { id: 'esa-kourou', name: 'Kourou', network: 'ESA ESTRACK', latitudeDeg: 5.2514, longitudeDeg: -52.8047, altitudeMeters: 18, role: 'near-earth', sourceLabel: 'ESA ESTRACK' },
  { id: 'esa-santa-maria', name: 'Santa Maria', network: 'ESA ESTRACK', latitudeDeg: 36.997, longitudeDeg: -25.136, altitudeMeters: 200, role: 'near-earth', sourceLabel: 'ESA ESTRACK' },
]
