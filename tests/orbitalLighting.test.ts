import { describe, expect, it } from 'vitest'
import { Cartesian3 } from 'cesium'
import { sunlightFactorFromPositions } from '../src/exploration/OrbitalLighting'

const SUN_DISTANCE_METERS = 149_597_870_700
const ORBIT_RADIUS_METERS = 6_378_137 + 800_000

describe('orbital sunlight geometry', () => {
  it('keeps the day-side spacecraft in direct sunlight', () => {
    const ship = new Cartesian3(ORBIT_RADIUS_METERS, 0, 0)
    const sun = new Cartesian3(SUN_DISTANCE_METERS, 0, 0)
    expect(sunlightFactorFromPositions(ship, sun)).toBeCloseTo(1)
  })

  it('places a night-side spacecraft behind Earth in full eclipse', () => {
    const ship = new Cartesian3(-ORBIT_RADIUS_METERS, 0, 0)
    const sun = new Cartesian3(SUN_DISTANCE_METERS, 0, 0)
    expect(sunlightFactorFromPositions(ship, sun)).toBeCloseTo(0)
  })

  it('returns a smooth partial value near the shadow boundary', () => {
    const sun = new Cartesian3(SUN_DISTANCE_METERS, 0, 0)
    let partial: number | null = null
    for (let y = 5_000_000; y <= 8_000_000; y += 25_000) {
      const value = sunlightFactorFromPositions(new Cartesian3(-ORBIT_RADIUS_METERS, y, 0), sun)
      if (value > 0 && value < 1) {
        partial = value
        break
      }
    }
    expect(partial).not.toBeNull()
    expect(partial!).toBeGreaterThan(0)
    expect(partial!).toBeLessThan(1)
  })
})
