# Issue #357 / #1040: where the enemy role cue and the owner identity marker overlap, per slot

Everything here comes from commit `c63ea57815f265079f75539bde7194a4bf4f9458` on
`test/role-cue-identity-marker-overlap`, whose merge base with `main` is `main`'s tip at capture
time, `5d8d7de6df29eaebbb58f55de732c7372895ce75`. Captured 2026-10-10 (UTC). The cue is
`--enemyRole both`. The owner channel is the `shape` identity marker that #922 ships by default
for FFA, and the solid ring (no `--identityMarker`) that co-op and teams keep. In teams the ring
is drawn in team colours, not the slot colours these frames use; its geometry is the same. A
single-player session draws no ring at all (`identityApplies` needs two player tanks), so neither
count applies there. #1018's measurement of the cue against its own muzzle effects is in the
parent folder (`../README.md`), and its re-run after #1059 in `../rekey-1059/`.

**These are still frames and a pixel measurement. They are not a playtest or normal-speed play,
and no physical device was used.** The frames are for a person to judge. A pixel count does not
judge legibility (#1040, out of scope).

## Result

Population: 4 player slots x 2 owner channels (`shape`, solid ring) = 8 cells. One pose and two
frames per channel (with and without the cue): 640x480, view `game`, dpr 1, SwiftShader.

- **`shape` marker: the cue and the marker share pixels on slot 1 only, 5 px.** Slots 0, 2 and 3
  share 0.
- **Solid ring: the cue and the ring share pixels on slot 1 only, 6 px.** Slots 0, 2 and 3 share 0.
- Slot 1 is the tank posed at 90 degrees, facing the camera. Its riser sits on the hull's left
  flank and overhangs the hull outline just where the marker's top-left arm (or the ring's left
  side) passes behind the hull. With the riser drawn, 4 of those pixels (both channels) are ring
  pixels the riser hides. The other 1 (`shape`) or 2 (ring) pixels are pixels both draw into,
  which fits the riser's antialiased edge: part of the pixel is riser and part is the marker
  (inferred from where they sit, not checked per sample).
- No slot's ring shares a pixel with another slot's cue (0 in all 8 cells).

The cue on a player tank is the riser alone. A player fires a standard shell, so the flare lever
in `both` gives the shipped barrel (`weaponShapeFor` returns multiplier 1) and has no footprint.
That is construction, not a finding of zero overlap. The `cue is the riser alone` control below
measures it: with all four risers hidden, the `--enemyRole both` frame is identical to the frame
with no `--enemyRole` (0 of 307200 pixels differ). A player holds `MINE_LAYER` with
`mineCapacity` 2, so its riser is the middle step (`deckBar` 0.3, raised). The riser is the same
whether the block keys on raw capacity or on the ability (#1059 keyed it on the ability), so the
re-key does not affect these numbers.

## Frames

The posed `identity` element, from `src/render/gallery/subjects.ts`: four `player` tanks, one per
slot (`controlledBy` 0-3), 1.8 units apart, left to right. The body and turret angles are 0, 90,
180 and 45 degrees: gun pointing right, toward the camera, left, and right-and-toward. The camera
is the gallery's `game` view (direction `[0, 0.72, 0.86]`, FOV 38, distance fitted to the
element's span). It is not the in-match camera.

| File | What it holds |
| --- | --- |
| `shape-cue.png` | `--identityMarker shape --enemyRole both`, 640x480: the frame the cue footprints (and the cue-drawn owner footprint) are counted in; 0 of 307200 px from the CLI's frame |
| `shape-nocue.png` | the same with no `--enemyRole`: the frame the headline owner footprint is counted in; 0 of 307200 px from the CLI's no-`--enemyRole` frame |
| `ring-cue.png` | `--enemyRole both` with no `--identityMarker` (the solid ring), 640x480: the frame the cue footprints (and the cue-drawn owner footprint) are counted in; 0 of 307200 px from the CLI's frame |
| `ring-nocue.png` | the same with no `--enemyRole`: the frame the headline owner footprint is counted in; 0 of 307200 px from the CLI's no-`--enemyRole` frame |
| `cli-shape-cue.png`, `cli-ring-cue.png` | the gallery CLI's own `frame.png` with `--enemyRole both` |
| `cli-shape-nocue.png`, `cli-ring-nocue.png` | the gallery CLI's own `frame.png` with no `--enemyRole` |
| `shape-footprints.png`, `ring-footprints.png` | the footprint map: the `--enemyRole both` frame in dim grey, owner footprints (cue absent) yellow, cue footprints magenta, pixels in both white |
| `*-band-2x.png` | the `400x110+120+190` crop (the four tanks) of the frame or map, scaled 2x nearest-neighbour |
| `*-slot1-6x.png` | the `110x90+215+190` crop (slot 1) of the frame or map, scaled 6x nearest-neighbour |

The crops add no pixels. `scripts/crops.sh` (ffmpeg 9.0.2) makes them.

**The counted frames are the page's renders, and both match the CLI frames at the same size.**
The CLI cannot hide a mesh, so the counts come from `tools/gl/identity-cue-overlap-page.ts`. That
page builds the same pose through the gallery's own `buildGallery`, with the options
`tools/gallery/main.ts` passes, and supplies a renderer built the way `buildGallery` builds its
own. The counts use two page frames per channel: the frame with `--enemyRole both` (cue
footprints, and the cue-drawn owner footprint) and the frame with no `--enemyRole` (the headline
owner footprint). Each is identical to the CLI's PNG for the same flags: 0 of 307200 pixels
differ, for all four frames (2 channels x with and without the cue). The comparisons are not
vacuous: the page's `--enemyRole both` frame for each channel differs from the CLI's frame for
the other channel in 4528 pixels, and each page frame with no `--enemyRole` differs from the CLI's
`--enemyRole both` frame for the same channel in 490 pixels. `scripts/pixcheck.py` checks all of
this again outside the browser, decoding both PNGs with ffmpeg, and gets the same 0, 0, 0, 0,
4528, 490 and 490.

## Measurement

The runner first runs the gallery CLI twice per channel, with and without `--enemyRole both`,
then the page in Chromium with the CLI's own SwiftShader flags (`--use-gl=swiftshader
--enable-unsafe-swiftshader`). One rasteriser on both sides is what makes the frame match
possible, so there is no host-GPU mode. three 0.186.1,
Playwright 1.62.0. The run took 7.1 s, including the four CLI runs. Two runs at this commit gave
identical tables and byte-identical frames. The previous commit (`4210dfab`, 16 controls, two CLI
runs) gave the same table and byte-identical page frames and `--enemyRole both` CLI frames; an
earlier draft, without the covered column, gave the same counts and frames.

```sh
IDENTITY_CUE_DIR=<out> node tools/gl/identity-cue-overlap.mjs
```

The command writes `identity-cue-overlap.{json,md}`, the six page PNGs and the four CLI PNGs to
`<out>`, and prints the table. It exits 1 if a control fails. The CLI runs it makes are:

```sh
npm run gallery -- --elements identity --identityMarker shape --enemyRole both --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-shape-cue
npm run gallery -- --elements identity --enemyRole both --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-ring-cue
npm run gallery -- --elements identity --identityMarker shape --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-shape-nocue
npm run gallery -- --elements identity --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-ring-nocue
```

Then, from this folder:

```sh
sh scripts/crops.sh
python3 -I scripts/pixcheck.py shape-cue.png cli-shape-cue.png
python3 -I scripts/pixcheck.py ring-cue.png cli-ring-cue.png
python3 -I scripts/pixcheck.py shape-cue.png cli-ring-cue.png
python3 -I scripts/pixcheck.py shape-nocue.png cli-shape-nocue.png
python3 -I scripts/pixcheck.py ring-nocue.png cli-ring-nocue.png
python3 -I scripts/pixcheck.py shape-nocue.png cli-shape-cue.png
python3 -I scripts/pixcheck.py ring-nocue.png cli-ring-cue.png
```

Prerequisites: Playwright with Chromium (`npm i --no-save playwright@<the version ci.yml pins>`,
then `npx playwright install chromium`). Ports 5181 (the runner's vite) and 5599 (the CLI's) must
be free.

### Definitions

Each footprint is the set of pixels whose RGB differ between a draw and the same draw with one
mesh hidden (`visible = false` for that draw only, by wrapping the renderer's `render`).

- **Owner footprint, slot s:** hide slot s's `identity-ring` mesh, which `makeIdentityRing` names.
  It is the `shape` marker under `--identityMarker shape` and the ring without it. It is counted
  twice: in the frame with the cue absent (the headline), so a ring pixel the riser covers still
  counts, and in the frame with the cue drawn, which is the literal "same frame".
- **Cue footprint, slot s:** hide slot s's `mine-block` mesh (the riser) in the `--enemyRole both`
  frame.
- **Which slot a mesh belongs to:** a slot is its ring's colour (`IDENTITY_RING_COLORS[slot]`). A
  `mine-block` belongs to the slot whose ring is in the same tank group (a direct child of the
  scene). The `slots` control checks the result: four tanks, slots 0-3 in x order, one
  `mine-block` each with the cue and none without. The `cue attribution complete` control checks
  that the four slot footprints together are exactly the difference between the two arms (490 px),
  so no cue pixel is left unassigned.
- **Shared px:** owner (cue absent) and own cue, both containing the pixel. **Covered px:** the
  shared pixels outside the cue-drawn owner footprint, i.e. ring pixels the riser hides. **Shared
  px, cue-drawn owner:** owner (cue drawn) and own cue: pixels both draw into. **Shared px with
  other slots' cues:** owner (cue absent) and the other three slots' cue footprints.

### Results

| marker | slot | body angle | owner px, cue absent | owner px, cue drawn | cue px | shared px | covered px | shared px, cue-drawn owner | shared px with other slots' cues |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| shape | 0 | 0 deg | 812 | 812 | 188 | 0 | 0 | 0 | 0 |
| shape | 1 | 90 deg | 736 | 732 | 97 | 5 | 4 | 1 | 0 |
| shape | 2 | 180 deg | 763 | 763 | 30 | 0 | 0 | 0 | 0 |
| shape | 3 | 45 deg | 741 | 741 | 175 | 0 | 0 | 0 | 0 |
| ring | 0 | 0 deg | 873 | 873 | 188 | 0 | 0 | 0 | 0 |
| ring | 1 | 90 deg | 988 | 984 | 97 | 6 | 4 | 2 | 0 |
| ring | 2 | 180 deg | 928 | 928 | 30 | 0 | 0 | 0 | 0 |
| ring | 3 | 45 deg | 766 | 766 | 175 | 0 | 0 | 0 | 0 |

Slots with a nonzero shared count (population: 4 slots per channel): `shape` 1; ring 1. Under
either owner-footprint definition the list is the same.

The cue footprints are the same under both channels: the riser does not depend on the marker. They
sum to 490 px (188 + 97 + 30 + 175), which is the measured difference between the two arms. Slot 2
(180 degrees, gun pointing left) carries its riser on the far side of the hull, mostly behind the
dome, so it shows the least of it: 30 px.

### Controls (20, all pass)

| control | result | detail |
| --- | --- | --- |
| slots, shape | pass | 4 and 4 ringed tanks; want slots 0-3 by ring colour in x order, one mine-block each with the cue, none without |
| repeat draw identical, shape | pass | 0 pixels differ between the first and last full draw |
| cue is the riser alone, shape | pass | 0 pixels differ from no --enemyRole with all four mine-blocks hidden; 490 with them drawn |
| cue attribution complete, shape | pass | 490 pixels in the four slots' cue footprints, 490 between the arms |
| staging guard, shape | pass | 0 of 4 slots with an empty owner or cue footprint |
| a footprint against itself is all shared, shape | pass | 4 of 4 slots report their whole owner and cue footprint as shared with itself |
| disjoint rings share nothing, shape | pass | 0 pixels shared between different slots' rings |
| per-slot shared accounts for every owner and cue pixel, shape | pass | 5 pixels across the rows, 5 in all owner footprints and all cue footprints |
| (the same eight, ring) | pass | identical details, except the last: 6 pixels across the rows, 6 in all owner footprints and all cue footprints |
| page frame is the CLI frame, shape-cue | pass | 0 pixels differ from the CLI's shape-cue frame; 4528 from its ring-cue frame |
| page frame is the CLI frame, shape-nocue | pass | 0 pixels differ from the CLI's shape-nocue frame; 490 from its shape-cue frame |
| page frame is the CLI frame, ring-cue | pass | 0 pixels differ from the CLI's ring-cue frame; 4528 from its shape-cue frame |
| page frame is the CLI frame, ring-nocue | pass | 0 pixels differ from the CLI's ring-nocue frame; 490 from its ring-cue frame |

- **Staging guard:** every slot's owner footprint (cue absent, and cue drawn) and cue footprint is
  nonzero, for both channels. The guard also requires 4 cells per channel, so it cannot pass over
  no cells. No staging repair was needed. The smallest footprint is slot 2's riser, 30 px.
- **The failing control:** a footprint compared with itself must report its full size as shared.
  This holds for all 8 owner footprints and all 8 cue footprints. Its partner, `disjoint rings
  share nothing`, catches a shared count that ignores one side. In this frame no two slots' markers
  touch, so the expected count is 0, and 0 is measured for both channels.
- **Per-slot pairing:** the self-shared control tests `sharedCount` alone, not the pairing of
  slot s's owner footprint with slot s's cue footprint that produces the rows. So the rows' shared
  and other-slot columns, summed over the 4 slots, must equal the pixels shared by all 4 owner
  footprints and all 4 cue footprints taken whole, which no pairing touches. The sum is exact
  while no pixel is in two owner footprints (`disjoint rings share nothing`) or two cue footprints
  (the four cue footprints sum to 490 px, the size of their union); a violation would fail the
  control, not pass it.
- Every frame also passes #1018's cleared-buffer guard (at least 8 sampled colours), or the page
  throws.

#### Negative controls, run by hand

At this commit, in a scratch copy of the tree (an archive of the commit plus a copy of
`node_modules`, never the working checkout), each mutation was applied, the runner was run, and
the file was restored. Each one makes its named control FAIL for both channels, and the runner
exits 1 (11 of 11). `scripts/negatives.py` runs them: `python3 -I scripts/negatives.py <tree>
<out.json>`.

| Mutation | Control that fails | Detail when it fails (shape; ring) |
| --- | --- | --- |
| `sharedCount` always returns 0 | a footprint against itself is all shared | 0 of 4 slots |
| `sharedCount` counts all of `b`, ignoring `a` | disjoint rings share nothing | 4485; 5142 pixels |
| the render wrapper hides nothing | staging guard | 4 of 4 slots empty (also fails the self-shared, attribution and riser controls) |
| tanks sorted by descending slot | slots | fails |
| slot 3 left out of the cue union | cue attribution complete | 315 of 490 pixels |
| only three of the four risers hidden | cue is the riser alone | 188 pixels differ |
| the last full draw hides slot 0's ring | repeat draw identical | 812; 873 pixels |
| the page's renderer built without `antialias` | page frame is the CLI frame (all four) | with the cue 4393; 4220 pixels, without it 4348; 4175 |
| the rows pair slot s's owner with slot s+1's cue | per-slot shared accounts for every owner and cue pixel | 0 vs 5; 0 vs 6 pixels |
| the gallery CLI draws the riser when `--enemyRole` is absent (`tools/gallery/main.ts`, posed branch) | page frame is the CLI frame, `-nocue` | 490; 490 pixels |
| the cue-absent rig built without `antialias` | page frame is the CLI frame, `-nocue` (also the riser and attribution controls) | 4348; 4175 pixels |

Two of these show a gap the previous commit (`4210dfab`) left open. Under the pairing mutation it
passed all 16 controls and exited 0 while reporting `none` for both nonzero-slot lists. Under the
gallery CLI mutation it also passed all 16 and exited 0, because it compared only the
`--enemyRole both` frames with the CLI. The cue-absent rig without `antialias` was already caught
there, by `cue is the riser alone` and `cue attribution complete`.

## Limitations

- One pose per channel. Each slot has a single body angle, which is the element's own pose. The
  overlap on slot 1 depends on the riser's position at 90 degrees. Other angles, other spacings
  and a moving tank are not measured.
- One camera: the gallery's `game` view at 640x480, dpr 1. It is not the in-match camera, its zoom
  or a phone's resolution. Pixel counts scale with the frame.
- One rasteriser: SwiftShader, with antialiasing on as the gallery builds it. No host-GPU
  cross-check, since the frame match needs the CLI's rasteriser.
- Classic owner palette and the gallery's default player styles. The palette changes colour, not
  geometry, so it should not move a footprint, but this was not measured.
- The players' hulls are drawn in the gallery's per-slot player styles. The riser is a darker cast
  of each hull colour, so its contrast against the marker is for the frames to show, not the
  counts.
