# Orbital scale performance notes

## Architecture

- The backend still fetches one OMM/JSON catalog per group and caches it.
- The UI normalizes and deduplicates NORAD identifiers before filtering.
- Bulk satrec creation and SGP4 propagation run in one dedicated Web Worker.
- Worker positions are returned as transferable `Float64Array` triples
  (`longitudeDeg`, `latitudeDeg`, Cesium height in meters).
- Worker results carry generation/request IDs. Older results are discarded.
- Cesium renders bulk objects with one `PointPrimitiveCollection`; React does
  not create a component per satellite.
- The main thread keeps only the selected object's satrec for the orbit trail.
- The current update cadence is driven by the simulated clock at 500 ms while
  the renderer continues independently. This is a simple first backpressure
  boundary; future work can tune worker cadence separately.

## Offline CPU benchmark

Run `npm run perf:catalog`. This measures synthetic `satellite.js` propagation,
not browser FPS or GPU rendering. One observed run on the development machine:

| Objects | Propagation | Objects/sec |
|---:|---:|---:|
| 1,000 | 23.51 ms | 42,536 |
| 5,000 | 19.56 ms | 255,604 |
| 10,000 | 61.35 ms | 163,012 |
| 25,000 | 102.02 ms | 245,050 |
| 50,000 | 122.63 ms | 407,717 |

The small-count variance is normal for a short JIT benchmark. These numbers do
not claim 50k browser support or a target frame rate.

## Browser measurement

Open the app with `?debug=perf` to collect up to 300 animation-frame samples.
The overlay reports average frame time, p95, approximate FPS, object counts,
worker status and whether browser memory metrics are available. No browser FPS
benchmark was treated as a release gate in this environment.

## Known limitations

- Filtering currently sends the filtered catalog as a new worker generation.
- Worker propagation uses latest request IDs to reject stale results, but does
  not yet cancel a computation already executing inside the worker.
- `satellite.js` emits non-fatal Vite browser-externalization warnings for its
  WASM support. Build and browser smoke both pass.
