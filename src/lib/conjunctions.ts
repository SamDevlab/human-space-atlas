import { Cartesian3 } from 'cesium'
import { createSatrec, getOrbitState, toCesiumHeightMeters } from './orbit'
import type { OmmRecord } from './types'

export type ConjunctionScreeningResult = {
  catalogId: number
  name: string
  closestAt: Date
  missDistanceKm: number
  relativeSpeedKmS: number | null
}

function statePosition(record: OmmRecord, satrec: ReturnType<typeof createSatrec>, at: Date): Cartesian3 | null {
  const state = getOrbitState(satrec, at)
  if (!state) return null
  return Cartesian3.fromDegrees(state.longitudeDeg, state.latitudeDeg, toCesiumHeightMeters(state.altitudeKm))
}

function positionAndVelocity(record: OmmRecord, satrec: ReturnType<typeof createSatrec>, at: Date) {
  const position = statePosition(record, satrec, at)
  if (!position) return null
  const before = statePosition(record, satrec, new Date(at.getTime() - 1_000))
  const after = statePosition(record, satrec, new Date(at.getTime() + 1_000))
  if (!before || !after) return { position, velocity: null as Cartesian3 | null }
  const velocity = Cartesian3.divideByScalar(Cartesian3.subtract(after, before, new Cartesian3()), 2_000, new Cartesian3())
  return { position, velocity }
}

/**
 * Lightweight screening against the catalog currently loaded in the browser.
 * It is deliberately labelled as screening rather than collision probability:
 * public OMM elements do not include covariance and this does not replace CDMs.
 */
export function screenConjunctions(
  target: OmmRecord,
  catalog: OmmRecord[],
  centerAt = new Date(),
  horizonMinutes = 90,
  maxResults = 8,
): ConjunctionScreeningResult[] {
  const targetSatrec = createSatrec(target)
  const candidates = catalog
    .filter((record) => record.NORAD_CAT_ID !== target.NORAD_CAT_ID)
    .filter((record) => Math.abs(record.INCLINATION - target.INCLINATION) <= 25)
    .filter((record) => Math.abs(record.MEAN_MOTION - target.MEAN_MOTION) <= 2.5)
    .slice(0, 900)
    .map((record) => {
      try { return { record, satrec: createSatrec(record) } } catch { return null }
    })
    .filter((item): item is { record: OmmRecord; satrec: ReturnType<typeof createSatrec> } => Boolean(item))

  const coarse: Array<{ record: OmmRecord; satrec: ReturnType<typeof createSatrec>; missMeters: number; atMs: number }> = []
  const horizonMs = Math.max(30, Math.min(360, horizonMinutes)) * 60_000
  const startMs = centerAt.getTime() - horizonMs
  const stopMs = centerAt.getTime() + horizonMs
  const stepMs = 5 * 60_000

  for (const candidate of candidates) {
    let bestDistance = Number.POSITIVE_INFINITY
    let bestAt = centerAt.getTime()
    for (let timeMs = startMs; timeMs <= stopMs; timeMs += stepMs) {
      const at = new Date(timeMs)
      const targetPosition = statePosition(target, targetSatrec, at)
      const candidatePosition = statePosition(candidate.record, candidate.satrec, at)
      if (!targetPosition || !candidatePosition) continue
      const distance = Cartesian3.distance(targetPosition, candidatePosition)
      if (distance < bestDistance) {
        bestDistance = distance
        bestAt = timeMs
      }
    }
    if (Number.isFinite(bestDistance) && bestDistance < 2_500_000) coarse.push({ ...candidate, missMeters: bestDistance, atMs: bestAt })
  }

  coarse.sort((a, b) => a.missMeters - b.missMeters)
  const shortlist = coarse.slice(0, Math.max(maxResults * 3, 16))
  const results: ConjunctionScreeningResult[] = []

  for (const candidate of shortlist) {
    let bestDistance = candidate.missMeters
    let bestAt = candidate.atMs
    for (let timeMs = candidate.atMs - 6 * 60_000; timeMs <= candidate.atMs + 6 * 60_000; timeMs += 30_000) {
      const at = new Date(timeMs)
      const targetPosition = statePosition(target, targetSatrec, at)
      const candidatePosition = statePosition(candidate.record, candidate.satrec, at)
      if (!targetPosition || !candidatePosition) continue
      const distance = Cartesian3.distance(targetPosition, candidatePosition)
      if (distance < bestDistance) {
        bestDistance = distance
        bestAt = timeMs
      }
    }

    const at = new Date(bestAt)
    const targetState = positionAndVelocity(target, targetSatrec, at)
    const candidateState = positionAndVelocity(candidate.record, candidate.satrec, at)
    let relativeSpeedKmS: number | null = null
    if (targetState?.velocity && candidateState?.velocity) {
      relativeSpeedKmS = Cartesian3.magnitude(Cartesian3.subtract(targetState.velocity, candidateState.velocity, new Cartesian3()))
    }

    results.push({
      catalogId: candidate.record.NORAD_CAT_ID,
      name: candidate.record.OBJECT_NAME,
      closestAt: at,
      missDistanceKm: bestDistance / 1000,
      relativeSpeedKmS,
    })
  }

  return results.sort((a, b) => a.missDistanceKm - b.missDistanceKm).slice(0, maxResults)
}
