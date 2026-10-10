# Issue #357 / #1018: the enemy role cue under its own muzzle effects

> **Before the re-key (issue #1059).** These files photograph and measure the cue as it was before
> #1059 gated the mine block on `MINE_LAYER`. Here brown still draws a riser, because it carries
> a capacity without the ability. The evidence for #1019's go is in
> [`rekey-1059/`](rekey-1059/README.md), produced on the re-keyed cue. These files stay because
> PR #1041 and a comment on #1019 link to them.
>
> Correction (2026-10-10): the population line below said 80 zero-by-construction cells for
> brown's flare. The published table has 160 such rows of its 800: the pose axis doubled them,
> and the line kept the earlier figure.

Everything here comes from commit `b613327fadae2aca917248110184fc6869d4d300` on
`test/role-cue-effect-overlap`, branched from `main` at `34b43f4a`. The cue is `enemyRole=both`:
the muzzle flare for weapon class and the raised deck block (the riser) for mine load.

**These are still frames and a pixel measurement. They are not a playtest or normal-speed play,
and no physical device was used.** #1019 waits for a person to view them; #357 owns the ruling.

## Frames: the `ordnance-fire` moment

The moment is new in #1018. A brown tank (standard shell), an olive (rocket) and a teal
(ricochet rocket) stand in a column, firing east through their own AI. The fire ticks are emergent,
measured with `simulateMoment`, and pinned in `moments.test.ts`:

- teal at 36, olive at 39, brown and teal at 50;
- teal at 64 and 78, brown at 90, teal at 92;
- olive's second attempt, at 77, is refused (`fire-blocked`).

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

The right column shows the reduced presentation rather than describing it: under reduced motion
a cloud is drawn fully grown and still from its first tick, and the gun holds half its kick
instead of springing back and forth. Before #1018 the moment scene never passed its motion
policy to the recoil or the smoke, so a reduced frame would have drawn full motion.

Reproduce (each run writes every tick as `frame-NNNN.png`; the crop is `320x330+300+130`):

```sh
npm run gallery -- --scene ordnance-fire --anim --subdiv 1 --w 960 --h 600 --out gallery-out/a
npm run gallery -- --scene ordnance-fire --anim --subdiv 1 --w 960 --h 600 --enemyRole both --out gallery-out/b
npm run gallery -- --scene ordnance-fire --anim --subdiv 1 --w 960 --h 600 --enemyRole both --motion reduced --out gallery-out/c
```

## The measurement: how much of the cue still differs under each effect

`role-cue-overlap.md` is the table, and `role-cue-overlap.json` the same rows. Both come from
the software rasteriser, the one the GL harness and CI use. The run took 709 s:

```sh
ROLE_CUE_VISUAL=software-gl node tools/gl/role-cue-overlap.mjs
```

`role-cue-overlap-host-gpu.{md,json}` is the same table on a host GPU (ANGLE Metal, 35 s), the
runner's default. It is a cross-check. Over the 640 measured cells, the two rasterisers differ by
at most 1.57 points in retained fraction, 0.007 in dim ratio and 4.7% in footprint size. Neither
table has a completely occluded cell.

All of it goes through `createRenderer`, the production composition. The quality preset and the
motion policy are only real there.

### Effects covered, and how each is removed

Derived from renderer.ts's construction, which builds 13 effect and overlay systems. Five are
built on an ordinary page with no developer flag: particles, death pulse, tread trails, barrel
recoil and muzzle smoke (none on `low`).

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
  by the same without it. Pixel inequality cannot see a cue dimmed under translucent smoke, and
  this column can.

### Axes

Fixed before the first run: kind and lever, event (`fire`, `fire-blocked`), preset (`high`,
`medium`), motion (full, reduced) and ticks 0, 6, 15, 30 and 44 after the event. The event is fed
on tick 0; the smoke lives 45 ticks and the recoil about 10.

The pairs are olive flare, teal flare, brown riser and teal riser. Brown's flare is recorded as 0
by construction, as a check: a standard shell draws the shipped flare. Olive has no riser.

**Pose was added after the first run.** That run measured `east` alone, with the gun side-on to
the camera, where the cloud drifts beside the flare. `toward-camera` aims hull and gun down the
screen, which puts the cloud between the camera and the muzzle.

Population: 4 pairs x (fire: 3 effects + refusal: 1 effect) x 5 ticks x 2 presets x 2 motions x
2 poses = 640 measured cells, plus 160 zero-by-construction cells for brown's flare in each table.

### What the numbers support

Software rasteriser, worst cell per pair and effect (`retained` of the footprint, and the dim
ratio):

| Pair | Event | Effect | Footprint px | Worst retained | Worst dim ratio |
| --- | --- | --- | ---: | ---: | ---: |
| olive flare | fire | smoke | 340-491 | 99.4% | 0.882 |
| olive flare | fire | burst | 340-491 | 99.5% | 0.992 |
| olive flare | fire | smoke + burst | 340-491 | 99.3% | 0.882 |
| olive flare | refusal | smoke | 340-491 | 99.4% | 0.729 (high, reduced, toward camera, tick 0) |
| teal flare | fire | smoke | 562-810 | 98.6% | 0.862 |
| teal flare | fire | burst | 562-810 | 98.4% | 0.979 |
| teal flare | fire | smoke + burst | 562-810 | 98.3% | 0.861 |
| teal flare | refusal | smoke | 562-810 | 97.7% (high, reduced, toward camera, tick 0) | 0.846 |
| brown riser, teal riser | both events | every effect | 107-245 | 100.0% | 1.000 |

So, at worst, 97.7% of teal's flare pixels still differ under a refusal's cloud (the
near-solid one), and the least-dimmed is olive's flare under that same cloud, at 0.729 of its
no-effect difference. The riser is never touched: the block sits on the deck and the cloud forms
ahead of the muzzle.

**Complete occlusion: none.** No sampled cell with a nonzero footprint reached a retained fraction
of 0 (population 640 in each table). This states pixel survival and dimming only. It does not say
the cue is readable or legible. No pass threshold was invented; the person viewing the frames
judges that.

### Controls (all pass, 261 in each table)

- **Determinism.** Two unarmed renderers under the same effect differ in 0 pixels at every sampled
  tick, per preset, motion, pose, kind and event.
  - This failed by 51-79 pixels on every burst cell until the particle system was handed a seeded
    random source: `createParticleSystem` captures `Math.random` when it is built, so seeding
    `Math.random` afterwards reached nothing.
- **Opaque patch.** The same frames with an opaque patch laid over the footprint read 0 retained.
  This checks the arithmetic, in data space.
- **Smoke ignores `pos`.** The smoke is drawn with the event's `pos` moved off the board.
- **Staging guard.** Every pair's no-effect footprint is nonzero in every cell, and brown's flare
  is 0 in every cell.

`npm run test:gl` runs the determinism control, the patch control, the staging guard and one fixed
cell (teal flare, smoke plus burst, `high`, full motion, `east`, tick 6) on every run, at
240x180. It adds one check, measured at 18.8 s of the 122.0 s spent inside check bodies on this
machine (96 checks). That makes it the dearest single check in the suite; it was 21.7 s before
the gap between sequences was shortened from 60 to 48 ticks.

`cell-teal-flare-east-t6.png` and `cell-teal-flare-toward-camera-t6.png` are that cell's four
frames in each pose. Top row: unarmed and armed, no effect. Bottom row: unarmed and armed, smoke
plus burst. Each frame is 320x240 from the table page, at `high`, full motion.

## Reduced motion and muted

- **Reduced motion.** `entities.test.ts` shows that the cue's geometry (hull, turret, barrel with
  its flare, and mine block) is identical with `setReducedMotion(true)` and `(false)` at rest, for
  brown, olive and teal. The mutation that makes the flare or the block depend on the preference
  fails it.
  - A second case shows the reduced recoil holding the gun back by one constant offset for its
    life, without changing the flare's radius or the block's presence on any tick, and returning
    the gun to 0.
  - The right column of each `ordnance-fire` frame shows the reduced presentation.
- **Muted** is closed by construction, not by capture. The cue has no audio input: render may
  import only `render`, `presentation` and `sim` (`MAY_IMPORT.render` in
  `src/dependency-direction.test.ts`), and `grep "from '../audio" src/render/*.ts` matches 0
  non-test lines at this commit. That is a statement about the code, not a capture or a
  perceptual claim. The human play pass with audio muted and reduced motion forced is #931.

## Limitations

- **Software GL** for the published table; the host-GPU table and the frames come from headless
  Chromium. No physical device was used.
- **Not normal speed and not a playtest.** The frames are single ticks of a scripted moment.
- **Muted is closed by construction**, not by capture (above).
- **One small board.** The measurement draws one tank on a 4x3 board at 320x240, so the tank is
  larger on screen than at the arena camera. Footprints and the share of them an effect covers
  are what it measures, not on-screen size at play distance.
- **Two poses, and the second was added after the first run** (above).
- **No shell is drawn** in the measured frames (above).
- **Identity overlap was cut** from #1018 and filed as #1040. #1018 named it the first thing to
  cut if the PR grew past one reviewable change. It measures the cue against the `shape`
  identity marker, per slot.
