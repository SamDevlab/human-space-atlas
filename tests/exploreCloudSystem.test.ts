import { describe, expect, it } from 'vitest'
import {
  cloudShadowOffsetMeters,
  cloudShadowOpacity,
  createCloudVolumeParts,
  createExploreCloudSeeds,
  exploreCloudMapFade,
  exploreCloudRadiusDegrees,
  exploreCloudVolumeFade,
  wrapCloudLongitude,
} from '../src/exploration/ExploreCloudSystem'

describe('ExploreCloudSystem helpers', () => {
  it('wraps longitudes deterministically and rejects non-finite input safely', () => {
    expect(wrapCloudLongitude(181)).toBeCloseTo(-179)
    expect(wrapCloudLongitude(-181)).toBeCloseTo(179)
    expect(wrapCloudLongitude(540)).toBeCloseTo(-180)
    expect(wrapCloudLongitude(Number.NaN)).toBe(0)
  })

  it('uses dimensional clouds only where parallax is useful and hands off before 420 km', () => {
    expect(exploreCloudVolumeFade(150_000)).toBeCloseTo(1)
    expect(exploreCloudVolumeFade(240_000)).toBeGreaterThan(0.7)
    expect(exploreCloudVolumeFade(300_000)).toBeGreaterThan(0.2)
    expect(exploreCloudVolumeFade(300_000)).toBeLessThan(0.4)
    expect(exploreCloudVolumeFade(360_000)).toBeCloseTo(0)
    expect(exploreCloudVolumeFade(420_000)).toBeCloseTo(0)

    expect(exploreCloudMapFade(180_000)).toBeCloseTo(0)
    expect(exploreCloudMapFade(300_000)).toBeGreaterThan(0.7)
    expect(exploreCloudMapFade(330_000)).toBeCloseTo(1)
    expect(exploreCloudMapFade(440_000)).toBeCloseTo(1)
  })

  it('expands the local cloud neighborhood with camera altitude while keeping it bounded', () => {
    expect(exploreCloudRadiusDegrees(120_000)).toBeLessThan(exploreCloudRadiusDegrees(260_000))
    expect(exploreCloudRadiusDegrees(5_000_000)).toBeLessThanOrEqual(14)
  })

  it('creates no cinematic clouds when NASA coverage is absent', () => {
    const seeds = createExploreCloudSeeds(0, 0, 12, () => 0)
    expect(seeds).toEqual([])
  })

  it('creates stable bounded cloud banks from observed coverage', () => {
    const observedPatch = (longitudeDeg: number, latitudeDeg: number) =>
      Math.abs(longitudeDeg) < 7 && Math.abs(latitudeDeg) < 6 ? 0.42 : 0
    const first = createExploreCloudSeeds(0, 0, 10, observedPatch, 100)
    const second = createExploreCloudSeeds(0, 0, 10, observedPatch, 100)

    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(100)
    expect(second).toEqual(first)
    expect(first.every((seed) => seed.altitudeMeters >= 180 && seed.altitudeMeters <= 20_000)).toBe(true)
    expect(first.every((seed) => seed.depthMeters >= 800 && seed.depthMeters <= 12_000)).toBe(true)
    expect(first.every((seed) => seed.scaleX >= 32_000 && seed.scaleX <= 180_000)).toBe(true)
    expect(first.every((seed) => Number.isFinite(seed.scaleX) && Number.isFinite(seed.scaleY))).toBe(true)
    expect(first.every((seed) => seed.alpha > 0 && seed.alpha <= 1)).toBe(true)
  })

  it('splits dense macro formations into stacked volumes for real parallax', () => {
    const seed = createExploreCloudSeeds(0, 0, 4, () => 0.7, 20, () => 12_000, () => 55)[0]
    expect(seed).toBeDefined()
    const parts = createCloudVolumeParts(seed)
    expect(parts.length).toBe(3)
    expect(parts[0].altitudeMeters).toBeLessThan(parts[1].altitudeMeters)
    expect(parts[2].altitudeMeters).toBeGreaterThan(parts[1].altitudeMeters)
    expect(parts[0].scaleX).toBeGreaterThan(parts[2].scaleX)
    expect(parts.every((part) => Number.isFinite(part.longitudeDeg) && Number.isFinite(part.depthMeters))).toBe(true)
  })

  it('keeps thin formations to two layers instead of forcing a fake tower', () => {
    const seed = createExploreCloudSeeds(0, 0, 4, () => 0.55, 20, () => 7_000, () => 1)[0]
    expect(seed).toBeDefined()
    expect(createCloudVolumeParts(seed).length).toBe(2)
  })

  it('uses NASA cloud-top height while preserving the observed top', () => {
    const observedPatch = () => 0.52
    const cloudTopHeight = () => 10_000
    const seeds = createExploreCloudSeeds(0, 0, 5, observedPatch, 50, cloudTopHeight)

    expect(seeds.length).toBeGreaterThan(0)
    expect(seeds.every((seed) => seed.altitudeMeters + seed.depthMeters * 0.5 <= 10_001)).toBe(true)
    expect(seeds.every((seed) => seed.altitudeMeters + seed.depthMeters * 0.5 >= 9_999)).toBe(true)
    expect(seeds.every((seed) => seed.depthMeters >= 1_200)).toBe(true)
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

  it('keeps cloud shadow compatibility helpers bounded and daylight-only', () => {
    expect(cloudShadowOpacity(0.8, 1, 1, 1)).toBeGreaterThan(cloudShadowOpacity(0.25, 1, 1, 1))
    expect(cloudShadowOpacity(0.8, 0, 1, 1)).toBeCloseTo(0)
    expect(cloudShadowOpacity(0.8, 1, 0.5, 1)).toBeLessThan(cloudShadowOpacity(0.8, 1, 1, 1))
    expect(cloudShadowOpacity(1, 1, 1, 1)).toBeLessThanOrEqual(0.08)
  })

  it('projects longer compatibility shadow offsets toward the horizon', () => {
    const overhead = cloudShadowOffsetMeters(10_000, 1)
    const midSun = cloudShadowOffsetMeters(10_000, 0.5)
    const horizon = cloudShadowOffsetMeters(10_000, 0.06)
    expect(overhead).toBeCloseTo(0)
    expect(midSun).toBeGreaterThan(overhead)
    expect(horizon).toBeGreaterThan(midSun)
    expect(horizon).toBeLessThanOrEqual(180_000)
  })
})
