export interface AircraftState {
  icao24: string
  callsign: string | null
  originCountry: string | null
  longitudeDeg: number
  latitudeDeg: number
  altitudeMeters: number
  velocityMetersPerSecond: number
  trueTrackDeg: number | null
  verticalRateMetersPerSecond: number
  lastContact: number
  category: number | null
}

export interface AircraftResponse {
  source: 'opensky'
  fetchedAt: string
  cache: 'hit' | 'miss'
  states: AircraftState[]
}

type OpenSkyStateVector = Array<unknown>

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeState(vector: OpenSkyStateVector): AircraftState | null {
  const icao24 = typeof vector[0] === 'string' ? vector[0].trim().toLowerCase() : ''
  const longitudeDeg = vector[5]
  const latitudeDeg = vector[6]
  const barometricAltitudeMeters = vector[7]
  const geometricAltitudeMeters = vector[13]
  const onGround = vector[8] === true
  const velocityMetersPerSecond = vector[9]
  const trueTrackDeg = vector[10]
  const verticalRateMetersPerSecond = vector[11]
  const lastContact = vector[4]
  const altitudeMeters = finiteNumber(geometricAltitudeMeters) ? geometricAltitudeMeters : barometricAltitudeMeters

  if (!icao24 || !finiteNumber(longitudeDeg) || !finiteNumber(latitudeDeg) || !finiteNumber(altitudeMeters)) return null
  if (onGround || altitudeMeters < 500 || altitudeMeters > 20_000) return null
  if (!finiteNumber(velocityMetersPerSecond) || velocityMetersPerSecond < 20) return null
  if (!finiteNumber(lastContact)) return null

  return {
    icao24,
    callsign: typeof vector[1] === 'string' ? vector[1].trim() || null : null,
    originCountry: typeof vector[2] === 'string' ? vector[2] : null,
    longitudeDeg,
    latitudeDeg,
    altitudeMeters,
    velocityMetersPerSecond,
    trueTrackDeg: finiteNumber(trueTrackDeg) ? trueTrackDeg : null,
    verticalRateMetersPerSecond: finiteNumber(verticalRateMetersPerSecond) ? verticalRateMetersPerSecond : 0,
    lastContact,
    category: finiteNumber(vector[17]) ? vector[17] : null,
  }
}

export function normalizeAircraftStates(payload: unknown, limit = 180): AircraftState[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { states?: unknown }).states)) return []
  const states = (payload as { states: unknown[] }).states
    .filter((state): state is OpenSkyStateVector => Array.isArray(state))
    .map(normalizeState)
    .filter((state): state is AircraftState => state !== null)
    .sort((a, b) => b.altitudeMeters - a.altitudeMeters)
  return states.slice(0, Math.max(1, Math.min(500, Math.floor(limit))))
}
