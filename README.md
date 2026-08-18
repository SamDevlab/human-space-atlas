# Human Space Atlas

A web-based 3D atlas of **human-made objects in space**. The project combines a scientific Earth-orbit catalog with a cinematic Explore mode while keeping observed data and reconstructed visual effects clearly separated.

## Current state

### Orbital atlas

- CesiumJS 3D Earth with multiple base-map styles.
- CelesTrak OMM/JSON ingestion through the project API.
- `satellite.js` / SGP4 propagation in a Web Worker.
- Typed transferable position buffers and deterministic adaptive render density.
- `PointPrimitiveCollection` bulk rendering rather than one React component per satellite.
- Search/filtering across the loaded catalog, selected-object inspection and orbit trail.
- Simulation clock controls and synchronized object tracking.
- Terrain with Cesium World Terrain when configured and ArcGIS elevation fallback.
- NASA EONET Earth events and optional OpenSky aircraft context.

### Earth Experience

- NASA GIBS cloud fraction for observed macro cloud placement.
- NASA MODIS Cloud Top Height for observed cloud altitude.
- NASA MODIS Cloud Optical Thickness for density/depth cues.
- Atlas cloud presentation designed to avoid a global fog layer.
- Explore uses bounded native Cesium cloud volumes with separated vertical layers for real low-orbit parallax.
- Explore volumetric clouds hand off completely to the stable NASA far-field map before ~360 km; malformed/non-finite samples are rejected before reaching Cesium.
- NASA VIIRS night-light overlay, hidden in daylight and faded in only after imagery tiles stabilize.
- NOAA SWPC OVATION aurora forecast rendered as cinematic auroral curtains.
- Orbital sunlight / penumbra / eclipse lighting and enhanced sunrise/sunset atmosphere.

### Explore

- Third-person fictional HSA Explorer spacecraft, kept conceptually separate from real catalog objects.
- 6DOF-style flight controls, throttle/boost, camera orbit/zoom and camera presets.
- Cinematic camera drift when the user is hands-off.
- Synchronization with a selected real object for observation.
- No weapons, combat, economy or XP systems.

### Texture streaming / renderer stability

- Coarse imagery ancestors are warmed before a map provider becomes active.
- Warmed imagery providers are reused when switching back to a style.
- Warm-up requests are bounded and adapt to limited/data-saver devices.
- Explore prefetches a throttled 3x3 tile neighborhood ahead of the camera.
- VIIRS waits for stable globe tiles before becoming visible.
- Cesium rendering collections are never monkey-patched for transition effects; an earlier experimental patch was removed after it could corrupt imagery state under concurrent refinement.
- Visual QA matrix: [`docs/EARTH-VISUAL-QA.md`](docs/EARTH-VISUAL-QA.md).

### Orbital Intelligence — Stage B

Open **INTEL** from the lower-left corner of the app.

- Observer-location pass prediction for the next 24 hours from current public OMM/SGP4 elements.
- NASA Deep Space Network and ESA ESTRACK station presets.
- Browser geolocation support for local pass prediction.
- Close-approach / conjunction screening against the loaded public catalog, explicitly labelled as non-operational because covariance/CDM data is not available.
- Orbital-decay / re-entry watch derived from mean motion, eccentricity, BSTAR and catalog `DECAY_DATE` when present; the UI does not fabricate re-entry timestamps.
- Curated deep-space spacecraft registry.
- Live heliocentric vectors through NASA/JPL Horizons.
- Log-scale Solar System map with selected mission, Earth, planetary orbit guides, heliocentric speed and Earth-relative distance.

### Backend cache

The API uses stale-while-revalidate semantics with multiple cache levels:

1. in-memory cache for the active process;
2. filesystem cache when writable;
3. optional Upstash Redis REST / Vercel KV-compatible REST cache in production.

When an upstream provider is temporarily unavailable, the API can continue serving the last valid cached observation within its stale retention window instead of immediately breaking the experience.

Supported environment variables are documented in `.env.example`.

## Stack

- React + TypeScript + Vite
- CesiumJS
- satellite.js / SGP4
- Node built-in HTTP/fetch API
- Vitest
- Playwright for browser/performance/visual smoke harnesses

## Quick start

Requirements: Node.js 22.13+.

```bash
cp .env.example .env
npm install
npm run dev
```

The web UI normally starts on `http://localhost:5173` and the local API on `http://localhost:8787`.

### Optional Cesium ion token

```env
VITE_CESIUM_ION_TOKEN=your_public_read_token
```

Do not put private-scope secrets in a browser environment variable.

### Optional durable cache

For serverless deployments, configure either pair:

```env
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

or:

```env
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

Without a remote cache, the server still uses memory plus a best-effort filesystem cache.

## API endpoints

```text
GET /api/health
GET /api/catalog?group=stations
GET /api/catalog?group=active
GET /api/catalog?group=starlink
GET /api/catalog?group=gps-ops
GET /api/earth/events
GET /api/space-weather/aurora
GET /api/aircraft/states
GET /api/horizons?command=<JPL_COMMAND>&start=2026-08-16&stop=2026-08-17&step=1%20h
```

The Horizons adapter is now used by the Stage B deep-space workbench. A dedicated full-screen 3D Solar System reference frame remains a later M3 refinement.

## Validation

```bash
npm test
npm run typecheck
npm run check:server
npm run build
```

With the development server running:

```bash
npm run smoke:earth
```

Browser smoke screenshots are written to `artifacts/earth-smoke/`.

## Data-source principles

1. Prefer modern OMM/JSON contracts over TLE-only assumptions.
2. Cache upstream data and serve the last valid observation during temporary provider outages.
3. Label propagated positions honestly: orbital animation is computed from public orbital elements, not direct spacecraft telemetry.
4. Preserve source/observation metadata so freshness can be judged.
5. NASA/NOAA data controls observed macro phenomena; cinematic 3D reconstruction must not be presented as measured 3D geometry.
6. Conjunction screening based on public elements must not be presented as an operational collision probability.
7. Never imply that public catalogs contain every physical or classified object.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the remaining product phases.

## License

MIT for this repository's code. External data, imagery and APIs retain their own terms and attribution requirements.
