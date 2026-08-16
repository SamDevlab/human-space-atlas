# Orbital scale performance notes

## Architecture

- The backend still fetches one OMM/JSON catalog per group and caches it.
- The UI keeps a full searchable catalog, then applies filtering, deterministic
  priority selection and a render limit. Catalog size, filtered size, active
  propagation size and rendered size are distinct counters.
- Bulk satrec creation and SGP4 propagation run in one dedicated Web Worker,
  but only for the active render set. A 50k catalog with a 1k limit therefore
  does not automatically perform 50k SGP4 propagations.
- Worker positions are returned as transferable `Float64Array` triples
  (`longitudeDeg`, `latitudeDeg`, Cesium height in meters).
- Worker results carry generation/request IDs. Older results are discarded.
- Cesium renders bulk objects with one `PointPrimitiveCollection`; React does
  not create a component per satellite.
- The main thread keeps only the selected object's satrec for the orbit trail.
- Selected objects are forced into the active set even when outside the normal
  deterministic sample. Search operates over the full catalog.
- Render modes are persisted locally: Automatic, 1k, 2.5k, 5k, 10k, 25k,
  Maximum (50k stress), and Custom. Automatic starts conservatively at 5k and
  uses cooldown/hysteresis around worker/apply/frame signals.
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
| 1,000 | 2.11 ms avg / 2.14 ms median / 2.26 ms p95 | 468,252 |
| 5,000 | 11.11 ms avg / 10.67 ms median / 12.58 ms p95 | 468,577 |
| 10,000 | 24.56 ms avg / 27.12 ms median / 31.71 ms p95 | 368,755 |
| 25,000 | 54.07 ms avg / 53.13 ms median / 69.64 ms p95 | 470,528 |
| 50,000 | 99.01 ms avg / 100.32 ms median / 107.88 ms p95 | 498,428 |

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
| 1,000 | 368.62 | 387.00 | 552.20 | 552.20 | 2.7 | 5.10 | 0.80 | 29 | 558 |
| 5,000 | 333.67 | 400.20 | 559.30 | 559.30 | 3.0 | 20.80 | 3.40 | 28 | 560 |
| 10,000 | 308.95 | 373.80 | 636.40 | 636.40 | 3.2 | 21.40 | 4.20 | 27 | 634 |
| 25,000 | 396.63 | 416.30 | 631.00 | 631.00 | 2.5 | 21.70 | 4.10 | 25 | 620 |
| 50,000 | 419.07 | 431.50 | 677.40 | 677.40 | 2.4 | 89.20 | 3.60 | 26 | 630 |

These are headless-browser measurements on this machine, not a universal
hardware claim. The low FPS and long tasks indicate that this environment is
not suitable for claiming interactive 50k browser support yet.

With a 50k synthetic catalog and a manual 1k render limit, the same runner
reported `catalogObjects=50000`, `renderedObjects=1000`, worker ~5.5 ms and
Cesium apply ~1.2 ms. This validates the active-set boundary independently of
the headless renderer's low frame rate.

## Adaptive rendering conclusion

The product requirement is now controlled visual density, not rendering every
known object. The full catalog remains searchable and metadata-bearing while
the worker and Cesium collection operate on the selected active set.

The overlay itself still collects up to 300 animation-frame samples and shows
the same metrics during manual inspection.

## Known limitations

- Filtering currently sends the filtered catalog as a new worker generation.
- Worker propagation uses latest request IDs to reject stale results, but does
  not yet cancel a computation already executing inside the worker.
- `satellite.js` emits non-fatal Vite browser-externalization warnings for its
  WASM support. Build and browser smoke both pass.
