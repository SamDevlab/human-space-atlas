# Human Space Atlas — Roadmap

## M0 — Foundation ✅

- [x] React + TypeScript + Vite
- [x] CesiumJS scene
- [x] CelesTrak OMM/JSON proxy
- [x] SGP4 propagation via satellite.js
- [x] Web Worker bulk propagation with transferable typed buffers
- [x] PointPrimitiveCollection bulk rendering
- [x] deterministic adaptive render density
- [x] search/filtering and selected-object inspector
- [x] orbit trail and simulation clock
- [x] JPL Horizons proxy

## M1 — Earth Experience ✅ / stabilization

- [x] multiple base-map styles
- [x] terrain with fallback provider
- [x] NASA EONET Earth events
- [x] optional OpenSky aircraft context
- [x] NASA GIBS cloud fraction
- [x] NASA MODIS Cloud Top Height
- [x] NASA MODIS Cloud Optical Thickness
- [x] bounded layered 3D Explore clouds with low-orbit parallax
- [x] defensive cloud reconstruction with finite dimension limits and far-field fallback
- [x] orbital lighting
- [x] NASA VIIRS night lights
- [x] NOAA OVATION aurora
- [x] cinematic Explore camera
- [x] imagery ancestor warmup and provider reuse
- [x] forward Explore imagery prefetch
- [x] stale-while-revalidate API cache with stale-if-error
- [x] optional Upstash/Vercel-KV-compatible REST cache
- [x] Earth visual smoke harness and QA matrix
- [x] remove unsafe global Cesium imagery-collection patching
- [ ] final hardware-accelerated Chrome visual pass at 120 / 180 / 300 / 440 km and global view
- [ ] mobile layout pass
- [ ] accessibility pass
- [ ] URL-shareable selected object / camera state

## M2 — Earth-orbit intelligence ✅ / refinement

- [x] observer-location pass prediction from public OMM/SGP4
- [x] NASA DSN and ESA ESTRACK observer presets
- [x] ground-station visibility windows through pass prediction
- [x] public-catalog conjunction / close-approach screening with explicit non-operational labeling
- [x] orbital-decay / re-entry watch without fabricated timestamps
- [x] source/cache status inside the intelligence workbench
- [ ] visualize pass arcs and screened approaches directly on the main Cesium globe
- [ ] optional worker path for very large conjunction screening sets

## M3 — Human deep space 🟡

- [x] curated spacecraft registry with Horizons command IDs
- [x] live JPL Horizons heliocentric vector client
- [x] Solar System log-scale heliocentric scene inside the intelligence workbench
- [x] Earth-relative distance for selected deep-space spacecraft
- [x] DSN / ESTRACK context where public data and terms permit
- [ ] full-screen 3D Solar System scene using a dedicated deep-space reference frame
- [ ] reference-frame and Earth→Solar-System camera transition layer
- [ ] deep-space mission trajectory sampling/trails
- [ ] richer spacecraft / planetary mission metadata

## Performance / reliability gates

These remain continuous rather than one-off milestones:

- no React component per catalog object;
- worker backpressure keeps only one active propagation plus the latest pending request;
- visual effects must have explicit instance/request budgets;
- map/provider changes must preserve a valid previous or ancestor texture while loading;
- never monkey-patch Cesium rendering collections for presentation effects;
- cloud dimensions, counts and upstream samples must be finite and bounded before reaching Cesium;
- upstream outages should prefer a labeled stale observation over a blank/broken layer;
- `npm test`, `npm run typecheck`, `npm run check:server` and `npm run build` must remain clean before release.

## Deliberately deferred from the current roadmap

The current product direction does **not** include advanced intercept/formation autopilot, a generalized Go To action system, proximity-based satellite model LOD, artificial visual-scale automation, future-position markers, launch-event integration, Historical Mode or historical event replay. They can be reconsidered later, but new work should not depend on them.
