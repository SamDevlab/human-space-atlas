import { describe, expect, it } from 'vitest'
import { filterCatalog, normalizeCatalog } from '../src/lib/orbitalCatalog'
import type { OmmRecord } from '../src/lib/types'
import { shouldApplyPositionResult } from '../src/workers/workerState'

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
