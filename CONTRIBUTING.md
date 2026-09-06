# Contributing to Human Space Atlas

Human Space Atlas combines scientific-data handling, orbital propagation, browser rendering and server-side upstream integration. Changes should preserve both software correctness and the project's explicit scientific-integrity boundaries.

## Local validation

```bash
npm ci
npm run check:server
npm test
npm run typecheck
npm run build
```

For visual changes, run the Earth smoke workflow when practical:

```bash
npm run smoke:earth
```

## Engineering expectations

- do not describe SGP4-propagated positions as direct telemetry;
- do not present visual reconstruction as measured 3D geometry;
- preserve source/provenance metadata when adding external data;
- keep upstream failures and stale-cache fallback visible in semantics;
- bound expensive public query surfaces;
- avoid browser exposure of private-scope credentials;
- add tests when changing cache, rate-limit, orbital or data-normalization behavior.

## Data-source changes

When adding or changing a provider, document:

- official source/provider;
- data contract and relevant timestamps;
- cache/retention behavior;
- failure/fallback semantics;
- limitations in completeness or precision;
- attribution/usage requirements when applicable.

## Performance-sensitive changes

Catalog rendering and propagation paths should avoid unnecessary object allocation and main-thread work. Benchmark or profile changes that materially affect large catalogs, Web Worker transfers or Cesium rendering.

## Pull requests

Keep PRs focused. Include the behavior changed, scientific/data assumptions, validation executed and any new environment variables or upstream dependencies.
