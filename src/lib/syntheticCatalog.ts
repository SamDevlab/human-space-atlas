import type { OmmRecord } from './types'

const BASE: OmmRecord = {
  OBJECT_NAME: 'SYNTHETIC OBJECT', OBJECT_ID: '2026-001A', EPOCH: '2026-08-16T12:00:00.000Z',
  MEAN_MOTION: 15.49, ECCENTRICITY: 0.0007, INCLINATION: 51.6, RA_OF_ASC_NODE: 3.1,
  ARG_OF_PERICENTER: 51.3, MEAN_ANOMALY: 308.8, NORAD_CAT_ID: 1, BSTAR: 0.000097,
  MEAN_MOTION_DOT: 0.00005, MEAN_MOTION_DDOT: 0,
}

export function generateSyntheticCatalog(count: number): OmmRecord[] {
  if (!Number.isInteger(count) || count < 1 || count > 50000) throw new Error('Synthetic catalog size must be an integer from 1 to 50000')
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    OBJECT_NAME: `SYNTHETIC OBJECT ${index + 1}`,
    OBJECT_ID: `2026-${String(index % 999).padStart(3, '0')}A`,
    NORAD_CAT_ID: 200000 + index,
    INCLINATION: 20 + ((index * 17) % 140) / 2,
    RA_OF_ASC_NODE: (index * 29.7) % 360,
    ARG_OF_PERICENTER: (index * 13.3) % 360,
    MEAN_ANOMALY: (index * 47.1) % 360,
    MEAN_MOTION: 12 + (index % 700) / 100,
    OBJECT_TYPE: index % 10 === 0 ? 'DEBRIS' : 'PAYLOAD',
  }))
}
