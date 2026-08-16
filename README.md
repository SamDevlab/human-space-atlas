# Human Space Atlas

A web-based 3D atlas of **human-made objects in space**, designed to connect Earth orbit (satellites, rocket bodies and debris) with public deep-space spacecraft ephemerides in one navigable product.

> Status: foundation/MVP scaffold. Earth-orbit rendering is wired; deep-space has a backend adapter scaffold and is the next major scene layer.

## Why this project

Excellent satellite trackers already exist. The product thesis here is broader: a clean, source-transparent interface for following *human presence in space* across scales and time, instead of building another isolated Earth-orbit dot map.

## Current MVP

- CesiumJS 3D Earth.
- CelesTrak OMM/JSON catalog ingestion through a local API proxy.
- Two-hour server-side cache for CelesTrak requests.
- SGP4 propagation in the browser with `satellite.js`.
- Fast point rendering with Cesium `PointPrimitiveCollection`.
- Catalog groups for stations, active satellites, Starlink and GPS.
- Object selection with NORAD metadata, altitude, speed and orbit trail.
- Time controls: pause, 1×, 10×, 100× and jump to now.
- JPL Horizons proxy endpoint scaffold for deep-space ephemerides.

## Stack

- React + TypeScript + Vite
- CesiumJS
- satellite.js (OMM + SGP4)
- Node built-in HTTP/fetch for the API proxy

## Quick start

Requirements: Node.js 22.13+.

```bash
cp .env.example .env
npm install
npm run dev
```

Then open the Vite URL printed in the terminal (normally `http://localhost:5173`). The API runs on `http://localhost:8787`.

### Optional Cesium ion token

The default globe can run without configuring private ion assets. If you choose to use Cesium ion terrain/imagery/assets, put a public read token in:

```env
VITE_CESIUM_ION_TOKEN=your_public_token
```

Do not put private-scope secrets in a browser environment variable.

## API endpoints

### Earth orbit

```text
GET /api/catalog?group=stations
GET /api/catalog?group=active
GET /api/catalog?group=starlink
GET /api/catalog?group=gps-ops
```

The API fetches CelesTrak using OMM-compatible JSON and caches each group for two hours.

### Deep space scaffold

```text
GET /api/horizons?command=<JPL_COMMAND>&start=2026-08-16&stop=2026-08-17&step=1%20h
```

This proxies JPL Horizons vector ephemerides. A curated mission registry and deep-space scene are planned for M2.

## Repository map

```text
src/
  components/Globe.tsx   Cesium scene + picking + point rendering
  lib/api.ts             browser API client
  lib/orbit.ts           OMM -> SatRec -> SGP4 -> geodetic state
  lib/types.ts           internal data contracts
server/index.mjs         CelesTrak + JPL proxy/cache
scripts/dev.mjs          starts API and Vite together
docs/ARCHITECTURE.md
docs/ROADMAP.md
docs/COMPETITIVE-NOTES.md
```

## Data-source principles

1. Prefer modern OMM/JSON contracts over TLE-only assumptions.
2. Cache upstream data; do not make every browser hammer orbital-data providers.
3. Label propagated positions honestly: the animation is computed from the latest public orbital elements, not direct spacecraft telemetry.
4. Preserve source and epoch metadata so users can judge freshness.
5. Never imply that public catalogs contain every physical or classified object.

## Near-term engineering work

See [`docs/ROADMAP.md`](docs/ROADMAP.md). The highest-value next task is bulk propagation in a Web Worker/WASM path so the full catalog remains smooth on typical machines.

## License

MIT for this repository's code. External data and APIs retain their own terms and attribution requirements.
