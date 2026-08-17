import { describe, expect, it } from 'vitest'
import { atlasCloudVisualFromSignals, cloudAlphaFromFraction } from '../src/lib/earthLayers'

describe('Atlas NASA cloud visual extraction', () => {
  it('keeps low-confidence coverage transparent instead of creating haze', () => {
    expect(cloudAlphaFromFraction(20)).toBe(0)
    expect(cloudAlphaFromFraction(41)).toBe(0)
  })

  it('makes strong observed cloud coverage materially more opaque', () => {
    expect(cloudAlphaFromFraction(95)).toBeGreaterThan(cloudAlphaFromFraction(60))
    expect(cloudAlphaFromFraction(95)).toBeGreaterThan(100)
  })

  it('rejects true-colour no-data pixels', () => {
    expect(atlasCloudVisualFromSignals(220, 5, 5, 5)[3]).toBe(0)
  })

  it('keeps bright desaturated cloud cores brighter and denser than dim edges', () => {
    const core = atlasCloudVisualFromSignals(210, 235, 238, 240)
    const edge = atlasCloudVisualFromSignals(210, 130, 145, 160)

    expect(core[0]).toBeGreaterThan(edge[0])
    expect(core[3]).toBeGreaterThan(edge[3])
    expect(core[3]).toBeGreaterThan(100)
  })

  it('preserves a cool neutral cloud tint rather than painting pure white fog', () => {
    const [red, green, blue, alpha] = atlasCloudVisualFromSignals(200, 220, 224, 228)
    expect(red).toBeLessThanOrEqual(green)
    expect(green).toBeLessThanOrEqual(blue)
    expect(alpha).toBeGreaterThan(0)
  })
})
