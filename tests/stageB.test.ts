import { describe, expect, it } from 'vitest'
import iss from './fixtures/omm/iss.json'
import type { OmmRecord } from '../src/lib/types'
import { elevationDegrees } from '../src/lib/passPrediction'
import { screenConjunctions } from '../src/lib/conjunctions'
import { assessReentry, orbitalShapeFromMeanMotion } from '../src/lib/reentry'
import { DEEP_SPACE_TARGETS, parseHorizonsVector } from '../src/lib/deepSpace'
import { GROUND_STATIONS } from '../src/lib/groundStations'

const ISS = iss as OmmRecord

describe('Stage B orbital intelligence', () => {
  it('computes local horizon elevation with an overhead object near zenith', () => {
    const elevation = elevationDegrees(-38.5, -12.97, 420, { latitudeDeg: -12.97, longitudeDeg: -38.5 })
    expect(elevation).toBeGreaterThan(89)
  })

  it('derives a plausible LEO orbital shape from mean motion', () => {
    const shape = orbitalShapeFromMeanMotion(ISS)
    expect(shape.perigeeKm).not.toBeNull()
    expect(shape.perigeeKm!).toBeGreaterThan(300)
    expect(shape.apogeeKm!).toBeLessThan(500)
    expect(assessReentry(ISS).status).toBe('nominal')
  })

  it('flags an artificial very-low-perigee object without inventing a decay date', () => {
    const low = { ...ISS, MEAN_MOTION: 16.45, ECCENTRICITY: 0.02, NORAD_CAT_ID: 999001 }
    const assessment = assessReentry(low)
    expect(['critical', 'high', 'elevated']).toContain(assessment.status)
    expect(assessment.decayDate).toBeNull()
  })

  it('finds an identical-orbit catalog clone as a zero-distance screening case', () => {
    const clone: OmmRecord = { ...ISS, OBJECT_NAME: 'ISS TEST CLONE', NORAD_CAT_ID: 999002 }
    const result = screenConjunctions(ISS, [ISS, clone], new Date('2026-08-16T04:30:00Z'), 30, 4)
    expect(result).toHaveLength(1)
    expect(result[0].catalogId).toBe(999002)
    expect(result[0].missDistanceKm).toBeLessThan(0.001)
  })

  it('parses a JPL Horizons vector block', () => {
    const target = DEEP_SPACE_TARGETS[0]
    const result = `Target body name: Voyager 1\n$$SOE\n2461040.500000000 = A.D. 2026-Aug-18 00:00:00.0000 TDB\n X = 2.100000000E+10 Y = -1.200000000E+10 Z = 3.000000000E+09\n VX= 1.100000000E+01 VY= -4.000000000E+00 VZ= 1.000000000E+00\n$$EOE`
    const vector = parseHorizonsVector(result, target, '2026-08-18T00:00:00Z', 'hit')
    expect(vector.positionKm).toEqual([2.1e10, -1.2e10, 3e9])
    expect(vector.velocityKmS).toEqual([11, -4, 1])
    expect(vector.distanceFromSunKm).toBeGreaterThan(2e10)
  })

  it('ships public NASA and ESA observer presets', () => {
    expect(GROUND_STATIONS.some((station) => station.network === 'NASA DSN')).toBe(true)
    expect(GROUND_STATIONS.some((station) => station.network === 'ESA ESTRACK')).toBe(true)
    expect(GROUND_STATIONS.length).toBeGreaterThanOrEqual(8)
  })
})
