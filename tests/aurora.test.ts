import { describe, expect, it } from 'vitest'
import {
  auroraVisualStrength,
  createAuroraCurtainSeeds,
  normalizeAuroraForecast,
} from '../src/lib/aurora'

describe('NOAA OVATION aurora helpers', () => {
  it('normalizes forecast tuples and rejects invalid/equatorial entries', () => {
    const forecast = normalizeAuroraForecast({
      source: 'noaa-swpc-ovation',
      fetchedAt: '2026-08-17T00:00:00Z',
      cache: 'miss',
      peak: 40,
      points: [
        [-20, 68, 40],
        [15, -70, 18],
        [0, 20, 99],
        ['bad', 70, 20],
      ],
    })

    expect(forecast.points).toHaveLength(2)
    expect(forecast.peak).toBe(40)
    expect(forecast.points[0]).toMatchObject({ longitudeDeg: -20, latitudeDeg: 68, intensity: 40 })
  })

  it('keeps quiet forecasts visible without making them as strong as major activity', () => {
    expect(auroraVisualStrength(10, 10)).toBeGreaterThan(0.5)
    expect(auroraVisualStrength(10, 10)).toBeLessThan(auroraVisualStrength(80, 80))
    expect(auroraVisualStrength(0, 80)).toBe(0)
  })

  it('creates bounded deterministic curtains around the strongest auroral cells', () => {
    const forecast = normalizeAuroraForecast({
      peak: 60,
      points: Array.from({ length: 80 }, (_, index) => [
        -160 + index * 4,
        index % 2 === 0 ? 66 : -68,
        10 + index % 50,
      ]),
    })
    const first = createAuroraCurtainSeeds(forecast, 24)
    const second = createAuroraCurtainSeeds(forecast, 24)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(24)
    expect(first.every((seed) => seed.bottomMeters >= 90_000)).toBe(true)
    expect(first.every((seed) => seed.topMeters > seed.bottomMeters)).toBe(true)
    expect(first.every((seed) => seed.alpha > 0 && seed.alpha <= 0.84)).toBe(true)
  })
})
