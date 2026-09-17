# #800: shadow options on three 0.186

three r186 removed `PCFSoftShadowMap`. The `high` preset (`src/render/quality.ts`) asks for it, and
r186 quietly substitutes `PCFShadowMap` with the default `shadow.radius` of 1. The console says so:
"THREE.WebGLShadowMap: PCFSoftShadowMap has been removed. Using PCFShadowMap instead."

## Files

- `high-options.png`: the `high` preset. A is today (three 0.169, PCFSoft). B is #800 unchanged.
  C is 0.186 with PCF and `sun.shadow.radius` 1.625. D is 0.186 with VSM, radius 2.25 and
  blurSamples 8. All four use a 2048 map and the same bias and normalBias.
- `medium-low-before-after.png`: the `medium` (PCF 1024) and `low` (Basic 512) presets on 0.169
  and on 0.186, with settings unchanged.

## How they were made

Every image comes from the game's real `createRenderer` with each preset's settings on
`createArenaWorld(1)` (level 1 start). Each frame was rendered 30 times and then captured with
`captureFrame()`. The shots were taken in Chromium 151 with SwiftShader, at a 1600x1000 viewport and
devicePixelRatio 1. The gallery tool could not be used: its renderer never enables shadows.

Each column shows three views:

- the whole frame at 30%;
- a 160x100 crop around the centre wall's right shadow edge, enlarged 3x with nearest-neighbour
  scaling;
- the same edge seen from a near-top-down camera, at 800 px per world unit (about 12 px per
  shadow texel).

## Measurements

**Edge width.** This is the 10-90% width of the centre wall's right shadow edge in the zoomed
view, averaged over 40 rows, using 8-bit gray levels:

| Capture | Width | Against today |
| --- | --- | --- |
| A, today | 33.0 px | reference |
| B, #800 as it stands | 22.5 px | 32% narrower |
| C, PCF radius 1.625 | 33.1 px | the same |
| D, VSM radius 2.25 | 31.9 px | 3% narrower |
| PCF radius 2 | 39.8 px | 21% wider |
| VSM with default radius | 17.4 px | 47% narrower |
| Medium, 0.169 | 50.9 px (rows range 39-70) | reference for medium |
| Medium, 0.186 | 44.9 px (rows range 40-48) | 12% narrower, more even |
| Low, both versions | under 1 px (hard edge) | unchanged |

A second, independent profiler measured the same edges on two more edges and the whole frame.
It found the same ordering: B is 28-31% narrower than A when zoomed, and C and D are within
about 5% of A.

**Determinism.**

- Repeat captures of A and of B are byte-identical in all 4 views.
- B is byte-identical to an explicit PCF radius 1 in all 4 views.

**Brightness.** Lit felt is 1-2 gray levels darker on 0.186 than on 0.169, whatever the shadow
setting, in all three preset pairs. The cause was not investigated.

## Not covered

- One scene, one sun direction, one camera, devicePixelRatio 1, and SwiftShader rather than a
  hardware GPU.
- No frame-time cost was measured. VSM adds two full-screen blur passes over the 2048 shadow map
  each time the map renders, and the game leaves `shadowMap.autoUpdate` at its default of every
  frame.
- VSM light bleeding was checked by eye in one crop only, and this scene has few overlapping
  occluders.
