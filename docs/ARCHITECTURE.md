# Architecture

## Goal

Human Space Atlas unifies two scales that are usually presented separately:

1. Earth-orbiting artificial objects: payloads, rocket bodies and debris.
2. Human deep-space missions: spacecraft whose public ephemerides are available from JPL Horizons or compatible sources.

## Data flow

```text
CelesTrak OMM/JSON ----> API cache ----> browser ----> satellite.js / SGP4 ----> CesiumJS
JPL Horizons ----------> API cache ----> browser ----> deep-space provider ------> CesiumJS
```

## Why OMM first

The application does not use TLE as the primary internal contract. The public catalog has crossed the historical five-digit NORAD identifier limit, so new work should accept OMM/JSON identifiers without relying on fixed-width TLE fields.

## Performance strategy

- Do not create one React component per space object.
- Render bulk Earth-orbit objects with Cesium `PointPrimitiveCollection`.
- Propagate orbital state in batches/worker threads as scale grows.
- Cache source orbital elements server-side; do not poll CelesTrak continuously from every browser.
- Only draw expensive orbit polylines/models for selected or highlighted objects.

## Planned layers

### Earth orbit
- OMM ingestion
- SGP4 propagation
- Search/filter
- selected orbit path
- satellite/debris/rocket-body semantics

### Deep space
- JPL Horizons adapter
- heliocentric and body-centric reference frames
- dynamic scale transitions
- mission metadata and timeline

### Intelligence / education
- launch families
- conjunction context
- re-entry events
- mission stories
- observer/pass predictions
