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
  const samples = []
  let valid = 0
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const started = performance.now()
    valid = 0
    for (const satrec of satrecs) if (satellite.propagate(satrec, new Date('2026-08-16T12:00:00.000Z'))) valid += 1
    if (iteration >= 2) samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
  console.log(`${count}\tavg=${average.toFixed(2)} ms\tmedian=${percentile(0.5).toFixed(2)} ms\tp95=${percentile(0.95).toFixed(2)} ms\t${Math.round(count / (percentile(0.5) / 1000))} objects/sec\tvalid=${valid}`)
}
