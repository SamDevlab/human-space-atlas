import { describe, expect, it } from 'vitest'
import {
  opticalThicknessDensity,
  parseOpticalThicknessRangeMidpoint,
} from '../src/exploration/NasaCloudOpticalThicknessField'

describe('NASA cloud optical thickness helpers', () => {
  it('parses scalar and interval colormap values', () => {
    expect(parseOpticalThicknessRangeMidpoint('[0,1)')).toBeCloseTo(0.5)
    expect(parseOpticalThicknessRangeMidpoint('[10.5,20.5)')).toBeCloseTo(15.5)
    expect(parseOpticalThicknessRangeMidpoint('32')).toBe(32)
    expect(parseOpticalThicknessRangeMidpoint(null)).toBeNull()
  })

  it('maps the wide optical-thickness range into a stable density control', () => {
    expect(opticalThicknessDensity(null)).toBe(0)
    expect(opticalThicknessDensity(0)).toBe(0)
    expect(opticalThicknessDensity(1)).toBeGreaterThan(0)
    expect(opticalThicknessDensity(20)).toBeGreaterThan(opticalThicknessDensity(1))
    expect(opticalThicknessDensity(80)).toBeCloseTo(1)
    expect(opticalThicknessDensity(400)).toBe(1)
  })
})
