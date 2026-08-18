import { Cartesian3, Ellipsoid } from 'cesium'
import { createSatrec, getOrbitState } from './orbit'
import type { OmmRecord } from './types'

export type ObserverLocation = {
  latitudeDeg: number
  longitudeDeg: number
  altitudeMeters?: number
  name?: string
}

export type PredictedPass = {
  riseAt: Date
  peakAt: Date
  setAt: Date
  maxElevationDeg: number
  peakAltitudeKm: number
  durationSeconds: number
}

export function elevationDegrees(
  satelliteLongitudeDeg: number,
  satelliteLatitudeDeg: number,
  satelliteAltitudeKm: number,
  observer: ObserverLocation,
): number {
  const observerPosition = Cartesian3.fromDegrees(
    observer.longitudeDeg,
    observer.latitudeDeg,
    observer.altitudeMeters ?? 0,
  )
  const satellitePosition = Cartesian3.fromDegrees(
    satelliteLongitudeDeg,
    satelliteLatitudeDeg,
    Math.max(0, satelliteAltitudeKm) * 1000,
  )
  const lineOfSight = Cartesian3.subtract(satellitePosition, observerPosition, new Cartesian3())
  const magnitude = Cartesian3.magnitude(lineOfSight)
  if (!Number.isFinite(magnitude) || magnitude <= 1) return -90
  Cartesian3.divideByScalar(lineOfSight, magnitude, lineOfSight)
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(observerPosition, new Cartesian3())
  return Math.asin(Math.max(-1, Math.min(1, Cartesian3.dot(lineOfSight, up)))) * 180 / Math.PI
}

function sampleElevation(record: OmmRecord, satrec: ReturnType<typeof createSatrec>, at: Date, observer: ObserverLocation) {
  const state = getOrbitState(satrec, at)
  if (!state) return null
  return {
    elevationDeg: elevationDegrees(state.longitudeDeg, state.latitudeDeg, state.altitudeKm, observer),
    altitudeKm: state.altitudeKm,
  }
}

/**
 * Predict visible passes from public OMM/SGP4 elements. This is a planning aid,
 * not an operational station schedule: atmospheric refraction, antenna masks,
 * manoeuvres and element uncertainty are intentionally not modelled.
 */
export function predictPasses(
  record: OmmRecord,
  observer: ObserverLocation,
  startAt = new Date(),
  horizonHours = 24,
  minimumElevationDeg = 10,
  maxPasses = 8,
): PredictedPass[] {
  const latitudeDeg = Math.max(-90, Math.min(90, observer.latitudeDeg))
  const longitudeDeg = ((observer.longitudeDeg + 180) % 360 + 360) % 360 - 180
  const safeObserver = { ...observer, latitudeDeg, longitudeDeg }
  const satrec = createSatrec(record)
  const passes: PredictedPass[] = []
  const startMs = startAt.getTime()
  const stopMs = startMs + Math.max(1, Math.min(72, horizonHours)) * 3_600_000
  const coarseStepMs = 30_000
  let inPass = false
  let riseMs = startMs
  let bestMs = startMs
  let bestElevation = -90
  let bestAltitude = 0

  for (let timeMs = startMs; timeMs <= stopMs; timeMs += coarseStepMs) {
    const sample = sampleElevation(record, satrec, new Date(timeMs), safeObserver)
    const elevation = sample?.elevationDeg ?? -90
    const visible = elevation >= minimumElevationDeg

    if (visible && !inPass) {
      inPass = true
      riseMs = timeMs
      bestMs = timeMs
      bestElevation = elevation
      bestAltitude = sample?.altitudeKm ?? 0
    }

    if (visible && elevation > bestElevation) {
      bestElevation = elevation
      bestMs = timeMs
      bestAltitude = sample?.altitudeKm ?? 0
    }

    if (!visible && inPass) {
      const setMs = timeMs
      const refinementStart = Math.max(riseMs, bestMs - coarseStepMs)
      const refinementStop = Math.min(setMs, bestMs + coarseStepMs)
      for (let refineMs = refinementStart; refineMs <= refinementStop; refineMs += 5_000) {
        const refined = sampleElevation(record, satrec, new Date(refineMs), safeObserver)
        if (refined && refined.elevationDeg > bestElevation) {
          bestElevation = refined.elevationDeg
          bestMs = refineMs
          bestAltitude = refined.altitudeKm
        }
      }
      passes.push({
        riseAt: new Date(riseMs),
        peakAt: new Date(bestMs),
        setAt: new Date(setMs),
        maxElevationDeg: Math.max(minimumElevationDeg, bestElevation),
        peakAltitudeKm: bestAltitude,
        durationSeconds: Math.max(0, Math.round((setMs - riseMs) / 1000)),
      })
      if (passes.length >= maxPasses) break
      inPass = false
      bestElevation = -90
    }
  }

  return passes
}
