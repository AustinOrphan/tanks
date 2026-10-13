# Issue #1057: visual evidence (media-1057)

- Branch `feat/owner-palette-flag`, HEAD `fe00e97be3a69fc328116a862d7019daf000b934` (`git rev-parse HEAD`, recorded at the start and unchanged).
- `origin/main` `52f04b11b470b127e781b95cdff1d5ec6067d32b`, which is also the branch's merge base, so "main" below is exactly the tree the branch forks from.
- Made 2026-10-13 (UTC) on an Apple M1 Max, macOS 26.5.2; headless Chromium 151.0.7922.34 (Playwright), `--use-gl=swiftshader` (SwiftShader via ANGLE/Vulkan); ffmpeg 9.0.2.
- Nothing tracked was modified, committed or pushed. The branch and main were built into `w1057/dist-branch` and `w1057/dist-main` (outside the worktree; the worktree's own `dist/` is untouched). Gallery output went to the worktree's gitignored `gallery-out/` and was copied here. Scripts are in `w1057/media-scripts/`.
- Not done here: publishing to `pr-media` under `issue-586/` and embedding in the PR (the task forbids pushing).

## 1. Classic byte-identical: gallery stills

```sh
# branch (worktree at HEAD); the gallery passes no ownerPalette at all, so the flag is absent by construction
npm run gallery -- --elements identity,coop --out gallery-out/media-1057-branch
# origin/main: git archive origin/main | tar -x -C w1057/main-src; ln -s <worktree>/node_modules w1057/main-src/node_modules
(cd w1057/main-src && npm run gallery -- --elements identity,coop --out gallery-out/media-1057-main)
```

What was compared: the one file each run writes, `frame.png` (640x480 PNG of the gallery canvas): the `identity` subject (4 player tanks, slots 0-3, four body angles, `shape`-free solid rings because the gallery passes no marker) and the `coop` subject (2 player tanks with one tinted shell each), side by side. The gallery calls `createEntityViews` with no `ownerPalette` argument (`src/render/gallery/subjects.ts:549`; nothing under `tools/gallery` or `src/render/gallery` names a palette), so this compares the DEFAULT-ARGUMENT path of the renderer, not the session path that reads the flag (section 1b covers that).

| pair | md5 A | md5 B | differing pixels |
| --- | --- | --- | ---: |
| main vs branch | `ffdd9f247c641946d245a059c2fe0ce3` | `ffdd9f247c641946d245a059c2fe0ce3` | 0 / 307200 |
| main vs negative control | `ffdd9f247c641946d245a059c2fe0ce3` | `454a3d786a8405f02df7da56acc33f10` | 2312 / 307200 (bbox [137, 219, 502, 263]) |

**Equal md5**, and the decoded pixels agree too. The negative control is a scratch copy of the branch (`git archive HEAD`, `w1057/ctl-src`) with `DEFAULT_OWNER_PALETTE` set to `'high-contrast'` in `src/presentation/identity.ts` (the edit the mutation entry `default-owner-palette-moves-off-classic` makes): its still differs from main's, only within the row of posed tanks (the bbox above), so the comparison can see a palette change on this path.

## 1b. Supplementary: the real game with the flag absent, main vs branch

The lossless first-playing screenshots of section 3 were also taken from `dist-main` with the flag absent, and the branch flag-absent arms were taken a second time as a run-to-run control (`first-playing-all.sh`, all eight runs repeated a second time with identical md5s).

| pair | md5 A | md5 B | differing pixels |
| --- | --- | --- | ---: |
| first-playing ffa: main vs branch (flag absent) | `d031c1efa68130575222e2b1b2fab0ba` | `d031c1efa68130575222e2b1b2fab0ba` | 0 / 400000 |
| first-playing ffa: branch run 1 vs run 2 (flag absent) | `d031c1efa68130575222e2b1b2fab0ba` | `d031c1efa68130575222e2b1b2fab0ba` | 0 / 400000 |
| first-playing teams: main vs branch (flag absent) | `38485d7d8d6fdba299edc9abf980e952` | `38485d7d8d6fdba299edc9abf980e952` | 0 / 400000 |
| first-playing teams: branch run 1 vs run 2 (flag absent) | `38485d7d8d6fdba299edc9abf980e952` | `38485d7d8d6fdba299edc9abf980e952` | 0 / 400000 |
| first-playing ffa: classic vs high-contrast (control: the flag changes the frame) | `d031c1efa68130575222e2b1b2fab0ba` | `778b0f08fd767d677bb184523f9c2d9b` | 1698 / 400000 |
| first-playing teams: classic vs high-contrast (control: the flag changes the frame) | `38485d7d8d6fdba299edc9abf980e952` | `7ca0f8df55702dee18713eda0a971526` | 1875 / 400000 |

So in both modes the branch with the flag absent draws the same bytes as main at this frame, and setting the flag changes 1698 (FFA) / 1875 (Teams) pixels. Limits: one frame per mode, during the round-start countdown, so it covers the identity rings, the stock chips and everything static; shell tints, tread trails, death pulses and the death vignette are not on screen in it.

## 2. Recordings (evidence for the eye, not the pixel check)

```sh
node tools/screens/record.mjs --flow versus-round --mode <ffa|teams> --players 4 --bots 4 --level 4 \
  --seed 20260921 --driver autoplay --seconds 8 --fps 30 --w 800 --h 500 --dpr 1 --visual software-gl \
  --stop window [--flag ownerPalette=high-contrast] --dist w1057/dist-branch \
  --out recordings/<arm>/frames --report recordings/<arm>/report.json --timeout 180000
ffmpeg -framerate 30 -start_number 0 -i frame-%04d.png -frames:v 240 -an -c:v libx264 -preset medium \
  -crf 18 -pix_fmt yuv420p -movflags +faststart <arm>.mp4   # tools/capture/media.mjs mp4Arguments
```

| arm | page URL | mp4 | sim ticks/s | render fps | frames over the 250 ms clamp | screencast frames | refused / unknown params | page errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| `ffa-classic` | `?dev=1&replay=1&level=4&seed=20260921&mode=ffa&players=4&bots=4&autoplay=1` | 335518 B | 58.1 | 30.5 | 2 (233 ms lost) | 244 | 0 / 0 | 0 |
| `ffa-high-contrast` | `?dev=1&replay=1&level=4&seed=20260921&mode=ffa&players=4&bots=4&autoplay=1&ownerPalette=high-contrast` | 326383 B | 57.9 | 29.9 | 2 (268 ms lost) | 240 | 0 / 0 | 0 |
| `teams-classic` | `?dev=1&replay=1&level=4&seed=20260921&mode=teams&players=4&bots=4&autoplay=1` | 349361 B | 59.2 | 31.1 | 2 (92 ms lost) | 249 | 0 / 0 | 0 |
| `teams-high-contrast` | `?dev=1&replay=1&level=4&seed=20260921&mode=teams&players=4&bots=4&autoplay=1&ownerPalette=high-contrast` | 346655 B | 59.2 | 30.3 | 2 (92 ms lost) | 243 | 0 / 0 | 0 |

Every arm: arena `arena-04` = the expected arena for level 4, seed 20260921, practice round, 240 PNG frames at 800x500 (none mismatched), surface `playing` at start and end (`--stop window`). The page's own diagnostics accepted every requested parameter, including `ownerPalette=high-contrast`; `disarmed` is reported in effect without being requested in all four arms (the sandbox default, unrelated). The build commit reads as unknown because these dists were built with `vite build` directly, without the CI commit stamp.

Files: `recordings/<arm>.mp4`, `recordings/<arm>/frames/frame-0000..0239.png`, `recordings/<arm>/report.json`, `recordings/summary.json`. `recordings/contact-frame-0030.png` is frame 30 of each arm in a 2x2 grid, unlabelled (this ffmpeg has no drawtext): top left ffa-classic, top right ffa-high-contrast, bottom left teams-classic, bottom right teams-high-contrast.

Caveats, as the issue says: autoplay runs diverge, so the arms are not tick-aligned and no frame is claimed like-for-like; the screencast is JPEG quality 90 before PNG, which smears hue on a thin ring. Each arm also has 2 render gaps over the 250 ms catch-up clamp (92-268 ms of simulated time lost per 8 s).

## 3. Pixels: lossless first-playing screenshots, ring band classified under CIEDE2000

```sh
node w1057/media-scripts/first-playing.mjs --dist w1057/dist-branch --mode <ffa|teams> --palette <absent|high-contrast> --out pixels/<arm>
(cd <worktree> && node_modules/.bin/vite-node w1057/media-scripts/ring-pixels.ts)   # then rim-check.py, cyan-gap.ts, mask-sheet.py
```

**The shot.** `first-playing.mjs` boots the build exactly as `record.mjs` does (its server, launch arguments, 800x500 at DPR 1, storage seed, `versus-round` steps and diagnostics detour), waits with `page.waitForFunction` (rAF polling) for `record.mjs`'s own playing predicate, and immediately takes `page.screenshot({ type: 'png' })`. The state read just before and just after the shot both show the round-start countdown up (`.hud-count` visible, text "3") and replay ticks below `COUNTDOWN_TICKS` (180), and `sim/round.ts` forbids fire during the countdown, so no shot had been fired:

| arm | ticks before / after the screenshot | countdown before / after | png md5 |
| --- | --- | --- | --- |
| `ffa-classic` | 35 / 49 | yes / yes | `d031c1efa68130575222e2b1b2fab0ba` |
| `ffa-high-contrast` | 35 / 49 | yes / yes | `778b0f08fd767d677bb184523f9c2d9b` |
| `teams-classic` | 34 / 47 | yes / yes | `38485d7d8d6fdba299edc9abf980e952` |
| `teams-high-contrast` | 35 / 48 | yes / yes | `7ca0f8df55702dee18713eda0a971526` |

**The ring band is geometry, not colour.** `ring-pixels.ts` rebuilds each player tank's identity-ring mesh from the game's own modules: the world from `createWorldFor(arenaById('arena-04'), 20260921, { playerCount: 4, rules: { mode } })` (checked against the page's replay meta: seed, arena, mode), the ring from `identityMarkerGeometry(sessionIdentityMarker(null, mode), slot, IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R, 48)` or `RingGeometry` (FFA draws the shipped `shape` marker, Teams the plain annulus), the camera from `PerspectiveCamera(BASE_FOV)` + `fitCameraToArea` at the canvas's measured 800x500, and rasterises the projected triangles at pixel centres. `pixels/mask-sheet-ffa.png` and `mask-sheet-teams.png` show the result against both arms (8x crops; white = band pixel that changes between the arms, red = band pixel that does not, blue = changed pixel outside every band): the band lands on the drawn rings, and the red runs are exactly where the hull, the turret or a wall in front hides the ring.

**Two populations.** (a) *band*: every band pixel (no band pixel falls under a painted HUD box). (b) *owner-colour*: the band pixels whose RGB differs between the Classic and High contrast arms of the same mode. The first-playing frame is deterministic (section 1b: same build, same bytes), so the two arms differ only where an owner colour reaches the screen; (b) is the same pixel set in both arms, chosen without reference to either palette. Every pixel that differs between the arms is accounted for:

| mode | pixels differing between arms | under a HUD box (chips) | in a ring band | outside every band | of those, within 1 px of a band |
| --- | ---: | ---: | ---: | ---: | ---: |
| ffa | 1698 | 1174 | 384 | 140 | 140 |
| teams | 1875 | 1228 | 532 | 115 | 115 |

So the arms differ only in the HUD chips, the ring bands and their one-pixel anti-aliased rim (the rim is not classified).

**References, measured from the Classic arm first.** Per tank, the as-rendered Classic ring colour is the per-channel median of its owner-colour pixels in the Classic arm:

| mode | slot | team | band px | owner-colour px | authored Classic | measured Classic | offset (R,G,B) | authored High contrast | measured High contrast | spec model | spec model error | tone-mapped model | tone-mapped error |
| --- | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | ---: | --- | ---: |
| ffa | 0 | - | 124 | 86 | `#3fd0ff` | `#88c7cf` | 73, -9, -48 | `#63d1fd` | `#96c7ce` | `#acc8cd` | 5.23 | `#95c7cf` | 0.4 |
| ffa | 1 | - | 285 | 74 | `#ff8a1e` | `#d8ad4a` | -39, 35, 44 | `#8ffd00` | `#b6da72` | `#68ff2c` | 13.68 | `#b6da73` | 0.15 |
| ffa | 2 | - | 164 | 72 | `#ff4d2e` | `#dd7847` | -34, 43, 25 | `#fdbbc6` | `#cdc5c4` | `#dbe6df` | 12.5 | `#cdc8c6` | 1.75 |
| ffa | 3 | - | 201 | 152 | `#9d3bff` | `#b252d4` | 21, 23, -43.5 | `#fdfdbb` | `#ccd5c2` | `#ffff90` | 20.78 | `#ced9c2` | 1.8 |
| teams | 0 | A | 152 | 97 | `#ff3b3b` | `#db5f51` | -36, 36, 22 | `#63d1fd` | `#96c7ce` | `#3ff5ff` | 14.35 | `#96c7d4` | 2.56 |
| teams | 1 | B | 352 | 164 | `#fcc0fc` | `#cecad4` | -46, 9.5, -40 | `#c6fd00` | `#c5d976` | `#98ff00` | 14.16 | `#c4d976` | 0.23 |
| teams | 2 | A | 232 | 109 | `#ff3b3b` | `#dd6752` | -34, 44, 23 | `#63d1fd` | `#99cdd2` | `#41fdff` | 14.62 | `#98cfd5` | 0.72 |
| teams | 3 | B | 250 | 162 | `#fcc0fc` | `#cbc4d0` | -49, 3.5, -44.5 | `#c6fd00` | `#c2d473` | `#95ff00` | 15.06 | `#c1d372` | 0.24 |

Three reference sets, each giving 8 candidates in FFA (4 rings per palette) and 6 in Teams (3 teams per palette; the issue's "3 teams each"), and each pixel goes to the nearest candidate by `distance` from `src/presentation/colour-distance.ts` (CIEDE2000):

- **spec**: the issue's method. Per tank, offset = measured Classic - authored Classic (per sRGB channel); every candidate + that offset, clamped. In the Classic arm this is close to self-referential (the tank's own Classic reference IS its measured median), so the Classic-arm row mostly checks consistency and the High contrast row carries the evidence. The model's error column shows the additive offset does not transfer well between colours: 5.2-20.8 off the measured High contrast colour, because the ring is tone mapped.
- **tone-mapped**: the same Classic measurement, modelled through what the shader does. `scene.ts` sets ACES filmic tone mapping at exposure 1.35 and the ring's `MeshBasicMaterial` is tone mapped by default, so as-rendered = 0.85 x T(colour) + 0.15 x F, with T = three r186's ACES + sRGB OETF (transcribed from its shader chunks) and F, the lit felt under that ring, solved from the Classic measurement. It predicts the measured High contrast colour within 0.15-2.56, which is what makes it the most trustworthy of the three. (The solved F differs from felt sampled 2-4 px outside the band by 0.6-15.8; the felt next to the ring is not the felt under it.)
- **overFelt**: the repository's model, `overFelt(colour)` (alpha 0.85 over `#2f6d4f`), no measurement. Included to show why the issue says to measure: it misorders the Teams Classic arm.

**Counts per palette per arm** (pixels nearest a Classic candidate / nearest a High contrast candidate, of the population n):

| arm | population | spec | tone-mapped | overFelt |
| --- | --- | --- | --- | --- |
| `ffa-classic` | owner-colour, n = 384 | 384 C / 0 HC | 375 C / 9 HC | 290 C / 94 HC |
| `ffa-classic` | band, n = 774 | 771 C / 3 HC | 742 C / 32 HC | 657 C / 117 HC |
| `ffa-high-contrast` | owner-colour, n = 384 | 119 C / 265 HC | 60 C / 324 HC | 18 C / 366 HC |
| `ffa-high-contrast` | band, n = 774 | 506 C / 268 HC | 427 C / 347 HC | 385 C / 389 HC |
| `teams-classic` | owner-colour, n = 532 | 506 C / 26 HC | 469 C / 63 HC | 239 C / 293 HC |
| `teams-classic` | band, n = 986 | 960 C / 26 HC | 878 C / 108 HC | 648 C / 338 HC |
| `teams-high-contrast` | owner-colour, n = 532 | 67 C / 465 HC | 106 C / 426 HC | 59 C / 473 HC |
| `teams-high-contrast` | band, n = 986 | 521 C / 465 HC | 515 C / 471 HC | 468 C / 518 HC |

Per tank, owner-colour population, tone-mapped references (C / HC):

| arm | slot 0 | slot 1 | slot 2 | slot 3 |
| --- | --- | --- | --- | --- |
| `ffa-classic` | 84 / 2 | 67 / 7 | 72 / 0 | 152 / 0 |
| `ffa-high-contrast` | 31 / 55 | 10 / 64 | 8 / 64 | 11 / 141 |
| `teams-classic` | 97 / 0 (team A) | 139 / 25 (team B) | 109 / 0 (team A) | 124 / 38 (team B) |
| `teams-high-contrast` | 0 / 97 (team A) | 51 / 113 (team B) | 7 / 102 (team A) | 48 / 114 (team B) |

Median CIEDE2000 from each owner-colour pixel to the nearest candidate of each palette (tone-mapped references): `ffa-classic` C 1.94 / HC 28.14; `ffa-high-contrast` C 16.1 / HC 2.16; `teams-classic` C 2.13 / HC 13.89; `teams-high-contrast` C 12.83 / HC 1.94.

**What the counts show.**

- On the owner-colour pixels the ordering holds in all four arms under the spec references and under the tone-mapped references: each Classic arm's pixels fall nearer Classic colours and each High contrast arm's nearer High contrast colours. The overFelt references get the ordering right in three arms and wrong in teams-classic (239 C / 293 HC), because unmeasured, Classic team B renders as a near-grey that sits nearer High contrast team C.
- **Slot 0 cannot carry the claim in FFA.** Classic ring 0 `#3fd0ff` and High contrast ring 0 `#63d1fd` are 2.15 apart as authored and 2.60 as rendered (`#88c7cf` vs `#96c7ce`), about one just-noticeable difference. Its 86 owner-colour pixels do change between the arms, and the tone-mapped model predicts the High contrast median within 0.40, but the nearest-colour verdict for slot 0 depends on the model: the spec references put all 86 High contrast-arm pixels on Classic (and all 86 Classic-arm pixels too), the tone-mapped ones give 84 C / 2 HC in the Classic arm and 31 C / 55 HC in the High contrast arm. Slots 1-3 differ by 22.2, 27.5 and 51.8 as rendered and go to the right palette for 86-100% of their pixels under tone-mapped references (per-tank table; the low end is slot 1 in the High contrast arm, 64 of 74). In Teams, team A is cyan in High contrast and red in Classic (44.6 apart as rendered): its two tanks put 206 of 206 Classic-arm pixels on Classic and 199 of 206 High contrast-arm pixels on High contrast. Team B (32.5 apart) is the weak side: 99 of its 326 High contrast-arm pixels (30%) go to a Classic candidate under tone-mapped references, and Classic team C `#4eff3b`, a green that is not on screen in a 2v2 but is a candidate, collects 63 of the arm's 106 Classic-assigned pixels.
- **Palette right, colour often wrong under the spec references.** The additive offset puts High contrast ring 3 at `#ffff90` and team B at `#98ff00` against measured `#ccd5c2` and `#c5d976`, so in ffa-high-contrast no owner-colour pixel goes to High contrast ring 3 (slot 3's land on High contrast ring 0, which collects 140 against slot 0's 86) and in teams-high-contrast none goes to High contrast team B (299 go to High contrast team C). The palette-level counts survive that; a per-colour claim would not. The tone-mapped references assign by colour far better: High contrast ring 3 collects 126 pixels (slot 3 has 152 owner-colour pixels) and High contrast team B 226 (team B has 326). Per-candidate counts for every arm, method and population are in `ring-pixels.json` (`byCandidate`).
- **The raw band does not show the ordering in the High contrast arms** (e.g. ffa-high-contrast, spec: 506 C / 268 HC; tone-mapped 427 C / 347 HC). Only half the band is owner colour: 390 of 774 FFA band pixels and 454 of 986 Teams band pixels are the same bytes in both arms (hull, turret and a front wall over the ring; see the red runs in the mask sheets), and those dark magenta/blue/grey occluder pixels sit nearer the saturated Classic candidates than the pale High contrast ones (under the spec references 387 of the 390 FFA occluder pixels go to a Classic candidate, in both arms). Being identical in both arms, they add the same counts to both and carry no palette information; the arm-to-arm movement is entirely in the owner-colour pixels.

## 4. Stock chips: computed DOM colour (exact)

`getComputedStyle(chip).color` for every `.hud-versus-stock-entry`, read in the same page right after the screenshot, against the palette colour for its slot (FFA: `rings[slot]`) or its team (Teams: `teams[team]`, team from `createWorldFor`, i.e. `teamOf(slot)` = slot % 2). In FFA the chip's `shape` glyph strokes with `currentColor`; every glyph stroke's computed colour was compared too. Teams chips carry no glyph.

| arm | chips / tanks | chip: computed = expected | glyph strokes equal |
| --- | --- | --- | --- |
| `ffa-classic` | 4 / 4 | P1 3: `rgb(63, 208, 255)` = `rgb(63, 208, 255)`; P2 3: `rgb(255, 138, 30)` = `rgb(255, 138, 30)`; P3 3: `rgb(255, 77, 46)` = `rgb(255, 77, 46)`; P4 3: `rgb(157, 59, 255)` = `rgb(157, 59, 255)` | yes, all |
| `ffa-high-contrast` | 4 / 4 | P1 3: `rgb(99, 209, 253)` = `rgb(99, 209, 253)`; P2 3: `rgb(143, 253, 0)` = `rgb(143, 253, 0)`; P3 3: `rgb(253, 187, 198)` = `rgb(253, 187, 198)`; P4 3: `rgb(253, 253, 187)` = `rgb(253, 253, 187)` | yes, all |
| `teams-classic` | 4 / 4 | P1 A 3: `rgb(255, 59, 59)` (team A) = `rgb(255, 59, 59)`; P2 B 3: `rgb(252, 192, 252)` (team B) = `rgb(252, 192, 252)`; P3 A 3: `rgb(255, 59, 59)` (team A) = `rgb(255, 59, 59)`; P4 B 3: `rgb(252, 192, 252)` (team B) = `rgb(252, 192, 252)` | n/a |
| `teams-high-contrast` | 4 / 4 | P1 A 3: `rgb(99, 209, 253)` (team A) = `rgb(99, 209, 253)`; P2 B 3: `rgb(198, 253, 0)` (team B) = `rgb(198, 253, 0)`; P3 A 3: `rgb(99, 209, 253)` (team A) = `rgb(99, 209, 253)`; P4 B 3: `rgb(198, 253, 0)` (team B) = `rgb(198, 253, 0)` | n/a |

All 16 chips (4 per arm, 4 arms) equal their palette colour exactly; all 8 FFA glyphs follow their chip.

## Problems and limits

- FFA slot 0 is effectively the same cyan in both palettes (2.15 apart authored, 2.60 as rendered), so the ring pixels cannot show slot 0 following the palette; the exact chip check does (`rgb(63, 208, 255)` to `rgb(99, 209, 253)`), and its ring pixels do change between the arms. This is a property of the #1056 palette, not of this branch's threading.
- The issue's additive-offset reference misses the measured High contrast colours by 5.2-20.8 (ACES tone mapping is not additive). The palette-level ordering still holds on the owner-colour pixels, but the per-colour assignment it gives is wrong for High contrast ring 3 and team B; the tone-mapped model (0.15-2.56) is the better reference.
- On the raw geometric band the High contrast arms do not order correctly (FFA 506 C / 268 HC, Teams 521 C / 465 HC under the spec references), because half the band is occluded by hulls, turrets and a wall, and those identical-in-both-arms pixels sit nearer Classic. The ordering claim rests on the owner-colour subset.
- Only one frame per mode was compared byte-for-byte in the real game (section 1b), during the countdown: shell tints, tread trails, death pulses and the death vignette were not on screen in any lossless shot. The recordings show them for the eye only.
- Not published to `pr-media` and not embedded in a PR (no pushing in this task). The diagnostics show the build commit as unknown because the dists were built with `vite build` directly.

## Files

- `gallery/{main,branch,control-default-high-contrast}/frame.png`, `gallery/md5.txt`, `gallery/md5-with-control.txt`, `gallery/*.log`
- `recordings/<arm>.mp4`, `recordings/<arm>/{frames/,report.json,record.log,encode.log}`, `recordings/summary.json`, `recordings/contact-frame-0030.png`
- `pixels/<arm>/first-playing.{png,json}` (the json holds the before/after state, chips, canvas layout and painted HUD boxes), `pixels/supplementary/` (main and repeat runs), `pixels/ring-pixels.json` (all counts, per tank and per candidate), `pixels/ring-masks.json` (band, owner-colour, felt and rim pixel indices), `pixels/mask-sheet-{ffa,teams}.png`, `pixels/cyan-gap.json`
- `image-diffs.json`: md5 and decoded-pixel comparison of every pair named above

