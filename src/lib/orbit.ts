import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
} from 'satellite.js'
import type { OmmRecord, OrbitState } from './types'

export type Satrec = ReturnType<typeof json2satrec>

const REQUIRED_NUMERIC_FIELDS = [
  'NORAD_CAT_ID', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
] as const

export function validateOmmRecord(omm: OmmRecord): void {
  if (!omm || typeof omm !== 'object' || typeof omm.OBJECT_NAME !== 'string' || !omm.OBJECT_NAME.trim()) {
    throw new Error('Invalid OMM record: OBJECT_NAME is required')
  }
  if (!omm.EPOCH || Number.isNaN(Date.parse(omm.EPOCH))) {
    throw new Error('Invalid OMM record: EPOCH must be an ISO timestamp')
  }
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    if (typeof omm[field] !== 'number' || !Number.isFinite(omm[field])) {
      throw new Error(`Invalid OMM record: ${field} must be finite`)
    }
  }
  if (omm.MEAN_MOTION <= 0 || omm.ECCENTRICITY < 0 || omm.ECCENTRICITY >= 1) {
    throw new Error('Invalid OMM record: orbital elements are out of range')
  }
}

export function normalizeLongitude(longitudeDeg: number): number {
  return ((longitudeDeg + 180) % 360 + 360) % 360 - 180
}

export function toCesiumHeightMeters(altitudeKm: number): number {
  return altitudeKm * 1000
}

export function createSatrec(omm: OmmRecord): Satrec {
  validateOmmRecord(omm)
  return json2satrec(omm as Parameters<typeof json2satrec>[0])
}

export function getOrbitState(satrec: Satrec, date: Date): OrbitState | null {
  const state = propagate(satrec, date)
  if (!state) return null

  const gmst = gstime(date)
  const geodetic = eciToGeodetic(state.position, gmst)
  const { x, y, z } = state.velocity

  return {
    latitudeDeg: degreesLat(geodetic.latitude),
    longitudeDeg: normalizeLongitude(degreesLong(geodetic.longitude)),
    altitudeKm: geodetic.height,
    speedKmS: Math.sqrt(x * x + y * y + z * z),
  }
}

export function sampleOrbit(satrec: Satrec, center: Date, durationMinutes = 110, stepSeconds = 45) {
  const start = center.getTime() - (durationMinutes * 60_000) / 2
  const steps = Math.ceil((durationMinutes * 60) / stepSeconds)
  const samples: OrbitState[] = []

  for (let i = 0; i <= steps; i += 1) {
    const state = getOrbitState(satrec, new Date(start + i * stepSeconds * 1000))
    if (state) samples.push(state)
  }

  return samples
}
