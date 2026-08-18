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
- [x] JPL Horizons proxy scaffold

## M1 — Earth Experience ✅ / stabilization

- [x] multiple base-map styles
- [x] terrain with fallback provider
- [x] NASA EONET Earth events
- [x] optional OpenSky aircraft context
- [x] NASA GIBS cloud fraction
- [x] NASA MODIS Cloud Top Height
- [x] NASA MODIS Cloud Optical Thickness
- [x] layered 3D Explore clouds with low-orbit parallax
- [x] cloud shadows and orbital lighting
- [x] NASA VIIRS night lights
- [x] NOAA OVATION aurora
- [x] cinematic Explore camera
- [x] imagery ancestor warmup and provider reuse
- [x] base-map crossfade
- [x] forward Explore imagery prefetch
- [x] stale-while-revalidate API cache with stale-if-error
- [x] optional Upstash/Vercel-KV-compatible REST cache
- [x] Earth visual smoke harness and QA matrix
- [ ] final hardware-accelerated Chrome visual pass at 120 / 180 / 300 / 440 km and global view
- [ ] mobile layout pass
- [ ] accessibility pass
- [ ] URL-shareable selected object / camera state

## M2 — Earth-orbit intelligence

- [ ] observer-location pass prediction
- [ ] ground-station registry and visibility windows
- [ ] conjunction / close-approach visualization with clearly labeled uncertainty
- [ ] re-entry / orbital-decay timeline using reliable public data
- [ ] source freshness/status surface for external providers

## M3 — Human deep space

- [ ] curated spacecraft registry with Horizons IDs
- [ ] Solar System scene mode
- [ ] reference-frame and scale transition layer
- [ ] deep-space mission trajectories
- [ ] spacecraft / planetary mission metadata
- [ ] DSN / ESTRACK context where public data and terms permit

## Performance / reliability gates

These remain continuous rather than one-off milestones:

- no React component per catalog object;
- worker backpressure keeps only one active propagation plus the latest pending request;
- visual effects must have explicit instance/request budgets;
- map/provider changes must preserve a valid previous or ancestor texture while loading;
- upstream outages should prefer a labeled stale observation over a blank/broken layer;
- `npm test`, `npm run typecheck`, `npm run check:server` and `npm run build` must remain clean before release.

## Deliberately deferred from the current roadmap

The current product direction does **not** include advanced intercept/formation autopilot, a generalized Go To action system, proximity-based satellite model LOD, artificial visual-scale automation, future-position markers, launch-event integration, Historical Mode or historical event replay. They can be reconsidered later, but new work should not depend on them.
