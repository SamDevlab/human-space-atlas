import { describe, expect, it } from 'vitest'
import {
  createExploreCloudSeeds,
  exploreCloudMapFade,
  exploreCloudRadiusDegrees,
  exploreCloudVolumeFade,
  wrapCloudLongitude,
} from '../src/exploration/ExploreCloudSystem'

describe('ExploreCloudSystem helpers', () => {
  it('wraps longitudes deterministically', () => {
    expect(wrapCloudLongitude(181)).toBeCloseTo(-179)
    expect(wrapCloudLongitude(-181)).toBeCloseTo(179)
    expect(wrapCloudLongitude(540)).toBeCloseTo(-180)
  })

  it('uses volumetric clouds only in low orbit and hands off to the NASA map by 300 km', () => {
    expect(exploreCloudVolumeFade(150_000)).toBeCloseTo(1)
    expect(exploreCloudVolumeFade(240_000)).toBeGreaterThan(0.4)
    expect(exploreCloudVolumeFade(240_000)).toBeLessThan(0.6)
    expect(exploreCloudVolumeFade(300_000)).toBeCloseTo(0)
    expect(exploreCloudVolumeFade(440_000)).toBeCloseTo(0)

    expect(exploreCloudMapFade(150_000)).toBeCloseTo(0)
    expect(exploreCloudMapFade(240_000)).toBeGreaterThan(0.4)
    expect(exploreCloudMapFade(240_000)).toBeLessThan(0.6)
    expect(exploreCloudMapFade(300_000)).toBeCloseTo(1)
    expect(exploreCloudMapFade(440_000)).toBeCloseTo(1)
  })

  it('expands the local cloud neighborhood with camera altitude while keeping it bounded', () => {
    expect(exploreCloudRadiusDegrees(120_000)).toBeLessThan(exploreCloudRadiusDegrees(260_000))
    expect(exploreCloudRadiusDegrees(5_000_000)).toBeLessThanOrEqual(16)
  })

  it('creates no cinematic clouds when NASA coverage is absent', () => {
    const seeds = createExploreCloudSeeds(0, 0, 12, () => 0)
    expect(seeds).toEqual([])
  })

  it('creates stable overlapping cloud banks from observed coverage', () => {
    const observedPatch = (longitudeDeg: number, latitudeDeg: number) =>
      Math.abs(longitudeDeg) < 7 && Math.abs(latitudeDeg) < 6 ? 0.42 : 0
    const first = createExploreCloudSeeds(0, 0, 10, observedPatch, 100)
    const second = createExploreCloudSeeds(0, 0, 10, observedPatch, 100)

    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(100)
    expect(second).toEqual(first)
    expect(first.every((seed) => seed.altitudeMeters > 1_000)).toBe(true)
    expect(first.every((seed) => seed.depthMeters >= 3_000)).toBe(true)
    expect(first.every((seed) => seed.scaleX >= 70_000)).toBe(true)
    expect(first.every((seed) => seed.alpha > 0 && seed.alpha <= 1)).toBe(true)
  })

  it('uses NASA cloud-top height when available while preserving deterministic horizontal structure', () => {
    const observedPatch = () => 0.52
    const cloudTopHeight = () => 10_000
    const seeds = createExploreCloudSeeds(0, 0, 5, observedPatch, 50, cloudTopHeight)

    expect(seeds.length).toBeGreaterThan(0)
    expect(seeds.every((seed) => seed.altitudeMeters + seed.depthMeters * 0.5 <= 10_001)).toBe(true)
    expect(seeds.every((seed) => seed.altitudeMeters + seed.depthMeters * 0.5 >= 9_999)).toBe(true)
    expect(seeds.every((seed) => seed.depthMeters >= 1_500)).toBe(true)
  })

  it('uses NASA optical thickness to make dense clouds deeper and more opaque', () => {
    const observedPatch = () => 0.52
    const cloudTopHeight = () => 11_000
    const thin = createExploreCloudSeeds(0, 0, 5, observedPatch, 50, cloudTopHeight, () => 1)
    const thick = createExploreCloudSeeds(0, 0, 5, observedPatch, 50, cloudTopHeight, () => 60)

    expect(thin.length).toBeGreaterThan(0)
    expect(thick.length).toBe(thin.length)
    expect(thick[0].density).toBeGreaterThan(thin[0].density)
    expect(thick[0].depthMeters).toBeGreaterThan(thin[0].depthMeters)
    expect(thick[0].alpha).toBeGreaterThan(thin[0].alpha)
    expect(thick[0].altitudeMeters + thick[0].depthMeters * 0.5).toBeCloseTo(11_000, -1)
  })
})
