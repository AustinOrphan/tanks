# Plan — Versus map variants: randomized subsets before procedural generation

Status: adopted 2026-08-17, implemented on branch `versus-map-variants`.

Provenance: a directive that versus maps should start as **authored boards with
randomized subsets**, moving to full procedural generation later. Builds on
`docs/superpowers/plans/2026-08-17-versus-spawns.md` (`pickVersusSpawnCell`, PR #188)
and `docs/superpowers/plans/2026-08-17-versus-board-rules.md`
(`evaluateVersusBoard`/`versusBoardCatalog`, PR #193 -- a checkable suitability
verdict). This PR builds the randomized-subset half named in the backlog's item 6
("Map selection / procedural generation"): one authored board now yields several
distinct playable variants, so a versus match on the same arena is not the identical
board every time. Whole-board procedural generation is unchanged and still unbuilt.

---

## What varies, and what never does

A variant omits a seeded, deterministic **subset of an arena's DESTRUCTIBLE cells**.
Solid geometry, board dimensions and the authored `P` cell are never touched. Two
reasons, both already load-bearing elsewhere in this codebase:

- **Solid walls define the arena's IDENTITY, not a parameter of it.** Their merged
  runs (`wall-merge.ts`'s `mergeSolidRuns`) feed collision and bank shots; varying
  them would change which board this is, not vary the same board.
- **A destructible cell is a destruction UNIT** (CLAUDE.md's "Destructible walls are
  never merged" section) -- arena-02's centre barrier is authored as adjacent blocks
  whose separate destruction is the level's design. Turning a destructible cell into
  open floor at LOAD time is the same kind of edit a mine blast already makes
  mid-round; this module only chooses WHICH cells, deterministically, before the
  round starts.

A variant is always a SUBSET of what the author placed -- never a superset. Nothing
here invents a destructible the author did not draw.

## Where it lives, and why the import graph forced a specific shape

`src/sim/versus-variants.ts` is a new, pure `src/sim/` module (purity rules apply;
`purity.test.ts` scans it like every other file there). Its one real caller is
`arena.ts`'s `loadArena`, which means this module must never import `arena.ts` back --
that would close a two-node cycle. It takes `grid`/`cols`/`rows`/`cellSize`/`legend`
as PRIMITIVES rather than an `Arena` object for exactly that reason, the same shape
`versus-spawns.ts` already takes for the identical cycle-avoidance reason (see that
module's own doc comment). Its two imports (`pickVersusSpawnCell`/`wallsForQuery` from
`versus-spawns.ts`, `lineOfSight` from `ai/targeting.ts`) are both leaves
`versus-spawns.ts` itself already uses, so reaching them from here adds no new
direction to the graph.

One consequence of the cycle constraint: the module cannot call `evaluateVersusBoard`
(`versus-board.ts`) to check a candidate's suitability, because `versus-board.ts`
imports `arena.ts`, and `arena.ts` imports this module -- routing through
`versus-board.ts` would close a three-node cycle. `isVariantSuitable` (internal to
`versus-variants.ts`) instead re-derives the two criteria that can actually regress
under destructible removal (`distinctSpawns`, `allPairsConcealed`) directly from
`pickVersusSpawnCell`/`wallsForQuery`/`lineOfSight` -- the same "small duplication to
avoid a cycle" precedent `wallsForQuery` itself already set against `loadArena`'s own
wall-building passes. `roomOk` is deliberately NOT re-derived here; see "Room is
monotone by construction" below for why.

## Determinism

Every draw goes through `nextRng` (`types.ts`'s mulberry32), chained: each Fisher-Yates
iteration feeds the PREVIOUS draw's returned seed into the next call, rather than
re-calling `nextRng` with the same integer every time (which would vary by seed but
produce a shuffle that only ever depends on ONE draw). `buildVariantGrid` is a pure
function of `(grid, cols, rows, legend, seed, fraction)` -- verified directly
(`versus-variants.test.ts`'s determinism block): the same seed twice yields
byte-identical output on all 5 shipped arenas, and different seeds draw different
subsets, measured on arena-02 (72 destructible cells, the most of any shipped board) --
seeds 1 and 2 differ, and a sample of 10 seeds there produces at least 8 distinct
grids (population: 10 draws, not exhaustive).

## Wiring: guard-first, `seed` reaches `loadArena` too

`loadArena` gains a trailing `seed?: number`. Only `mode === 'ffa' || mode === 'teams'`
**with** `seed !== undefined` ever calls `pickVersusVariantGrid`; every other call --
every campaign-coop load (regardless of seed), and every versus call that omits `seed`
-- takes the byte-identical original-grid path, unchanged from before this parameter
existed. `createWorldFor` threads its OWN `seed` parameter into `loadArena`'s new one,
so a real versus session (built through `game/levels.ts`'s existing `?dev=1&mode=ffa`
path, which already passes a seed for AI RNG) gets a deterministic variant
automatically, with no new call site needed. Reusing the same seed a session already
carries -- rather than a second, variant-only seed -- is also what makes a replay's own
stamped seed (`replayMetaFor`, `game/replay.ts`) enough to reproduce the exact board it
was played on, with no new replay field.

`World.arenaGeometry` (used by versus respawns, `world.ts`'s `respawnPos`) is built
from the SAME grid PASS 1a/1b/2a/2b consumed -- the variant's grid when one was picked
-- so a respawn's own `pickVersusSpawnCell` call sees the board that is actually being
played, not the authored one.

## Keeping the variant playable

### Connectivity: proved by construction, then verified

**Claim**: removing destructible cells cannot disconnect the board -- a region
reachable before stays reachable after.

**Proof.** Define the walkable-cell graph `G(grid)` over 4-connected cells where
`isWalkable` holds (true for `.` and every spawn letter, false for solid AND
destructible -- `versus-spawns.ts`'s own predicate). `buildVariantGrid` only ever turns
a DESTRUCTIBLE character into `.`; every other cell's character is untouched, and a
destructible cell is NEVER walkable in the authored grid. So every cell walkable in
`grid`, and every edge between two walkable cells, survives into `G(variant)`
UNCHANGED -- `G(variant)` is a strict superset of `G(grid)` as a graph (identical
vertices and edges, plus possibly more). Two cells connected in `G(grid)` therefore
stay connected in `G(variant)` via the IDENTICAL path, and turning more cells walkable
can only merge components or add newly-reached ones, never split an existing one. This
holds for ANY subset of destructible cells, not just the ones `buildVariantGrid`
happens to draw -- the mechanism, not the specific fraction, is what makes it true.

**Verified, not left as argument alone** (`versus-variants.test.ts`): BFS reachability
from the P1 cell, on real shipped geometry -- **25 of 25 (arena, seed) pairs** (5
shipped arenas x 5 seeds) show `reachable(authored)` is a SUBSET of
`reachable(variant)`, and the claim is not vacuously true because nothing ever gets
removed near reachable floor: on arena-02, reachability strictly GROWS (measured, not
merely non-decreasing).

### Room: monotone by construction (not re-checked at variant-selection time)

`openFloorCells` counts `.` characters. A destructible character is never `.`; turning
one into `.` adds exactly 1 to the count. So `openFloorCells(variant) ===
openFloorCells(authored) + removedCount`, EXACTLY -- verified on all 5 shipped arenas
(`versus-variants.test.ts`). Since `roomOk` is `openFloorCells / playerCount >=
MIN_OPEN_FLOOR_PER_PLAYER` (`versus-board.ts`) and `playerCount` is fixed for a given
match, `roomOk` can only become EASIER to satisfy after a variant, never harder. All 15
shipped (arena, N) combinations already measure `roomOk` true by more than an order of
magnitude (`versus-board.test.ts`'s own sweep), so this is not a close call on any
shipped board -- it is why `isVariantSuitable` does not re-check `roomOk`: the retry
gate exists for the criterion that CAN regress (concealment), not for one that
provably cannot.

### Concealment: genuinely empirical, and the reason a gate exists at all

Removing a destructible wall can open a sightline between two spawn cells that was
blocked before, and `pickVersusSpawnCell`'s own ranking can pick DIFFERENT cells once
more candidates exist -- neither is guaranteed safe by construction the way room and
connectivity are. This is the one criterion `isVariantSuitable` actually gates on
(along with `distinctSpawns`, which the room argument does not extend to as cleanly --
kept as a direct, independent check rather than assumed).

## How much to remove: measured, not chosen by taste

**Measured destructible-cell counts, the population every removal figure below is
derived from** (5 shipped arenas):

| arena | destructible cells | solid cells | open floor | total cells |
|---|---|---|---|---|
| arena-01 | 18 | 99 | 770 | 891 (33x27) |
| arena-02 | 72 | 72 | 742 | 891 (33x27) |
| arena-03 | 27 | 72 | 786 | 891 (33x27) |
| arena-04 | 27 | 99 | 1352 | 1485 (45x33) |
| arena-05 | 18 | 108 | 1351 | 1485 (45x33) |

**Suitability of the UNGATED draw** (`buildVariantGrid` + `evaluateVersusBoard`
directly, bypassing `pickVersusVariantGrid`'s own retry/fallback -- this measures
whether a given fraction alone needs the gate). Swept at 5 shipped arenas x
`{2,3,4}` players x 100 seeds = 1500 draws per fraction:

| fraction | unsuitable / 1500 | failing criterion | which (arena, N) |
|---|---|---|---|
| 0.40 | 0 | -- | -- |
| 0.45 | 0 | -- | -- |
| 0.50 | 1 | concealment | arena-02 @ N=4 |
| 0.55 | 0 | -- | -- |
| 0.60 | 0 | -- | -- |
| 0.65 | 3 | concealment | arena-03 @ N=4 |
| 0.70 | 5 | concealment | arena-03 @ N=4 |
| 0.75 | 3 | concealment | arena-03 @ N=4 |
| 0.80 | 5 | concealment | arena-02 @ N=3 (1), arena-02 @ N=4 (1), arena-03 @ N=4 (3) |

Every failure across the whole sweep is concealment -- never `distinctSpawns`, never
`room` (consistent with room's proof above). **This is not the non-discriminating
finding the board-rules PR reported**: unlike that PR's fixed 15 (arena, N)
combinations (no removal fraction to vary), this sweep DOES reject boards once the
fraction climbs past roughly 0.45-0.5, which is what makes the retry/fallback
machinery real rather than decorative -- it has somewhere to matter, even though the
CHOSEN operating fraction sits below where failures start appearing.

**Chosen: `DESTRUCTIBLE_REMOVAL_FRACTION = 0.4`.** On the frontier just before failures
start appearing (0.45 is also clean; 0.5 is the first fraction with a measured
failure), while still removing a substantial, visibly different fraction of each
arena's destructible cells:

| arena | destructible cells | removed at 0.4 (`round(count * 0.4)`) |
|---|---|---|
| arena-01 | 18 | 7 |
| arena-02 | 72 | 29 |
| arena-03 | 27 | 11 |
| arena-04 | 27 | 11 |
| arena-05 | 18 | 7 |

Re-measured directly at the chosen fraction with a smaller, deterministic seed sample
(`versus-variants.test.ts`, reproducible in CI): **0 of 150 (arena, N, seed) draws are
unsuitable** -- 5 arenas x 3 player counts x 10 fixed seeds.

## Deciding what happens when a draw is unsuitable: retry, bounded, then fall back

Three options were on the table (retry, fall back immediately, accept as-is); retry
with a bounded fallback was chosen because the measurement above shows the failure
mode is real (nonzero above ~fraction 0.5) even though rare at the operating point --
"accept it" would ship a genuinely unsuitable board on the rare draw that hits it, and
"fall back immediately with no retry" throws away a chained seed's second chance for
free. `pickVersusVariantGrid` retries with a freshly CHAINED seed (never re-drawing the
same failed candidate) up to `VARIANT_RETRY_BOUND = 5` times, then falls back to the
AUTHORED grid unchanged -- never an unbounded loop, and never a returned variant that
fails the gate.

Both branches are proven to actually execute, not merely argued (`versus-variants.test.ts`):

- **Retry succeeds**: seed 7920 on arena-03 at N=4, fraction 0.7 (above the production
  fraction, chosen because the sweep table above shows real failures starting there) --
  the first draw measurably fails concealment; the SECOND draw, from the chained seed,
  is suitable, and is neither the failed first candidate nor a coincidental fallback to
  the (also-suitable-on-this-arena) authored grid. This last check mattered in
  practice: an earlier, weaker version of this test only checked "differs from the
  first draw and is itself suitable," which a bound-of-1 mutation (immediate fallback)
  also satisfies on this specific arena, since arena-03's authored board happens to be
  suitable at N=4 too -- caught during mutation testing, not before.
- **Full exhaustion falls back**: a synthetic fixture (a 10x10 room whose ONLY cover is
  a full row of destructible cells) is suitable when intact and collapses to the same
  fully-open, always-unsuitable room `versus-board.test.ts`'s own concealment negative
  control uses once every destructible cell is removed (fraction 1.0, deterministic
  regardless of seed). Every retry draws the identical always-unsuitable candidate, and
  `pickVersusVariantGrid` returns the AUTHORED grid, by REFERENCE -- the literal
  fallback branch, not a coincidentally-identical rebuild.

## Mutation testing: four entries, all killed, each proven by hand first

Each entry below was applied by hand, the scoped test file(s) re-run and watched fail,
the file restored and byte-compared (`diff` against a saved copy, not merely a zero
exit code), THEN re-verified through the real harness (`npm run mutate -- --only
<id>`), then the full manifest was run.

- `versus-variants-guard-drops-mode-check` (drops the `mode === 'ffa' || mode ===
  'teams'` half of `loadArena`'s guard, in `arena.ts`): **killed, 2 of 32**
  (`versus-variants.test.ts` + `tools/baseline/trace.test.ts`, scoped together). Any
  call that passes a real seed now gets a variant, including every campaign-coop load
  -- `BASELINE_HASH` moved from `a5458ede...` to `70dd6777...` under this mutation
  (confirmed by hand), and `versus-variants.test.ts`'s own "campaign-coop is
  BYTE-IDENTICAL... even when a real seed is passed" test fails too.
- `versus-variants-concealment-check-dropped` (discards the `lineOfSight` result
  instead of gating on it, in `versus-variants.ts`): **killed, 2 of 25**
  (`versus-variants.test.ts`). The retry-succeeds test (the first, unsuitable draw is
  now accepted immediately) and the full-exhaustion fallback test (the
  always-unsuitable fixture is now accepted on attempt 0) both fail.
- `versus-variants-retry-bound-forced-to-one` (`attempt < VARIANT_RETRY_BOUND` ->
  `attempt < 1`): **killed, 1 of 25**. See the retry section above for why the test
  that catches this had to be strengthened first -- the original version survived this
  exact mutation.
- `versus-variants-includes-solid-cells` (widens the draw pool to `'destructible' ||
  'solid'`): **killed, 3 of 25**. The "only destructible cells change" invariant, the
  exact removal-count check (47 removed on arena-01 instead of 7), and the seed-7920
  retry test's own premise (a much larger pool changes what that seed draws) all fail.

## Gate

`npm test`, `npm run build`, `npm run mutate` and `npx vitest run
tools/baseline/trace.test.ts` all pass, with `BASELINE_HASH` unmoved at
`a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`. See the PR's own
evidence for the real, pasted output.

## Out of scope, named

Whole-board procedural generation (this PR only varies destructible cells within an
authored solid-wall skeleton); any UI or menu; map selection; solid-wall variation;
any change to campaign-coop's behaviour. See `docs/superpowers/backlog.md`'s "Spike:
the rest of versus mode" entry, updated in this PR to record what moved.
