import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const satellite = require('../node_modules/satellite.js/dist/index.js')

const base = {
  OBJECT_NAME: 'BENCHMARK', EPOCH: '2026-08-16T12:00:00.000Z', MEAN_MOTION: 15.49,
  ECCENTRICITY: 0.0007, INCLINATION: 51.6, RA_OF_ASC_NODE: 3.1, ARG_OF_PERICENTER: 51.3,
  MEAN_ANOMALY: 308.8, BSTAR: 0.000097, MEAN_MOTION_DOT: 0.00005, MEAN_MOTION_DDOT: 0,
}
for (const count of [1000, 5000, 10000, 25000, 50000]) {
  const satrecs = Array.from({ length: count }, (_, index) => satellite.json2satrec({ ...base, NORAD_CAT_ID: index + 1 }))
  const started = performance.now()
  let valid = 0
  for (const satrec of satrecs) if (satellite.propagate(satrec, new Date('2026-08-16T12:00:00.000Z'))) valid += 1
  const elapsedMs = performance.now() - started
  console.log(`${count}\t${elapsedMs.toFixed(2)} ms\t${Math.round(count / (elapsedMs / 1000))} objects/sec\tvalid=${valid}`)
}
