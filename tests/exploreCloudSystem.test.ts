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

  it('crossfades volumetric and map clouds across orbital altitude', () => {
    expect(exploreCloudVolumeFade(250_000)).toBeCloseTo(1)
    expect(exploreCloudVolumeFade(1_600_000)).toBeCloseTo(0)
    expect(exploreCloudMapFade(250_000)).toBeCloseTo(0)
    expect(exploreCloudMapFade(1_200_000)).toBeCloseTo(1)
  })

  it('expands the local cloud neighborhood with camera altitude', () => {
    expect(exploreCloudRadiusDegrees(150_000)).toBeLessThan(exploreCloudRadiusDegrees(800_000))
    expect(exploreCloudRadiusDegrees(5_000_000)).toBeLessThanOrEqual(24)
  })

  it('creates no cinematic clouds when NASA coverage is absent', () => {
    const seeds = createExploreCloudSeeds(0, 0, 12, () => 0)
    expect(seeds).toEqual([])
  })

  it('creates stable cloud clusters from observed coverage', () => {
    const observedPatch = (longitudeDeg: number, latitudeDeg: number) =>
      Math.abs(longitudeDeg) < 6 && Math.abs(latitudeDeg) < 5 ? 0.42 : 0
    const first = createExploreCloudSeeds(0, 0, 10, observedPatch, 100)
    const second = createExploreCloudSeeds(0, 0, 10, observedPatch, 100)

    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(100)
    expect(second).toEqual(first)
    expect(first.every((seed) => seed.altitudeMeters > 1_000)).toBe(true)
    expect(first.every((seed) => seed.depthMeters > 2_000)).toBe(true)
    expect(first.every((seed) => seed.alpha > 0 && seed.alpha <= 0.94)).toBe(true)
  })
})
