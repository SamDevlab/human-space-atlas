import {
  Cartesian3,
  JulianDate,
  Matrix3,
  Simon1994PlanetaryPositions,
  Transforms,
} from 'cesium'

const EARTH_RADIUS_METERS = 6_378_137
const SUN_RADIUS_METERS = 696_340_000

export type OrbitalLightingState = 'SUNLIGHT' | 'PENUMBRA' | 'ECLIPSE'

export type OrbitalLightingSample = {
  sunlight: number
  state: OrbitalLightingState
  sunPositionFixed: Cartesian3 | null
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function smoothstep01(value: number): number {
  const clamped = clamp(value, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * Computes direct-sun visibility from the apparent angular disks of Earth and
 * Sun as seen from the spacecraft. This gives a smooth penumbra rather than a
 * binary cylindrical shadow while remaining inexpensive enough for Explore.
 */
export function sunlightFactorFromPositions(shipPositionFixed: Cartesian3, sunPositionFixed: Cartesian3): number {
  const shipDistance = Cartesian3.magnitude(shipPositionFixed)
  if (!Number.isFinite(shipDistance) || shipDistance <= 1) return 1

  const toEarth = Cartesian3.negate(shipPositionFixed, new Cartesian3())
  const toSun = Cartesian3.subtract(sunPositionFixed, shipPositionFixed, new Cartesian3())
  const sunDistance = Cartesian3.magnitude(toSun)
  if (!Number.isFinite(sunDistance) || sunDistance <= SUN_RADIUS_METERS) return 1

  const earthAngularRadius = Math.asin(clamp(EARTH_RADIUS_METERS / shipDistance, 0, 1))
  const sunAngularRadius = Math.asin(clamp(SUN_RADIUS_METERS / sunDistance, 0, 1))
  Cartesian3.normalize(toEarth, toEarth)
  Cartesian3.normalize(toSun, toSun)
  const separation = Math.acos(clamp(Cartesian3.dot(toEarth, toSun), -1, 1))

  const fullEclipseBoundary = Math.max(0, earthAngularRadius - sunAngularRadius)
  const fullSunBoundary = earthAngularRadius + sunAngularRadius
  if (separation <= fullEclipseBoundary) return 0
  if (separation >= fullSunBoundary) return 1
  return smoothstep01((separation - fullEclipseBoundary) / Math.max(1e-9, fullSunBoundary - fullEclipseBoundary))
}

const scratchSunInertial = new Cartesian3()
const scratchSunFixed = new Cartesian3()
const scratchIcrfToFixed = new Matrix3()

/** Uses Cesium's planetary ephemeris and the scene clock to sample sunlight. */
export function computeOrbitalLighting(time: JulianDate, shipPositionFixed: Cartesian3): OrbitalLightingSample {
  const transform = Transforms.computeIcrfToFixedMatrix(time, scratchIcrfToFixed)
  if (!transform) return { sunlight: 1, state: 'SUNLIGHT', sunPositionFixed: null }

  const sunInertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time, scratchSunInertial)
  Matrix3.multiplyByVector(transform, sunInertial, scratchSunFixed)
  const sunlight = sunlightFactorFromPositions(shipPositionFixed, scratchSunFixed)
  const state: OrbitalLightingState = sunlight <= 0.03 ? 'ECLIPSE' : sunlight >= 0.97 ? 'SUNLIGHT' : 'PENUMBRA'
  return { sunlight, state, sunPositionFixed: scratchSunFixed.clone() }
}
