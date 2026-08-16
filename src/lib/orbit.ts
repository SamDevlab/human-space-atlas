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

export function createSatrec(omm: OmmRecord): Satrec {
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
    longitudeDeg: degreesLong(geodetic.longitude),
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
