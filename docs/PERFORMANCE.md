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

Run `npm run perf:catalog`. This performs two warm-up iterations and five
measured iterations per size. It measures synthetic `satellite.js` propagation,
not browser FPS or GPU rendering. A representative observed run on the
development machine is:

| Objects | Propagation | Objects/sec |
|---:|---:|---:|
| 1,000 | 1.63 ms avg / 1.58 ms median / 1.89 ms p95 | 634,679 |
| 5,000 | 8.22 ms avg / 6.46 ms median / 11.99 ms p95 | 773,742 |
| 10,000 | 16.17 ms avg / 15.19 ms median / 20.59 ms p95 | 658,532 |
| 25,000 | 44.08 ms avg / 40.87 ms median / 57.09 ms p95 | 611,673 |
| 50,000 | 66.89 ms avg / 67.62 ms median / 70.43 ms p95 | 739,410 |

The small-count variance is normal for a short JIT benchmark. These numbers do
not claim 50k browser support or a target frame rate.

## Browser measurement

Run `npm run perf:browser` for a Playwright Chromium benchmark. It opens each
synthetic catalog with `?debug=perf&benchmark=N`, warms up for 2 seconds, then
collects 3 seconds of real `requestAnimationFrame` deltas. It records average,
p50, p95, p99, max, approximate FPS, Long Tasks, worker duration, transfer
bytes and Cesium position-apply duration. Results are written to the ignored
`artifacts/benchmark-results.json`.

An observed headless Chromium run in this environment was:

Environment: Windows, Node 24.18.0, Vite dev server, Playwright Chromium
151.0.7922.34 headless. Browser benchmark uses 2 s warmup and 3 s measure.

| Objects | Avg ms | P50 | P95 | P99 | FPS | Worker ms | Apply ms | Long Tasks | Max LT ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 295.87 | 367.40 | 517.90 | 517.90 | 3.4 | 4.60 | 3.60 | 31 | 551 |
| 5,000 | 384.01 | 391.70 | 582.90 | 582.90 | 2.6 | 82.20 | 3.20 | 25 | 585 |
| 10,000 | 288.25 | 153.30 | 648.50 | 648.50 | 3.5 | 54.10 | 4.90 | 27 | 646 |
| 25,000 | 449.11 | 467.20 | 633.40 | 633.40 | 2.2 | 94.40 | 22.30 | 29 | 624 |
| 50,000 | 507.92 | 533.70 | 744.20 | 744.20 | 2.0 | 633.80 | 28.10 | 31 | 861 |

These are headless-browser measurements on this machine, not a universal
hardware claim. The low FPS and long tasks indicate that this environment is
not suitable for claiming interactive 50k browser support yet.

The overlay itself still collects up to 300 animation-frame samples and shows
the same metrics during manual inspection.

## Known limitations

- Filtering currently sends the filtered catalog as a new worker generation.
- Worker propagation uses latest request IDs to reject stale results, but does
  not yet cancel a computation already executing inside the worker.
- `satellite.js` emits non-fatal Vite browser-externalization warnings for its
  WASM support. Build and browser smoke both pass.
