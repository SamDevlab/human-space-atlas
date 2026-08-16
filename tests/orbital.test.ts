import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSatrec, getOrbitState, normalizeLongitude, toCesiumHeightMeters, validateOmmRecord } from '../src/lib/orbit'
import type { OmmRecord } from '../src/lib/types'
import { advanceSimulatedTime } from '../src/lib/simulationClock'

function fixture(name: string): OmmRecord {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/omm', `${name}.json`), 'utf8')) as OmmRecord
}

describe('OMM validation and SGP4', () => {
  it('accepts ISS OMM and numeric orbital fields', () => {
    const omm = fixture('iss')
    validateOmmRecord(omm)
    expect(omm.NORAD_CAT_ID).toBe(25544)
    expect(typeof omm.MEAN_MOTION).toBe('number')
    expect(createSatrec(omm)).toBeTruthy()
  })

  it('accepts modern NORAD identifiers beyond five digits', () => {
    expect(() => createSatrec(fixture('modern-norad'))).not.toThrow()
  })

  it('rejects missing and invalid orbital fields predictably', () => {
    const missing = { ...fixture('iss'), MEAN_MOTION: undefined } as unknown as OmmRecord
    expect(() => validateOmmRecord(missing)).toThrow(/MEAN_MOTION/)
    expect(() => validateOmmRecord({ ...fixture('iss'), EPOCH: 'not-a-date' })).toThrow(/EPOCH/)
    expect(() => validateOmmRecord({ ...fixture('iss'), ECCENTRICITY: 1 })).toThrow(/range/)
  })

  it('produces finite deterministic LEO state with plausible altitude and speed', () => {
    const satrec = createSatrec(fixture('iss'))
    const t0 = new Date('2026-08-16T12:00:00.000Z')
    const first = getOrbitState(satrec, t0)
    const second = getOrbitState(satrec, t0)
    expect(first).not.toBeNull()
    expect(first).toEqual(second)
    expect(first!.altitudeKm).toBeGreaterThan(100)
    expect(first!.altitudeKm).toBeLessThan(3000)
    expect(first!.speedKmS).toBeGreaterThan(6)
    expect(first!.speedKmS).toBeLessThan(9)
    expect(Number.isFinite(first!.latitudeDeg)).toBe(true)
    expect(first!.latitudeDeg).toBeGreaterThanOrEqual(-90)
    expect(first!.latitudeDeg).toBeLessThanOrEqual(90)
    expect(first!.longitudeDeg).toBeGreaterThanOrEqual(-180)
    expect(first!.longitudeDeg).toBeLessThanOrEqual(180)
  })
})

describe('coordinate and time helpers', () => {
  it('normalizes longitude and converts kilometers to Cesium meters', () => {
    expect(normalizeLongitude(181)).toBe(-179)
    expect(normalizeLongitude(-181)).toBe(179)
    expect(toCesiumHeightMeters(400)).toBe(400000)
  })

  it.each([[1, 1000], [10, 10000], [100, 100000]])('advances simulated time at %ix', (speed, expected) => {
    expect(advanceSimulatedTime(0, 1000, speed)).toBe(expected)
  })

  it('pauses simulated time at speed zero', () => {
    expect(advanceSimulatedTime(1234, 100000, 0)).toBe(1234)
  })
})
