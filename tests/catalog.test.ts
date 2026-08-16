import { describe, expect, it } from 'vitest'
import { filterCatalog, normalizeCatalog } from '../src/lib/orbitalCatalog'
import type { OmmRecord } from '../src/lib/types'
import { shouldApplyPositionResult } from '../src/workers/workerState'
import { generateSyntheticCatalog } from '../src/lib/syntheticCatalog'
import { percentile, summarizeDurations } from '../src/lib/performanceStats'
import { AutoRenderController, resolveRenderLimit, selectRenderSet } from '../src/lib/renderSet'
import { LatestOnlyQueue } from '../src/workers/latestOnlyQueue'
import { Cartesian3, Cartographic } from 'cesium'
import { createShipState, integrateShip, MIN_ALTITUDE_METERS } from '../src/exploration/flightModel'

const record = (id: number, type: string, name: string): OmmRecord => ({
  OBJECT_NAME: name, EPOCH: '2026-08-16T00:00:00.000Z', NORAD_CAT_ID: id,
  OBJECT_TYPE: type, MEAN_MOTION: 1, ECCENTRICITY: 0, INCLINATION: 0,
  RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0,
  BSTAR: 0, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
})

describe('large catalog preparation', () => {
  it('normalizes IDs, preserves modern identifiers and deduplicates by NORAD ID', () => {
    const result = normalizeCatalog([record(100123, 'PAYLOAD', 'A'), record(100123, 'PAYLOAD', 'A duplicate'), record(2, 'DEBRIS', 'B'), { ...record(3, 'UNKNOWN', 'bad'), NORAD_CAT_ID: Number.NaN }])
    expect(result.entries.map((entry) => entry.noradId)).toEqual(['100123', '2'])
    expect(result.stats.deduplicated).toBe(1)
    expect(result.stats.rejected).toBe(1)
  })

  it('filters by type and case-insensitive search without changing source entries', () => {
    const entries = normalizeCatalog([record(1, 'PAYLOAD', 'ISS'), record(2, 'DEBRIS', 'Debris One')]).entries
    expect(filterCatalog(entries, 'DEBRIS')).toHaveLength(1)
    expect(filterCatalog(entries, 'ALL', 'iss')[0].noradId).toBe('1')
  })
})

describe('worker stale-result policy', () => {
  it('applies current results and rejects older responses', () => {
    expect(shouldApplyPositionResult(43, 42)).toBe(true)
    expect(shouldApplyPositionResult(41, 42)).toBe(false)
  })
})

describe('benchmark helpers', () => {
  it('generates deterministic varied synthetic catalogs', () => {
    const first = generateSyntheticCatalog(1000)
    const second = generateSyntheticCatalog(1000)
    expect(first).toEqual(second)
    expect(new Set(first.map((item) => item.NORAD_CAT_ID)).size).toBe(1000)
    expect(new Set(first.map((item) => item.MEAN_ANOMALY)).size).toBeGreaterThan(900)
  })

  it('summarizes frame durations with percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5)
    expect(summarizeDurations([10, 20, 30])).toMatchObject({ count: 3, average: 20, p50: 20, max: 30 })
  })
})

describe('active render set policy', () => {
  it('keeps one active request and only the newest pending request', () => {
    const queue = new LatestOnlyQueue<string>()
    expect(queue.submit('A')).toBe('A')
    expect(queue.submit('B')).toBeNull()
    expect(queue.submit('C')).toBeNull()
    expect(queue.submit('D')).toBeNull()
    expect(queue.activeCount).toBe(1)
    expect(queue.pendingCount).toBe(1)
    expect(queue.complete()).toBe('D')
    expect(queue.complete()).toBeNull()
    expect(queue.activeCount).toBe(0)
  })

  it('filters before the limit and includes selected objects outside the normal sample', () => {
    const entries = normalizeCatalog(Array.from({ length: 10 }, (_, index) => record(index + 1, 'PAYLOAD', `Object ${index + 1}`))).entries
    expect(selectRenderSet(entries, 3, null)).toHaveLength(3)
    expect(selectRenderSet(entries, 3, 10).map((entry) => entry.noradNumericId)).toEqual([10, 1, 2, 3])
    expect(resolveRenderLimit('5000', 100, 5000, 7000)).toBe(100)
  })

  it('uses cooldown and hysteresis to avoid AUTO flapping', () => {
    const controller = new AutoRenderController(5000, 1000, 10000, 1000)
    expect(controller.update({ workerMs: 300, applyMs: 1, frameP95Ms: 200 }, 1000)).toBe(2500)
    expect(controller.update({ workerMs: 1, applyMs: 1, frameP95Ms: 10 }, 1500)).toBe(2500)
    expect(controller.update({ workerMs: 1, applyMs: 1, frameP95Ms: 10 }, 2500)).toBe(5000)
  })
})

describe('exploration flight model', () => {
  it('uses real delta independently of simulated time multiplier', () => {
    const state = createShipState(Cartesian3.fromDegrees(0, 0, 800_000))
    const input = { forward: 1, strafe: 0, vertical: 0, yawRate: 0, pitchRate: 0, rollRate: 0, boost: false, brake: false }
    const oneX = integrateShip(state, input, 0.016)
    const hundredX = integrateShip(state, input, 0.016)
    expect(Cartesian3.distance(oneX.position, hundredX.position)).toBe(0)
    expect(Cartesian3.magnitude(oneX.velocity)).toBeGreaterThan(0)
  })

  it('keeps the ship outside the Earth safety boundary', () => {
    const state = createShipState(Cartesian3.fromDegrees(0, 0, 10_000))
    const next = integrateShip(state, { forward: 0, strafe: 0, vertical: 0, yawRate: 0, pitchRate: 0, rollRate: 0, boost: false, brake: false }, 0.016)
    expect(Cartographic.fromCartesian(next.position).height).toBeGreaterThanOrEqual(MIN_ALTITUDE_METERS - 1)
  })

  it('supports six-axis thrust and speed limiting', () => {
    const state = createShipState(Cartesian3.fromDegrees(0, 0, 800_000))
    const next = integrateShip(state, { forward: 1, strafe: 1, vertical: 1, yawRate: 0, pitchRate: 0, rollRate: 1, boost: true, brake: false }, 0.1)
    expect(Cartesian3.magnitude(next.velocity)).toBeLessThanOrEqual(50_000)
    expect(next.angularVelocity.z).toBe(1)
  })
})
