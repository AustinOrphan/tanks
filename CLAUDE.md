# Tanks!

A browser arena shooter: a deterministic 2D simulation core with a Three.js render layer
projected from it. Spec and plan live in `docs/superpowers/`.

## Commands

```
npm test     # tsc --noEmit && vitest run
npm run build # tsc --noEmit && vite build
npm run dev   # vite
npm run gallery -- --elements mine,tank,shell --view low   # look at any element
```

`npm run gallery` renders game elements as stills, animations or labelled sweep grids,
through the REAL render modules against a REAL world. Views are directions and each
element declares its own span, so any view frames any scene. `--sweep A,B --values
"1|2; 3|4"` patches constants in `src/` between passes and restores them in a `finally`;
it refuses to start if the target file is already dirty. `--scene game --slowmo 0.05
--burst 150` records a slow-motion timeline of REAL gameplay, one frame per rAF — the way
to catch a sub-second moment (a shell leaving the muzzle) that a still would miss. See
`tools/gallery/`.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and a bundle-portability
assertion on Node 20.19.0 — the declared floor — and 22. `engines.node` is
`^20.19.0 || ^22.13.0 || >=24.0.0`, which is the intersection of what the tree
actually demands: a plain `>=20.19.0` would be wrong too, since it admits 22.0–22.12
and eight packages reject those.

## Architecture invariants

**`src/sim/` is a pure, deterministic core.** It must import nothing from `three`,
`howler`, or the DOM. That purity is what makes it headlessly testable and makes replays
exact functions of their inputs. `src/sim/purity.test.ts` enforces it by scanning every
file under `src/sim/`; it is the only file there that mentions those packages.

**Fixed timestep.** `TICK_HZ = 60`, `DT = 1/60`. The sim never sees wall-clock time.

**Render and audio are one-way projections.** The sim emits a `SimEvent[]` stream
(`src/sim/events.ts`) and never reaches back. Consumers today: `render/renderer.ts`,
`render/particles.ts`, `audio/director.ts`, `game/state.ts` (win/lose drives the game-over
screen) and `game/loop.ts`. If you change an event's shape, check all five.

`step(world, input)` clones its input and returns `{ world, events }` — it never mutates
what it is given.

**Entity configs are data, resolved through `src/sim/config/`.** A tank is
`TankDefinition` (`data/tank-defs.json`) + `BalanceConstants` (balance.ts, whose
AI profiles come from `data/ai-profiles.json`) → `resolveTankConfig` →
`ResolvedTankConfig`, read via `configFor(kind)`; gameplay code never branches
on a kind literal **to pick stats or behaviour** (identity checks like
`kind === 'player'` and the render's per-kind texture choice remain). The JSON
is validated at module load by `validate.ts` — a bad edit is a boot failure
naming the exact path, and the validator's own tests carry negative controls.
Adding a `TankKind` member is a compile error until `TANK_KINDS` (validate.ts)
lists it, which is what forces the JSON entry. Walls are the second family on
the same catalog machinery (`walls.ts`, `wallConfigFor`); new families
(power-ups, turrets, bosses) should ride `createCatalog` rather than invent
parallel plumbing. The **authoritative balance scalars live in
`config/data/balance.json`**; `constants.ts` derives from it and stays the
sim's one import site, so retuning is a two-file edit — the JSON entry and its
literal pin in `constants.test.ts` (every balance.json value is pinned;
`SHELL_SPAWN_FORWARD` stays a TS literal, render-coupled).
`decideAi` routes by the resolved profile's `behavior`; grey's dodge patience is
`(1 − aggression) · TICK_HZ`, rounded, pinned equal to `DODGE_PATIENCE_TICKS` in
`config/roster.test.ts`. Profile fields consumed today: `behavior`, `aggression`,
the signs of `directShotWeight`/`bankShotWeight`/`minePlacementChance`, and the
movement band — `preferredDistance`/`minimumDistance`/`retreatChance` (magnitude
included) drive `seekMove`, the mobile decisions' baseline move (approach beyond
preferred, seeded retreat draw inside minimum, wander in the band; tuned by
sweep, see `SEEK_APPROACH_BIAS`) — and `aimAccuracy`: per-profile jitter is
`AI_AIM_SPREAD / aimAccuracy` (`profileAimSpread`), the anchor being a
perfect-accuracy profile's spread; curve chosen by sweep, see the anchor's
comment in constants.ts — and `minePlacementChance` in full: its magnitude is
the per-bucket mine-proposal probability (`mineInclination`) — and
`reactionTime`: the dispatcher holds every AI shot until the solution has been
HELD (`Tank.aimTicks`, `AiDecision.hasSolution`) for the profile's reaction
span; cover resets the clock. **Every profile field is now consumed.** And the
STATIONARY behaviour implementation reads neither shot weight, so a profile
like RICOCHET_SNIPER's bank preference is authored intent awaiting an
implementation. The 9-type Wii taxonomy in `config/reference/` is reference
data only — nothing in the game reads it.

**Arenas are data too.** Grids, design rationale (`notes`) and machine-checkable
design `claims` live in `config/data/arenas.json`, validated at load by
`validateArenas` — a bad edit is a boot failure naming the exact path (e.g.
`arenas[2].grid[4]`). `arena.ts` keeps every export it always had; `SPAWN_LETTERS`
(`config/arena-types.ts`) is the single source of the spawn-letter map. Three
claim types — `sightlineAfterBreach`, `lane`, `spawnBlockRobust` — are verified
by `src/sim/arena-claims.ts` from the test layer (it imports the AI's
`lineOfSight`, so it must never be imported by `config/`). `spawnBlockRobust`
checks more than its name suggests: every enemy spawn against 4 cardinal nudges
of the player, in BOTH wall phases (intact and breached) — measured across the
5 scenarios that claim it (arena-01, arena-02, arena-03, and the two fixtures
built in `arena-claims.test.ts` to discriminate the phases), 0 failures were
intact-only, so the intact phase's value is labelling which wall state a
failure lives in, not added detection power on its own; the breached phase is
what actually catches a corner tangency. Adding a level is editing JSON: the
generic runner in `arena-validation.test.ts` picks up its claims automatically,
and `npx vitest watch src/sim/arena-validation.test.ts` is the authoring loop —
though the claim MIX itself is pinned separately by that file's
`EXPECTED_CLAIMS` table, so changing an arena's claims is a deliberate two-file
edit. `spawnBlockRobust` exists because ARENA_03 once shipped a corner tangency
a 0.1-unit nudge opened.

## Testing conventions, learned the hard way

These are not style preferences. Each one exists because a real defect shipped green.

**Unit files call sim stages directly, so they cannot see composition.** `movement.test.ts`
and friends call `stepMovement` themselves, which means deleting the call from `step()`
leaves them passing. Composition is pinned separately, through `step()` alone, in
`src/sim/step-pipeline.test.ts`. Anything asserting *that a stage runs* or *in what order*
belongs there and must not call the stage directly.

**Presence-only assertions on the event stream are close to worthless.** The stream is
shared: `some(e => e.type === 'fire')` passes on an AI tank's shell even when the player's
event is dropped entirely. Discriminate by `ownerId`, and assert payloads (`pos`, `angle`)
— `particles.ts` draws bursts at exactly `ev.pos`, so a wrong position is a visible defect
that no presence check catches.

**Prove the gap before writing the test.** Apply the mutation, watch the suite pass, then
write the test, then watch the mutation die. A test that never failed proves nothing.

**Sweep classes, state denominators.** Write "32 of 36 (population: all 36 distinct
single-element moves)", never "32 of 36". A count without its population reads as an
exhaustive sweep. Name any class you did *not* sweep. This repo has twice shipped a
survivor hiding in an unstated remainder.

**Every assertion must be able to fail.** Before adding one, name the production change
that would break it. Watch for tautologies against the fixture: asserting `angle: 0` in a
fixture whose angle is 0 passes even when the field is hardcoded. Decorative assertions are
worse than none — they advertise coverage that does not exist.

**Files no test reads are where defects live forever.** `hud.css` lost a closing brace in
a merge and silently swallowed every rule after it -- the entire losing-a-life vignette was
dead on `main` for as long as the feature existed, and a second merge did the identical
thing to the round banner. Neither `tsc` nor any test could see it, because CSS is not
typechecked and nothing read it. `hud.css.test.ts` now checks brace balance, checks no
block opens inside a plain rule (at-rule aware), and checks the selectors features depend
on are still present. It needs `test.css: true` in `vite.config.ts`: vitest stubs CSS
imports, so `?raw` returns an **empty string** and every assertion passes vacuously --
which is why that guard asserts it loaded something first. Any new stylesheet wants the
same treatment.

**A guard is worth what its own tests prove.** The purity guard reported green for four of
five known-bad imports until it was given a meta-test. Guards need negative controls.

## Merge bar

Nothing reaches `main` without comprehensive adversarial review: reviewers fan out per
subsystem and must prove each finding with a command and its real output, then an
independent pass adjudicates every claim. Re-measure headline numbers yourself rather than
relaying an agent's self-report.

Review agents that *mutate* files each need their own worktree, or they overwrite each
other's experiments and every result becomes noise.

## Dev flags

Unshipped work lives behind a flag in `src/game/devflags.ts`, on `main` — **not on a
long-lived experimental branch**. Both approaches were measured before choosing:

- Flags cost **4.15 kB raw / 1.45 kB gzipped**, 0.8% of the bundle.
- An unmerged branch (`round-ux`) had NOT rotted after 11 commits — it merged clean and
  passed. Branch rot is not the argument.
- What the split *did* cost was real: `devflags.ts` ended up on two branches at 40 and 53
  lines and had **already diverged**, in the one file whose job is to be the single place
  flags are defined.

The deciding reason is CI. Code on `main` is exercised on every run; a branch is exercised
only when someone updates it. `round-ux` passes today, and nobody would learn the day it
stopped.

The flags today: `aimRay`, `shellCount`, `seed`, `mineTrigger`, `mineReach`, `mineTimer`,
`roundPhaseHud`, `invincible`, `level` (a 1-based jump, or `level=sandbox`), and the
sandbox knobs `tanks`, `disarmed`, `walls`. `playtest=1` is a parse-time BUNDLE, not a
field: it expands to invincible + roundPhaseHud + shellCount + mineReach + mineTimer. `parseDevFlags` derives the boolean list from
`DEV_FLAGS_OFF` in its tests, so adding one cannot quietly shrink what they cover.

Two rules follow:

**Nothing is on unless `dev` is present.** `?aimRay=1` alone does nothing; it needs
`?dev=1&aimRay=1`, so a shared link cannot enable anything by accident.

**A flag is temporary.** It exists so work can land tested and unshipped, not so `main` can
accumulate features nobody decided on. Each one should end up either shipped — flag deleted,
behaviour on — or deleted outright. A flag with no owner and no decision is the thing this
arrangement is meant to avoid, and it is worse than the branch would have been.

Flags are **build-time-free but not free**: they are parsed at runtime, so they must never
reach `src/sim/`. That core is pure and deterministic, and a replay has to stay an exact
function of its inputs — a runtime-varying flag there would break it. `MINE_BLAST_THROUGH_DESTRUCTIBLE`
is a *constant* for exactly this reason.

## Numbers that are feel, not measurement

Some constants were chosen by eye and are cheap to change; the tests are written against
the constant rather than a hardcoded result, so retuning does not mean rewriting tests.

- `TANK_TURN_RATE` (5.0 rad/s) -- how fast the hull swings. Modelled on Wii Play: Tanks!
  from recollection, **not measured against it**. Must stay below
  `PLAYER_TURRET_TURN_RATE` (8.0): a hull that outturns its own gun makes aiming while
  moving feel like fighting the tank.
- `MINE_BLAST_EXPAND_TICKS` / `MINE_BLAST_HOLD_TICKS` (5/5) -- the blast ramp. **Measured**
  to be a feel change, not a balance one: at `TANK_SPEED` 3.0 a tank covers 0.25 units
  while the blast expands, 10% of the 2.5 kill reach. 60 seeded games, 25 detonations,
  7 tanks in reach, 0 escapes either with the ramp or with it flattened to instant.
- `BLAST_FLATTEN` (0.7), `BLAST_LINGER_TICKS` (2), `MINE_DOME_H` -- pure look. Compare
  candidates with `npm run gallery --sweep` rather than guessing.

**`GRACE_TICKS` is 0 -- the grace phase is switched off**, but its machinery is intact.
`roundPhase` and `roundPhaseTicksLeft` delegate to pure `phaseAt(elapsed, countdown,
grace)` and `ticksLeftAt(...)`, which are tested at a POSITIVE grace span precisely so
turning the constant back on does not land on untested code.

## Commits

No `Co-Authored-By` or tool-attribution trailers — the history carries none. `gh pr merge
--squash` concatenates branch commit messages into the merge commit, so pass an explicit
`--body` to control what lands.

## Known holes

`src/main.ts` still has no test file and cannot have one: it runs at module scope against
`document.getElementById('app')`, so importing it starts the game. It is now **wiring only** —
everything it used to do (the WebGL error page, the teardown registration) lives in
`src/boot.ts`, which takes its collaborators as arguments and is tested. Keep `main.ts` free
of logic; anything added there is unpinned again, and that is the whole of its remaining risk.

The game loop used to be the worst of these — `while (false && acc >= DT)`, the shipped
game never simulating a tick, passed the full gate. It is now split across `game/frame.ts`
(pure timestep maths), `game/driver.ts` (the frame loop, clock and rAF injected) and
`game/loop.ts` (construction and wiring, dependencies injected as factories), each with a
sibling test file. **Two seams there are load-bearing and easy to lose in a tidy-up:**
`driver.ts` reads `sm.state` twice per frame and the reads must not be hoisted into one
const, because `onEvents` flips the state between them; and `Driver.world`/`prevWorld` must
stay getters, since a plain property snapshots at construction and `tsc` will not warn.
`loop.test.ts`'s last describe block exists because `driver.test.ts` injects fake hooks and
so cannot see whether `loop.ts` wires the real collaborators into them — the composition
blindness above, one layer up. Do not delete it.

Modules with no sibling test file, re-swept at `620eef4`: `main.ts`, `render/aimray.ts`,
`render/renderer.ts`, `render/scene.ts`, `sim/ai/decision.ts`, `sim/ai/index.ts`.

**A missing sibling file is not the same as untested, and for three of those five it is
now actively misleading.** `sim/ai/` is exercised through `sim/step-integration.test.ts`,
with 15 files asserting AI behaviour. `render/scene.ts` and `render/renderer.ts` **are
tested** — in a real browser, by `tools/gl/harness.ts`, because they build a
`WebGLRenderer` that vitest cannot construct. Run them with `npm run test:gl`; CI runs them
in the `visual` job. That covers the ground plane's dimensions, the resize re-fit,
`dispose`, and `screenToGround`'s canvas-rect handling — none of which `npm test` can see,
so **a green `npm test` is not the whole gate for `src/render/`**.

The one module genuinely without coverage is `main.ts`: it runs at module scope against
`document.getElementById('app')`, so importing it starts the game and no test can reach it.
Its logic lives in `src/boot.ts`, which is tested; keep `main.ts` free of anything else.

Merged PR descriptions carry the detailed residual backlog.

**Retroreflecting wall seams: real, measure-zero, and do NOT apply the obvious fix.** Walls
are one AABB per grid cell, so a flat multi-cell run shares internal faces. A ray arriving
at *exactly* a cell-boundary coordinate can enter through one of those buried faces; its
normal then points along the run and the shell reflects back the way it came instead of
mirroring off the visible face. Measured: **1 of 121 sampled crossings** (45°, offsets
−0.60..+0.60 in 0.01 steps against cellSize 2) — the one at exactly 0.00 — and **0 of 155
ricochets** in 15 seeded games × 4000 ticks landed on an exact cell corner. So it is not the
hazard on every flat face the PR #1 backlog describes.

The obvious fix — reject a hit whose face is buried, by stepping a hair out along the normal
and testing containment in another wall — **was tried and reverted**: it fails 4 tests in
`collision.test.ts` and `escape.test.ts`. At the arena's concave inside corners the outward
step from a *legitimate* face lands inside the abutting perpendicular wall, so real surfaces
are misclassified as buried and shells pass straight through — reopening the escape bug that
holds a `SHELL_CAP` slot for the rest of a life. Any real fix must distinguish a coplanar
neighbour that continues the surface from a perpendicular one that merely touches it.
