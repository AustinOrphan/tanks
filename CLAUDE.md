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
span; cover resets the clock. **Every profile field is now consumed**, including
both shot weights in BOTH mobile and stationary implementations — `brown.ts`
gained bank shots gated on `bankShotWeight > 0`, which is what makes
RICOCHET_SNIPER (the **green** tank, level 4) a real enemy rather than authored
intent. It prefers the DIRECT shot and falls back to the bank, where `teal.ts`
alternates: a turret that can already see you has no reason to take the longer
path. Brown is unaffected because STATIC_BASIC carries `bankShotWeight` 0 — proven
by an identical trace hash over 4 arenas × 6 seeds × 2500 ticks, with a control
showing the probe moves when banking is switched on.

**A green tank changed what `structuralFailures` has to check.** "No enemy sees
the player spawn" tested `lineOfSight` only, which was the same as "no enemy can
SHOOT the player spawn" for exactly as long as no stationary enemy could bank.
There is now a second rule: no STATIONARY banking enemy may hold a ricochet path
onto the spawn. Restricted to stationary bankers on evidence, not taste — applied
to every banking profile it rejects shipped arena-01 (grey banks onto the spawn
off 1 wall, teal off 2) and arena-04's teals. Mobile tanks leave that geometry
within a second; a turret never does. `BANK_SIGHTLINE_ARENA` is the negative
control, and swapping its one spawn letter for `T` and `B` controls the
behaviour gate and the weight gate separately.

**`determinism.test.ts` does not catch AI behaviour changes**, which is easy to
assume it does. It asserts self-consistency — same seed, same result — and that
is invariant under behaviour changes: giving brown a 0.5 `bankShotWeight` leaves
all 7 of its tests passing while a trace probe moves. When that mutation was first
run it passed the WHOLE suite (1155 tests); it now fails 5 tests in 2 files,
because green's arrival added tests that watch the bank path — so the hole is
narrower than it was, and the general point stands. Any claim that an AI edit is
behaviour-preserving needs a golden trace comparison, not a green suite.

STATIONARY still ignores `preferredDistance`/`minimumDistance`/`retreatChance`,
and always will: they are a distance band for a tank that moves. "Every profile
field is consumed" means consumed by the implementations it applies to. The 9-type Wii taxonomy in `config/reference/` is reference
data only — nothing in the game reads it.

**Arenas are data too.** Grids, design rationale (`notes`) and machine-checkable
design `claims` live in `config/data/arenas.json`, validated at load by
`validateArenas` — a bad edit is a boot failure naming the exact path (e.g.
`arenas[2].grid[4]`). `arena.ts` keeps every export it always had; `SPAWN_LETTERS`
(`config/arena-types.ts`) is the single source of the spawn-letter map for the
validator and `loadArena` — green is `N`, because grey already holds `G` and
re-lettering grey would rewrite every shipped grid — `src/sim/sandbox.ts` keeps its own `KIND_LETTER`
table (plus a hardcoded `'P'`) for grid GENERATION, so re-lettering a kind in
`SPAWN_LETTERS` without also updating `sandbox.ts` would leave the dev sandbox
emitting a character `loadArena` rejects. Three claim types —
`sightlineAfterBreach`, `lane`, `spawnBlockRobust` — are verified by
`src/sim/arena-claims.ts` from the test layer (it imports the AI's
`lineOfSight`, so it must never be imported by `config/`). `sightlineAfterBreach`
is all-or-nothing per arena: declaring one commits the arena to declaring one
for EVERY enemy spawn, checked by set equality (both directions) in
`arena-validation.test.ts` — an arena's claims of this type are a COMPLETE
statement of its post-breach spawn lines, never a sample (an arena may still
declare zero, as arena-01 does). `spawnBlockRobust` checks more than its name
suggests: every enemy spawn against 4 cardinal nudges of the player, in BOTH
wall phases (intact and breached) — measured across all 6 scenarios that can
run it (arena-01, arena-02, arena-03, arena-04, and the two fixtures built in
`arena-claims.test.ts` to discriminate the phases), 0 failures were
intact-only, so the intact phase's value is labelling which wall state a
failure lives in, not added detection power on its own; the breached phase is
what actually catches a corner tangency. arena-04 contributes 0 failures in
either phase (0 of 24 probes each: 6 enemies × 4 cardinal nudges). Only 5 of
those 6 DECLARE the claim —
arena-02 does not, because checked the same way it fails 12 of its 16
breached-phase checks (0 of 16 intact): the level's design is to open
sightlines when its centre barrier breaches, not survive it. The switch case in
`arena-claims.ts` only runs a claim type an arena actually DECLARES, so nothing
about arena-02's number falls out of the claim runner — it is recomputed
instead by its own test in `arena-validation.test.ts` (denominator pinned at 4
enemies × 4 cardinal nudges), which fails if that grid changes. Deliberately
not a claim: making it one would assert a property arena-02 does not have. Adding a level is editing JSON: the generic runner in
`arena-validation.test.ts` picks up its claims automatically, and `npx vitest
watch src/sim/arena-validation.test.ts` is the authoring loop — though the
claim MIX itself is pinned separately by that file's `EXPECTED_CLAIMS` table,
so changing an arena's claims is a deliberate two-file edit. `spawnBlockRobust`
exists because arena-03 once shipped a corner tangency a 0.1-unit nudge opened.
A `lane` claim's `from`/`to` are LITERAL grid cells, not tied to a spawn by the
validator (`cell()`, not `enemySpawnCell()`) — moving the spawn a lane's `why`
refers to does not invalidate the claim, which keeps measuring the same two
cells and keeps passing; arena-03's two lanes and arena-04's seven survive this
only because every one of them has an enemy spawn at its `from` end carrying a
`sightlineAfterBreach` claim at that same cell, which DOES require a live spawn
there and so catches the move at load time instead. Their `to` ends are plain
floor cells and are pinned by nothing — moving a wall so a lane's target cell
stops meaning what its `why` says is a change no test can see. See the `lane`
variant's doc comment in `config/arena-types.ts`.

**arena-04 is the first shipped board that is not 33x27** (45x33; world dimensions are
unchanged by the 3x cell-size rescale — only the cell counts moved), so PR #53's
per-level render refit is now exercised by a level players actually reach rather
than only by a fixture. `WIDE_ARENA` moved 15x11 -> 17x13 when it landed, because
`arena-validation.test.ts` asserts the fixture differs from every shipped arena
and a fixture whose whole job is to be an unshipped size gives way to production
data. Three distinct board sizes are now covered.

**Adding a level moves more pins than the level file.** Five places moved when
arena-04 landed, and the list is the checklist for the next one:
`cell-mapping.test.ts`'s cell and spawn totals (4379 / 25); `EXPECTED_CLAIMS` in
`arena-validation.test.ts` (the claim mix, not a count); that file's `variable
arena dimensions` block (fixture dimensions and bounds); its cover-ratio
`EXPECTED` table; and three size labels in `tools/gl/harness.ts`. The harness
labels are prose, so nothing failed when one of them was missed — review caught
it. Any number a `notes` string quotes is likewise unpinned by construction:
`notes` are validated as strings only. Three blocks in `arena-validation.test.ts`
exist purely to recompute quoted prose — arena-02's `12 of 16`, arena-04's cover
ratios, and arena-04's bank-reach count (275 cells reached by ricochet, covering
171 of the 284 nothing else sees) — because all three were measured once by hand
and nothing checked them again. Quote a measurement in `notes` and you owe it a
recomputing test.

**Walls load as geometry, not as cells.** `loadArena` merges SOLID cells into maximal
rectangles (`mergeSolidRuns`) and numbers tanks from a counter of their own. Both exist
because four parts of the sim read the wall ARRAY rather than the arena's shape, and
the 3x resolution upscale exposed all four: tank ids shared a counter with walls, so
wall count reseeded every per-tank RNG stream in `ai/targeting.ts`; `resolveWalls`
applied one push per overlapping wall, so a sliced wall pushed several times and its
interior seams offered phantom corners; `bankShot` chose the first reflector in
wall-array order; and `circleVsAABB`'s `inside` branch resolved a hull escape
differently depending on which sub-cell box it was handed.

**The bank-shot dependence turned out to live one function deeper**, which is worth
knowing before anyone "simplifies" it. `bankShot` now picks the SHORTEST muzzle ->
bounce -> target path, ties broken on the angle, so its answer is a property of the
arena rather than of the array. But the defect a subdivided wall actually triggered was
in `losIgnoring`: a bounce landing exactly on a seam put the segment's own ENDPOINT on
the neighbouring box's corner, and `raySegmentVsAABB` counts a boundary touch as a hit,
so a legitimate shot was reported blocked. `losIgnoring` now disambiguates with
`headingIntoBox` — the same direction-probe form `reflectSweep` already ships, NOT the
step-out-along-the-normal form this file records as tried and reverted. It is safe here
for a structural reason: `losIgnoring` has exactly two callers, both inside `bankShot`,
so it cannot reach `reflectSweep` and cannot reopen the escape bug.

An explicit `faceIsBuried` guard was written first and then DELETED, on evidence with a
stated DOMAIN — the unqualified version of this paragraph was falsified in review. With
both endpoints strictly outside every wall, which is the only state the sim produces
(`resolveWalls` keeps every hull centre out of the mass), removing the guard changed
0 of **4,195,692** (muzzle, target) probes across 12 synthetic shapes and all 4 shipped
arenas' real merged geometry. With an endpoint exactly ON a wall surface it is not a
no-op: **81 of 1,966,116** probes differ, all on arena-03. So the guard is unnecessary
because of REACHABILITY. The structural argument this file used to give — "if a face is
buried the neighbour occupies the space outside it, so any ray reaching it is already a
real penetration" — is FALSE, and there is a witness: an approach arriving exactly at the
seam CORNER only touches the neighbour, and the graze check correctly lets it through.
`targeting.ts:277` is the ledger of record. Do not re-add the guard without a fixture
that fails when it is removed — and such a fixture has to put an endpoint on a wall
surface, which is why none exists.

**Destructible walls are never merged**, and that is a rule, not an oversight. A
destructible cell is a destruction UNIT: mine blasts destroy by world-space radius
(`mines.ts`), so a finer grid means finer breaching. arena-02's centre barrier is
authored as adjacent blocks whose separate destruction is the level's design.

**The fourth is the hull-escape case: a hull INSIDE a wall escapes the mass, not the
sub-cell.** `circleVsAABB`'s `inside` branch pushes out through the nearest face of the
ONE box it is handed, which for a sub-cell is usually a buried internal seam — so the
same hull in the same place resolved differently depending only on the slicing
(measured: 780 of 1,681 interior centres on an isolated destructible mass).
`resolveWalls` now marches box to box along each axis to find where the wall MASS ends,
which is a property of the union. `circleVsAABB` itself is untouched, because
`bullets.ts` depends on it. This was reachable, not theoretical:
`separateTanks` drives hulls up to 0.375 units into a block and `stepMovement` calls
`resolveWalls` immediately afterwards.

**Two numbers in this section are NOT pinned by any test**, which by this file's own rule
is a debt: the 780 above (an independent reconstruction at the pre-fix commit measured
774, a 0.8% difference nobody has resolved — treat it as "most of an isolated destructible
mass's interior", not as a figure), and `targeting.ts`'s buried-face probe count, whose
guard is deleted so nothing can ever re-derive it. The decomposition GUARANTEES are pinned,
by `decomposition.test.ts`; these two provenance figures are not.

`src/sim/decomposition.test.ts` pins the property directly — the same geometry
expressed at two cell sizes must agree on `resolveWalls`, `lineOfSight` and `bankShot`.
`tools/baseline/trace.test.ts` is a golden trace over 4 arenas x 6 seeds x 2500 ticks
and is now ASSERTED, not merely printed: `determinism.test.ts` only proves
self-consistency, which is invariant under behaviour changes. **Know what it does not
cover, RE-MEASURED against the current tree.** Mutating `bankShot` to return the first
valid candidate instead of the shortest now changes the hash (to
`0cf1f76a14060992eb8763c9cd20e95b8c17cde2d1dbe3e8de6c87ff47137e9a`) and fails the test —
a later change to `resolveWalls` altered trajectories enough that bank shots now DO
influence the trace, even though the bank-shot rewrite itself did not move it when it
first landed. Mutating the inside-wall escape (disabling `resolveWalls`' union-mass
marching so a hull inside a wall resolves through the single sub-cell box instead) still
leaves the hash unchanged: the seeded replay never drives a hull inside a wall, so that
path stays uncovered. The lesson generalises: a coverage claim recorded at one commit can
go stale as later changes alter trajectories, so re-measure rather than carrying it
forward. The decomposition guarantees are held by `decomposition.test.ts`, not by this
hash.

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
`invincible`, `level` (a 1-based jump, or `level=sandbox`), and the sandbox knobs
`tanks`, `disarmed`, `walls`. `playtest=1` is a parse-time BUNDLE, not a field: it
expands to invincible + shellCount + mineReach + mineTimer. `parseDevFlags` derives the
boolean list from `DEV_FLAGS_OFF` in its tests, so adding one cannot quietly shrink what
they cover.

**`roundPhaseHud` is the first flag to complete the cycle: it SHIPPED, so the flag is
gone and the behaviour is on.** The round opens with `COUNTDOWN_TICKS` (3.0s) in which
movement is blocked; with no HUD, the player pressed a direction and the game read as
broken for three seconds of every round and every respawn. `devflags.test.ts` pins that
the retired key is not merely ignored but absent, so a stale `?dev=1&roundPhaseHud=1`
link cannot read as still meaning something.

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

**Retroreflecting wall seams: real, measure-zero, and do NOT apply the obvious fix.**
Solid walls now load as merged maximal rectangles (`mergeSolidRuns`, see "Walls load as
geometry, not as cells" above), not one AABB per grid cell — but a merged run still
abuts its neighbours at internal seams, so the buried-face hazard below is unchanged in
kind, only in which faces carry it. A ray arriving at *exactly* a seam coordinate can
enter through one of those buried faces; its normal then points along the run and the
shell reflects back the way it came instead of mirroring off the visible face. Measured
**against the pre-upscale `cellSize` 2 geometry, one AABB per grid cell** (retired since
this branch; not re-measured against merged geometry): **1 of 121 sampled crossings**
(45°, offsets −0.60..+0.60 in 0.01 steps against cellSize 2) — the one at exactly 0.00 —
and **0 of 155 ricochets** in 15 seeded games × 4000 ticks landed on an exact cell corner.
So it was not the hazard on every flat face the PR #1 backlog describes.

The obvious fix — reject a hit whose face is buried, by stepping a hair out along the normal
and testing containment in another wall — **was tried and reverted**: it fails 4 tests in
`collision.test.ts` and `escape.test.ts`. At the arena's concave inside corners the outward
step from a *legitimate* face lands inside the abutting perpendicular wall, so real surfaces
are misclassified as buried and shells pass straight through — reopening the escape bug that
holds a `SHELL_CAP` slot for the rest of a life. Any real fix must distinguish a coplanar
neighbour that continues the surface from a perpendicular one that merely touches it.
