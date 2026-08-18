# Earth Experience — Visual QA

Use this checklist whenever imagery streaming, terrain, clouds, night lights, atmosphere or Explore rendering changes.

## Automated browser smoke

1. Start the app with `npm run dev`.
2. In another terminal run `npm run smoke:earth`.
3. Screenshots are written to `artifacts/earth-smoke/atlas.png` and `artifacts/earth-smoke/explore.png`.
4. The smoke fails on JavaScript/WebGL/Cesium runtime errors or invalid canvas dimensions.

To run against a deployment:

```bash
HSA_SMOKE_URL=https://your-deployment.example npm run smoke:earth
```

## Manual visual matrix

Test with Chrome hardware acceleration enabled. Software-rendered/headless FPS is not representative.

| Scene | Altitude | Clouds | Shadows | Expected result |
| --- | ---: | --- | --- | --- |
| Atlas global | 2,000–18,000 km | 75–100% | ON | Discrete NASA weather systems, no global white fog, no rectangular imagery gaps |
| Explore high LEO | ~440 km | 75–100% | ON | NASA far-field is dominant; a very subtle 3D layer adds parallax, never isolated white dots |
| Explore transition | ~300 km | 75–100% | ON | Smooth blend between map cloud field and layered 3D volumes; no pop when crossing LOD |
| Explore low LEO | ~180–220 km | 75–100% | ON | Clearly visible cloud height and depth; bases/caps move with perspective as the camera orbits |
| Explore very low | ~120–150 km | 75–100% | ON | Layered cloud banks remain volumetric without covering the whole horizon like fog |
| Explore low LEO | ~180 km | 100% | OFF | Same cloud geometry without surface shadow ellipses |
| Day | any | ON | ON | VIIRS city layer is fully hidden on the lit side |
| Terminator | any | ON | ON | City lights and atmosphere fade in progressively; no tile-shaped flashes |
| Night/eclipsed | any | ON | ON | VIIRS is strong only after globe tiles stabilize; aurora remains independent |

## Texture-streaming regression checks

- Rotate and zoom continuously for at least 30 seconds over ocean/continent boundaries.
- Switch through all available map styles repeatedly, including returning to Satellite.
- During each style swap the previous base map must remain visible while the replacement fades in.
- No white, gray or flat-color rectangles may appear during provider loading.
- Explore should prefetch the 3x3 imagery neighborhood in front of the camera; fast forward motion should refine ahead rather than behind the camera.
- External provider failures may temporarily reduce detail, but a valid ancestor texture or the previous style must remain visible.

## Cloud-specific checks

The 3D Explore cloud geometry is a cinematic reconstruction, not a NASA voxel product. NASA observations control macro placement, top height and optical thickness; Cesium native cloud volumes provide the microstructure.

- Dense systems should have a broad lower bank, a main body and, when optical thickness supports it, a smaller raised crown.
- Thin clouds should stay flatter and use two layers rather than a fake convective tower.
- Camera orbiting around the ship must reveal altitude separation/parallax between the layers.
- At ~440 km the 3D component must be subtle; it exists only to keep depth cues during the handoff to the far-field map.
- No billboard cards, flat cloud sprites or giant rectangular cloud plates are allowed.

## Performance acceptance

- Catalog worker and camera remain responsive while imagery prefetch runs.
- Prefetch is throttled and limited to nine tiles per pass.
- Base-map warmup has a fixed request budget and adapts down on data-saver/slow connections.
- Cloud rendering is capped by macro seeds and rendered sub-volume limits.
- Repeated style changes reuse warmed providers instead of recreating them.
