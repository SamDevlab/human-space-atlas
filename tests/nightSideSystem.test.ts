import { describe, expect, it } from 'vitest'
import { nightLightsVisual } from '../src/exploration/NightSideSystem'

describe('NightSideSystem helpers', () => {
  it('keeps VIIRS city lights fully hidden in full sunlight', () => {
    const day = nightLightsVisual(1)
    expect(day.alpha).toBe(0)
    expect(day.brightness).toBeLessThan(1.2)
  })

  it('brightens and increases contrast as the viewed hemisphere becomes dark', () => {
    const twilight = nightLightsVisual(0.45)
    const night = nightLightsVisual(0)
    expect(night.alpha).toBeGreaterThan(twilight.alpha)
    expect(night.brightness).toBeGreaterThan(twilight.brightness)
    expect(night.contrast).toBeGreaterThan(twilight.contrast)
    expect(night.saturation).toBeGreaterThan(twilight.saturation)
  })

  it('keeps all visual parameters bounded for out-of-range sunlight samples', () => {
    const darkerThanDark = nightLightsVisual(-2)
    const brighterThanDay = nightLightsVisual(4)
    expect(darkerThanDark.alpha).toBeGreaterThan(0)
    expect(darkerThanDark.alpha).toBeLessThanOrEqual(1)
    expect(brighterThanDay.alpha).toBe(0)
  })
})
