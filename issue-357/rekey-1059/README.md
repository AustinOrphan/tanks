# Issue #357 / #1059: the re-keyed enemy role cue under its own muzzle effects

Everything here comes from commit `456038247a660278637fe0856b6d7ab9d7bb96a6` on
`fix/role-cue-mine-block-keyed-on-ability`, whose merge base with `main` is `main`'s tip at
capture time, `c200cf621d8bbd40add83acb570c17e40faa2c08`. The cue is `enemyRole=both`: the muzzle
flare for weapon class, and the raised deck block (the riser) for mine load. At this commit the
riser is drawn only on a kind that holds `MINE_LAYER` (`makeTank` in `src/render/entities.ts`):
grey, teal and yellow among the enemies, and not brown, olive or green.

This folder supersedes the parent folder's frames and table, which photograph the cue before the
re-key (#1018, PR #1041). Those files are left in place because PR #1041 and a comment on #1019
link to them.

**These are still frames and a pixel measurement. They are not a playtest or normal-speed play,
and no physical device was used.** #1019 waits for a person to view them; #357 owns the ruling.

## What changed from #1018's evidence, measured

- **Frames.** In each of the four `ordnance-fire` ticks, the left (shipped) column is
  pixel-identical to the published frame. The middle and right columns each differ from the
  published frame in 285 pixels, all inside one 26x11 box at brown's deck (x 85-110, y 58-68 in
  column coordinates): brown's riser is gone. Nothing else in the frames moved.
- **Table.** Olive's flare, teal's flare, teal's riser and brown's flare give the same footprint,
  retained count and dim ratio as the published table in all 160 cells of each pair, in both
  tables. Grey's riser, which replaces brown's as the standard-shell riser carrier, gives the same
  footprint and retained count as the published brown riser in all 160 cells. 10 of the 160 differ
  in dim ratio, by at most 0.0002. That holds for both tables.

`scripts/compare-runs.mjs` and `scripts/pixdiff.py` produced these counts (see Reproduce).

## Frames: the `ordnance-fire` moment

The moment is #1018's, unchanged. A brown tank (standard shell), an olive (rocket) and a teal
(ricochet rocket) stand in a column, firing east through their own AI. The fire ticks are
emergent, measured with `simulateMoment`, and pinned in `moments.test.ts`. That file's 5
`ordnance-fire` cases pass at this commit:

- teal at 36, olive at 39, brown and teal at 50;
- teal at 64 and 78, brown at 90, teal at 92;
- olive's second attempt, at 77, is refused (`fire-blocked`).

**Brown is now the no-cue control in these frames.** It holds no `MINE_LAYER`, so it draws no
riser, and a standard shell draws the shipped flare. In each of the four ticks the top 119 rows
of the middle column (brown, its smoke and its sparks) differ from the same rows of the left column
in 0 pixels. The first row that differs is 119 at ticks 40 and 92, 133 at tick 52 and 135 at
tick 79. Teal still carries both levers and olive the small flare, as before the re-key.

Each file is one tick, cropped to the three tanks, with three columns:

| Column | Asked for |
| --- | --- |
| left | nothing: the shipped board |
| middle | `--enemyRole both`, full motion |
| right | `--enemyRole both --motion reduced` |

| File | What the tick holds |
| --- | --- |
| `ordnance-fire-t40.png` | teal's smoke 4 ticks old, olive's 1 tick old |
| `ordnance-fire-t52.png` | brown's and teal's shots 2 ticks old, olive's cloud thinning |
| `ordnance-fire-t79.png` | olive's REFUSAL (near-black smoke) 2 ticks old, teal's shot 1 tick old |
| `ordnance-fire-t92.png` | teal firing again, brown's smoke 2 ticks old |

The right column shows the reduced presentation: under reduced motion a cloud is drawn fully grown
and still from its first tick, and the gun holds half its kick instead of springing back and forth.

## Frames: the `roster` subject at `--view game` (new)

The only frame that shows all six enemy kinds at once, and the only one with grey, green and
yellow in it: `ordnance-fire` stages three kinds, and yellow is placed in no shipped arena. Left to
right: brown, grey, teal, olive, green, yellow (`TANK_KINDS` minus the player). Every tank holds the
same pose, a three-quarter facing (`ROSTER_ANGLE`, pi/6). The camera is the gallery's `game` view,
at the default 640x480 canvas.

| File | What it holds |
| --- | --- |
| `roster-game-shipped.png` | the row with no cue, 640x480 as captured |
| `roster-game-both.png` | the row with `--enemyRole both`, 640x480 as captured |
| `roster-game-row-x3.png` | the 400x80+125+200 crop of each, scaled 3x nearest-neighbour (no new pixels), shipped above and `both` below |

In the 640x480 frame, 1154 pixels differ between the two captures, all inside six per-tank boxes
(y 195-279; x 128-194, 195-257, 258-321, 322-383, 384-446 and 447-519). Each box splits into a deck
part and a muzzle part. The split column is chosen per tank, between its deck and its muzzle, where
no pixel differs: grey 231, teal 294, olive 358, green 420, yellow 485.

| Kind | `MINE_LAYER` | Shell | Deck px that differ | Muzzle px that differ | Total |
| --- | --- | --- | ---: | ---: | ---: |
| brown | no | standard | 0 | 0 | 0 |
| grey | yes (capacity 2) | standard | 77 | 0 | 77 |
| teal | yes (capacity 2) | ricochet rocket | 78 | 327 | 405 |
| olive | no (capacity 0) | rocket | 0 | 212 | 212 |
| green | no (capacity 2) | ricochet rocket | 0 | 296 | 296 |
| yellow | yes (capacity 4) | standard | 164 | 0 | 164 |

Population: 1 frame pair, 6 tanks, 1154 differing pixels, all of them counted above. These are
pixel counts at this camera and canvas size. Deck pixels differ on exactly the three enemy kinds
that hold `MINE_LAYER`, and muzzle pixels on exactly the three that do not fire a standard shell.
Brown and green, the two kinds that carry a mine capacity without `MINE_LAYER`, show 0 deck
pixels. The render-level test in `entities.test.ts` makes the group-count claim; this frame
photographs it and does not count groups.

## Reproduce

Each `ordnance-fire` run writes every tick as `frame-NNNN.png` (96 frames). The runner serves on
port 5599, so the runs went one at a time:

```sh
npm run gallery -- --scene ordnance-fire --anim --subdiv 1 --w 960 --h 600 --out gallery-out/rekey1059-shipped
npm run gallery -- --scene ordnance-fire --anim --subdiv 1 --w 960 --h 600 --enemyRole both --out gallery-out/rekey1059-both
npm run gallery -- --scene ordnance-fire --anim --subdiv 1 --w 960 --h 600 --enemyRole both --motion reduced --out gallery-out/rekey1059-both-reduced
npm run gallery -- --elements roster --view game --out gallery-out/rekey1059-roster-shipped
npm run gallery -- --elements roster --view game --enemyRole both --out gallery-out/rekey1059-roster-both
```

Composition uses ffmpeg 9.0.2. Each `ordnance-fire` file is the `320x330+300+130` crop of
`frame-00NN.png` from the three runs, side by side (`scripts/compose-ordnance.sh`):

```sh
sh scripts/compose-ordnance.sh gallery-out/rekey1059-shipped gallery-out/rekey1059-both gallery-out/rekey1059-both-reduced <out>
ffmpeg -i roster-game-shipped.png -i roster-game-both.png -filter_complex \
  "[0:v]crop=400:80:125:200,scale=1200:240:flags=neighbor[a];[1:v]crop=400:80:125:200,scale=1200:240:flags=neighbor[b];[a][b]vstack=inputs=2" \
  roster-game-row-x3.png
```

Pixel counts (Python 3 with Pillow 12.3.0; boxes are half-open `x0,y0,x1,y1`):

```sh
python3 -I scripts/pixdiff.py roster-game-shipped.png roster-game-both.png \
  grey-deck=195,195,231,280 grey-muzzle=231,195,258,280 teal-deck=258,195,294,280 \
  teal-muzzle=294,195,322,280 olive-deck=322,195,358,280 olive-muzzle=358,195,384,280 \
  green-deck=384,195,420,280 green-muzzle=420,195,447,280 yellow-deck=447,195,485,280 \
  yellow-muzzle=485,195,520,280 brown=128,195,195,280
python3 -I scripts/columns.py ordnance-fire-t40.png brown-band=0,0,320,100   # and t52, t79, t92
python3 -I scripts/pixdiff.py ../ordnance-fire-t40.png ordnance-fire-t40.png \
  left=0,0,320,330 middle=320,0,640,330 right=640,0,960,330                  # published vs this folder
node scripts/summarise.mjs role-cue-overlap.json role-cue-overlap-host-gpu.json
node scripts/compare-runs.mjs ../role-cue-overlap.json role-cue-overlap.json brown:grey:riser
```

## The measurement: how much of the cue still differs under each effect

`role-cue-overlap.md` is the table, and `role-cue-overlap.json` holds the same rows. Both come
from the software rasteriser, the one the GL harness and CI use (three 0.186.1, 320x240 frames).
The run took 831.1 s. That is more than the published 709 s because this run builds four kinds,
not three, giving 1120 rows instead of 800:

```sh
ROLE_CUE_VISUAL=software-gl ROLE_CUE_OUT=role-cue-overlap.json ROLE_CUE_MD=role-cue-overlap.md \
  node tools/gl/role-cue-overlap.mjs
```

`role-cue-overlap-host-gpu.{md,json}` is the same table on a host GPU (ANGLE Metal, Apple M1 Max,
33.4 s), the runner's default. It is a cross-check:

```sh
ROLE_CUE_OUT=role-cue-overlap-host-gpu.json ROLE_CUE_MD=role-cue-overlap-host-gpu.md \
  node tools/gl/role-cue-overlap.mjs
```

Over the 640 measured cells, the two rasterisers differ by at most:

- 1.57 points in retained fraction (olive flare, fire, smoke, high, reduced, east, tick 15);
- 0.007 in dim ratio (olive flare, fire, smoke, medium, reduced, toward camera, tick 15);
- 4.7% in footprint size, relative to the smaller of the two footprints (teal flare, fire, smoke,
  high, full, east, tick 15).

These are the published cross-check's figures, because the cells that set them are olive's and
teal's flares, which did not change. Neither table has a completely occluded cell. Both runs
exited 0 with no page error.

All of it goes through `createRenderer`, the production composition. The quality preset and the
motion policy are only real there. The frames above come from the gallery, which builds the
entity views and effect systems directly rather than through `createRenderer`.

### Effects covered, and how each is removed

Derived from renderer.ts's construction, read at this commit. It builds 13 effect and overlay
systems: particles, death pulse, wreck, tread trails, shell trail, aim ray, mine debug, AI
contact, blocked-fire ring, blocked-fire muzzle, muzzle smoke, barrel recoil and blocked-fire
pips. Five of them are built on an ordinary page with no developer flag: particles, death pulse,
tread trails, barrel recoil and muzzle smoke (none on `low`).

| Effect | Covered? | Removed for the no-effect baseline by |
| --- | --- | --- |
| muzzle smoke | yes, on `fire` and on `fire-blocked` | `quality: { ...QUALITY_PRESETS[preset], muzzleSmoke: null }` |
| particle burst on `fire` | yes (a refusal spawns none) | moving the event's `pos` off the board. The burst lands at `pos`; the smoke and the recoil read the owner and the world, never `pos`. A control confirms the smoke is still drawn with `pos` moved. |
| barrel recoil | present in BOTH frames of every comparison | never removed: it moves the gun, so both renders are at the same tick and pose |
| death pulse | no | draws only on a death |
| tread trails | no | draws only behind a moving tank, and these tanks stand still |
| wreck, shell trail, aim ray, mine debug, AI contact, the three refusal cues | no | each exists only behind a developer flag, so none is a shipped effect |

The shell body is drawn by entities.ts, not by an effect system. The synthetic events put no
bullet in the world, so no shell appears in the measured frames.

### Definitions

A lever's **footprint** for a kind is the set of pixels that differ between the armed and the
unarmed renderer at the same tick and pose, with the effect removed. Each cell then reports:

- **Retained**: how many footprint pixels still differ with the effect on.
- **Dim ratio**: the mean absolute channel difference over the footprint with the effect, divided
  by the same quantity without it. Pixel inequality cannot see a cue dimmed under translucent
  smoke; this column can.

### Axes

Unchanged from #1018: kind and lever, event (`fire`, `fire-blocked`), preset (`high`, `medium`),
motion (full, reduced), pose (`east`, `toward-camera`) and ticks 0, 6, 15, 30 and 44 after the
event. The event is fed on tick 0; the smoke lives 45 ticks and the recoil about 10. `pose` was
added after #1018's first run (see that README).

**The pairs moved with the re-key.** The measured pairs are olive flare, teal flare, grey riser
and teal riser. Grey replaces brown as the standard-shell riser carrier. Three pairs are 0 by
construction and recorded as checks, not measurements:

- brown's flare: a standard shell draws the shipped flare;
- brown's riser: brown holds no `MINE_LAYER`;
- grey's flare: a standard shell.

Olive appears in neither list: it has no `MINE_LAYER` and capacity 0.

### Populations, from this run's own rows

Per pair: (fire: 3 effects + refusal: 1 effect) x 5 ticks x 2 presets x 2 motions x 2 poses =
160 cells.

- **Measured**: 4 pairs x 160 = 640 cells, every one with a nonzero footprint, in each table.
- **Zero by construction**: 3 pairs x 160 = 480 cells, every one with a zero footprint, in each
  table.
- **Rows per table**: 1120, matching the header line of each `.md`.

The parent folder's README gives "80 zero-by-construction cells for brown's flare". Its own table
holds 160 brown-flare rows, all zero, out of 800 rows. The 80 matches the count before `pose`
doubled the axes, so that README's figure is stale.

### What the numbers support

Software rasteriser, worst cell per pair, event and effect. Each footprint range is the pair's
range over all its cells.

| Pair | Event | Effect | Footprint px | Worst retained | Worst dim ratio |
| --- | --- | --- | ---: | ---: | ---: |
| olive flare | fire | smoke | 340-491 | 99.4% (347 of 349; high, reduced, east, tick 0) | 0.882 (high, full, toward camera, tick 15) |
| olive flare | fire | burst | 340-491 | 99.5% (439 of 441; high, full, toward camera, tick 0) | 0.992 |
| olive flare | fire | smoke + burst | 340-491 | 99.3% (438 of 441; high, full, toward camera, tick 0) | 0.882 |
| olive flare | refusal | smoke | 340-491 | 99.4% (469 of 472; high, reduced, toward camera, tick 15) | 0.729 (high, reduced, toward camera, tick 0) |
| teal flare | fire | smoke | 562-810 | 98.6% (764 of 775; high, reduced, toward camera, tick 0) | 0.862 |
| teal flare | fire | burst | 562-810 | 98.4% (749 of 761; high, full, toward camera, tick 0) | 0.979 |
| teal flare | fire | smoke + burst | 562-810 | 98.3% (748 of 761; high, full, toward camera, tick 0) | 0.861 |
| teal flare | refusal | smoke | 562-810 | 97.7% (757 of 775; high, reduced, toward camera, tick 0) | 0.846 |
| grey riser | both events | every effect | 107-245 | 100.0% in all 160 cells | 0.9998 at the lowest |
| teal riser | both events | every effect | 107-243 | 100.0% in all 160 cells | 0.9999 at the lowest |

So, at worst, 757 of 775 of teal's flare pixels (97.7%) still differ under a refusal's cloud, the
near-solid one, dimmed to 0.846 of their no-effect difference. The most-dimmed cell is olive's
flare under that same cloud: 444 of 446 pixels still differ, dimmed to 0.729 of their no-effect
difference. Every grey-riser and teal-riser footprint pixel still differs in all 320 riser cells,
dimmed to no less than 0.9998 of the no-effect difference. The block sits on the deck and the
cloud forms ahead of the muzzle.

Across the 640 measured cells, 89 lose at least one footprint pixel under the effect and 141 have
a dim ratio below 1. The host-GPU table's figures are 105 and 141.

**Complete occlusion: none.** No measured cell, that is no cell whose no-effect footprint is
nonzero, reached a retained fraction of 0. The population is 640 in each table, and the lowest
retained fraction is 97.7% on software GL and 97.9% on the host GPU. These are statements about
pixel survival and dimming only, with no perceptual claim. No pass threshold was invented; the
person viewing the frames judges that.

### Controls (all pass, 327 in each table)

- **Determinism**, 192 controls: 4 kinds x (fire: 2 smoke settings x 2 burst settings + refusal:
  2 smoke settings) x 2 presets x 2 motions x 2 poses. Two unarmed renderers under the same effect
  differ in 0 pixels at every sampled tick.
- **Opaque patch**, 64 controls: 4 measured pairs x 2 events x 8 settings. The same frames with an
  opaque patch laid over the footprint read 0 retained in every one. This checks the arithmetic,
  in data space.
- **Smoke ignores `pos`**, 64 controls: 4 kinds x 2 events x 8 settings. The smoke is drawn with
  the event's `pos` moved off the board.
- **Staging guard**, 4 controls: each measured pair's no-effect footprint is nonzero in all 160 of
  its cells.
- **Zero-by-construction checks**, 3 controls: brown's flare, brown's riser and grey's flare each
  have a zero footprint in all 160 of their cells.

`npm run test:gl` runs the determinism control, the patch control, the staging guard and one fixed
cell on every run. It was not run for this folder, and its timing was not re-measured here.

#1018's `cell-teal-flare-*.png` images were not reproduced. They show teal's flare, whose rows are
identical in this run.

## Reduced motion and muted

- **Reduced motion.** `entities.test.ts`, "the role cue under reduced motion (issue #1018)", shows
  that the cue's geometry (hull, turret, barrel with its flare, and mine block) is identical with
  `setReducedMotion(true)` and `(false)` at rest, for grey, olive and teal. Grey replaced brown in
  that rig because brown no longer draws a block. Its 3 cases pass at this commit.
  - A second case shows the reduced recoil holding the gun back by one constant offset for its
    life, without changing the flare's radius or the block's presence on any tick, then returning
    the gun to 0.
  - The right column of each `ordnance-fire` frame shows the reduced presentation.
- **Muted** is closed by construction, not by capture. The cue has no audio input: render may
  import only `render`, `presentation` and `sim` (`MAY_IMPORT.render` in
  `src/dependency-direction.test.ts`). At this commit, a recursive search of non-test files under
  `src/render/` and `src/presentation/` finds 0 imports from `audio`. That is a statement about the
  code, not a capture or a perceptual claim. The human play pass with audio muted and reduced
  motion forced is #931.

## Limitations

- **Software GL.** The published table comes from SwiftShader, and so do all the frames: the
  gallery runner launches headless Chromium with `--use-gl=swiftshader` (Playwright 1.62.0). Only
  the host-GPU table used a GPU. No physical device was used.
- **Not normal speed, and not a playtest.** The `ordnance-fire` frames are single ticks of a
  scripted moment. The roster is a posed still with no motion.
- **Muted is closed by construction**, not by capture (above).
- **One small board for the table.** The measurement draws one tank on a 4x3 board at 320x240, so
  the tank is larger on screen than at the arena camera. What it measures is footprints and the
  share of them an effect covers, not on-screen size at play distance.
- **The roster frame is small.** At `--view game` and 640x480 each tank spans about 60 pixels. The
  x3 file enlarges the same pixels and adds no detail.
- **Crop edge.** The `ordnance-fire` crop is #1018's. At ticks 79 and 92, teal's muzzle reaches the
  crop's right edge, so part of its flare and smoke may fall outside the file.
- **Two poses, and the second was added after #1018's first run.**
- **No shell is drawn** in the measured frames (above).
- **Identity overlap** (the cue against the `shape` identity marker) is #1040, not this folder.
