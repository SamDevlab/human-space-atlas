import { describe, expect, it } from 'vitest'
import { filterCatalog, normalizeCatalog } from '../src/lib/orbitalCatalog'
import type { OmmRecord } from '../src/lib/types'
import { shouldApplyPositionResult } from '../src/workers/workerState'
import { generateSyntheticCatalog } from '../src/lib/syntheticCatalog'
import { percentile, summarizeDurations } from '../src/lib/performanceStats'
import { AutoRenderController, resolveRenderLimit, selectRenderSet } from '../src/lib/renderSet'
import { LatestOnlyQueue } from '../src/workers/latestOnlyQueue'
import { Cartesian3, Cartographic, Quaternion } from 'cesium'
import { createShipState, getShipBasis, integrateShip, MAX_ANGULAR_SPEED_RADIANS_PER_SECOND, MAX_SPEED_METERS_PER_SECOND, MIN_ALTITUDE_METERS } from '../src/exploration/flightModel'
import { combineAngularInput, resolveKeyboardAngularInput, resolveMouseAngularInput } from '../src/exploration/explorationInput'
import { applyCameraOrbit, applyCameraZoom, clampCameraPitch, DEFAULT_CAMERA_DISTANCE_METERS, MAX_CAMERA_DISTANCE_METERS, MIN_CAMERA_DISTANCE_METERS } from '../src/exploration/ShipCameraRig'

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
  const neutralInput = { throttleDelta: 0, strafe: 0, vertical: 0, yawRate: 0, pitchRate: 0, rollInput: 0, boost: false, brake: false }

  it('uses real delta independently of simulated time multiplier', () => {
    const state = createShipState(Cartesian3.fromDegrees(0, 0, 800_000))
    const input = { ...neutralInput, throttleDelta: 1 }
    const simulate = (step: number) => {
      let next = state
      for (let elapsed = 0; elapsed < 1; elapsed += step) next = integrateShip(next, input, step)
      return next
    }
    const thirtyFps = simulate(1 / 30)
    const sixtyFps = simulate(1 / 60)
    const oneTwentyFps = simulate(1 / 120)
    expect(Cartesian3.distance(thirtyFps.position, sixtyFps.position)).toBeLessThan(20)
    expect(Cartesian3.distance(sixtyFps.position, oneTwentyFps.position)).toBeLessThan(20)
    expect(Cartesian3.magnitude(sixtyFps.velocity)).toBeGreaterThan(0)
  })

  it('keeps the ship outside the Earth safety boundary', () => {
    const state = createShipState(Cartesian3.fromDegrees(0, 0, 10_000))
    const next = integrateShip(state, neutralInput, 0.016)
    expect(Cartographic.fromCartesian(next.position).height).toBeGreaterThanOrEqual(MIN_ALTITUDE_METERS - 1)
  })

  it('keeps throttle persistent and supports forward/reverse control', () => {
    const state = createShipState(Cartesian3.fromDegrees(0, 0, 800_000))
    const forward = integrateShip(state, { ...neutralInput, throttleDelta: 1 }, 0.5)
    const reverse = integrateShip(forward, { ...neutralInput, throttleDelta: -1 }, 0.5)
    expect(forward.throttle).toBeGreaterThan(0)
    expect(reverse.throttle).toBeLessThan(forward.throttle)
    expect(integrateShip(forward, neutralInput, 0.5).throttle).toBe(forward.throttle)
  })

  it('brakes velocity, boosts acceleration and limits speed', () => {
    const state = { ...createShipState(Cartesian3.fromDegrees(0, 0, 800_000)), throttle: 1, velocity: new Cartesian3(10_000, 0, 0) }
    const normal = integrateShip(state, neutralInput, 0.1)
    const boost = integrateShip(state, { ...neutralInput, boost: true }, 0.1)
    const brake = integrateShip(state, { ...neutralInput, brake: true }, 0.1)
    expect(Cartesian3.magnitude(boost.velocity)).toBeGreaterThan(Cartesian3.magnitude(normal.velocity))
    expect(Cartesian3.magnitude(brake.velocity)).toBeLessThan(Cartesian3.magnitude(state.velocity))
    expect(Cartesian3.magnitude(integrateShip(state, { ...neutralInput, boost: true }, 10).velocity)).toBeLessThanOrEqual(MAX_SPEED_METERS_PER_SECOND)
  })

  it('smooths pitch/yaw/roll with bounded angular velocity and stable quaternions', () => {
    const state = createShipState(Cartesian3.fromDegrees(0, 0, 800_000))
    const turning = integrateShip(state, { ...neutralInput, yawRate: 1, pitchRate: -1, rollInput: 1 }, 0.1)
    const damping = integrateShip(turning, neutralInput, 0.1)
    expect(turning.angularVelocity.y).toBeGreaterThan(0)
    expect(turning.angularVelocity.x).toBeLessThan(0)
    expect(turning.angularVelocity.z).toBeGreaterThan(0)
    expect(turning.angularVelocity.y).toBeLessThanOrEqual(MAX_ANGULAR_SPEED_RADIANS_PER_SECOND)
    expect(Math.abs(Quaternion.magnitude(turning.orientation) - 1)).toBeLessThan(0.0001)
    expect(Math.abs(damping.angularVelocity.y)).toBeLessThan(Math.abs(turning.angularVelocity.y))
  })

  it('keeps thrust aligned with the rotated ship heading', () => {
    const yaw90 = Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, Math.PI / 2, new Quaternion())
    const state = { ...createShipState(Cartesian3.fromDegrees(0, 0, 800_000), yaw90), throttle: 1 }
    const next = integrateShip(state, neutralInput, 0.1)
    const basis = getShipBasis(state.orientation)
    expect(Cartesian3.dot(next.velocity, basis.forward)).toBeGreaterThan(1)
    expect(Math.abs(Cartesian3.dot(next.velocity, Cartesian3.UNIT_X))).toBeLessThan(1)
  })
})

describe('exploration ship frame and input fallbacks', () => {
  it('uses +X forward, +Y right and +Z up in identity orientation', () => {
    const basis = getShipBasis(Quaternion.IDENTITY)
    expect(Cartesian3.distance(basis.forward, Cartesian3.UNIT_X)).toBeLessThan(0.0001)
    expect(Cartesian3.distance(basis.right, Cartesian3.UNIT_Y)).toBeLessThan(0.0001)
    expect(Cartesian3.distance(basis.up, Cartesian3.UNIT_Z)).toBeLessThan(0.0001)
  })

  it('rotates the expected basis axes for yaw, pitch and roll', () => {
    const yaw = getShipBasis(Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, Math.PI / 2, new Quaternion()))
    const pitch = getShipBasis(Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, Math.PI / 2, new Quaternion()))
    const roll = getShipBasis(Quaternion.fromAxisAngle(Cartesian3.UNIT_X, Math.PI / 2, new Quaternion()))
    expect(Math.abs(Cartesian3.dot(yaw.forward, Cartesian3.UNIT_Y))).toBeGreaterThan(0.999)
    expect(Math.abs(pitch.forward.z)).toBeGreaterThan(0.999)
    expect(Math.abs(Cartesian3.dot(roll.forward, Cartesian3.UNIT_X))).toBeGreaterThan(0.999)
    expect(Math.abs(roll.right.z)).toBeGreaterThan(0.999)
    expect(Math.abs(roll.up.y)).toBeGreaterThan(0.999)
  })

  it('provides keyboard and mouse angular fallback input', () => {
    const keyboard = resolveKeyboardAngularInput(new Set(['ArrowLeft', 'ArrowUp', 'KeyQ']))
    expect(keyboard).toEqual({ yawRate: -1, pitchRate: 1, rollInput: -1 })
    const mouse = resolveMouseAngularInput(20, -10, 1 / 60)
    expect(mouse.yawRate).toBeGreaterThan(0)
    expect(mouse.pitchRate).toBeGreaterThan(0)
    expect(combineAngularInput(keyboard, mouse).yawRate).toBeLessThanOrEqual(1)
  })
})

describe('exploration camera rig math', () => {
  it('maps mouse orbit to yaw/pitch and clamps pitch', () => {
    const orbit = applyCameraOrbit({ yaw: 0, pitch: 0, distance: DEFAULT_CAMERA_DISTANCE_METERS }, 100, -100)
    expect(orbit.yaw).toBeLessThan(0)
    expect(orbit.pitch).toBeGreaterThan(0)
    expect(clampCameraPitch(100)).toBeLessThan(Math.PI / 2)
    expect(clampCameraPitch(-100)).toBeGreaterThan(-Math.PI / 2)
  })

  it('clamps camera zoom to safe distances', () => {
    expect(applyCameraZoom({ yaw: 0, pitch: 0, distance: DEFAULT_CAMERA_DISTANCE_METERS }, -100_000).distance).toBe(MIN_CAMERA_DISTANCE_METERS)
    expect(applyCameraZoom({ yaw: 0, pitch: 0, distance: DEFAULT_CAMERA_DISTANCE_METERS }, 100_000).distance).toBe(MAX_CAMERA_DISTANCE_METERS)
  })
})
