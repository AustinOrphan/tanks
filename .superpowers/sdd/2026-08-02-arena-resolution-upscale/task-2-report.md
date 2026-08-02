# Task 2 Report: The transform

## Commits

- `2d6ebfe` — `wip: resolution pins before the upscale` (adds `tools/upscale-arenas.mjs`
  and `src/sim/resolution.test.ts`, data untouched, cellSize still 2)
- `3b60c7e` — `arenas: 3x upscale every shipped arena, cellSize 2 -> 2/3` (the transform's
  effect on `src/sim/config/data/arenas.json`, 192 insertions / 116 deletions per
  `git diff --stat`)

Files written verbatim from the brief: `tools/upscale-arenas.mjs`,
`src/sim/resolution.test.ts`. Modified: `src/sim/config/data/arenas.json`.

`git status --porcelain` was clean at the start of this task, and `tools/baseline/trace.test.ts`
was not modified (confirmed by `git status --porcelain tools/baseline/trace.test.ts` showing
nothing, both before and after).

## 1. The transform script's own output

```
$ node tools/upscale-arenas.mjs
arena-01 -> 33x27 @ 0.6666666666666666
arena-02 -> 33x27 @ 0.6666666666666666
arena-03 -> 33x27 @ 0.6666666666666666
arena-04 -> 45x33 @ 0.6666666666666666
```

Matches expectation: 11x9 -> 33x27, 15x11 -> 45x33, cellSize 2 -> 0.6666666666666666 (2/3
in float64) on all 4 arenas.

## 2. Read-back verification (brief's Step 5)

```
$ python3 -c "
import json
d=json.load(open('src/sim/config/data/arenas.json'))
for a in d['arenas']:
    spawns=[(c,r,ch) for r,row in enumerate(a['grid']) for c,ch in enumerate(row) if ch in 'PBGTON']
    print(f\"{a['id']}: {a['cols']}x{a['rows']} @ {a['cellSize']}  spawns={len(spawns)}  claims={len(a['claims'])}\")
    assert a['cols'] % 3 == 0 and a['rows'] % 3 == 0
    for s in spawns: assert s[0] % 3 == 1 and s[1] % 3 == 1, f'spawn off centre: {s}'
print('every spawn sits on a block centre')"

arena-01: 33x27 @ 0.6666666666666666  spawns=4  claims=1
arena-02: 33x27 @ 0.6666666666666666  spawns=5  claims=4
arena-03: 33x27 @ 0.6666666666666666  spawns=6  claims=8
arena-04: 45x33 @ 0.6666666666666666  spawns=7  claims=14
every spawn sits on a block centre
```

**Spawn-count comparison against Task 1's baseline table** (Task 1 report,
"Per-Arena Geometry" + the read-back script naming spawn counts): arena-01 4, arena-02 5,
arena-03 6, arena-04 7 — identical before and after the transform for all 4 arenas (4
arenas checked, population: all 4 shipped arenas). Claim counts (1, 4, 8, 14) also
unchanged, matching Task 1's "claims" column exactly.

## 3. The three resolution tests, before and after

**Before** `node tools/upscale-arenas.mjs` (data still at cellSize 2, commit `2d6ebfe`):

```
$ npx vitest run src/sim/resolution.test.ts --reporter=basic
 ❯ src/sim/resolution.test.ts (3 tests | 1 failed) 8ms
   × the arena resolution > is 2/3 on every shipped arena 5ms
     → arena-01: expected 2 to be close to 0.6666666666666666, received difference is 1.3333333333333335, but expected 5e-13

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

**Deviation from the brief's expectation, reported rather than papered over:** the brief's
Step 3 predicts "the first two fail, the third passes." Only the first (`cellSize`) failed;
the spawn-coordinate test passed even before the transform. This is not a defect in the
test or the transform — at cellSize 2 a spawn's position is already `2c+1`, so
`(v-1)/2 === c` is already an integer on the untouched data. The property the second test
checks ("sits on a coordinate the cellSize-2 grid also had") holds trivially of the
identity case; the brief's prediction was imprecise, not the test.

**After** `node tools/upscale-arenas.mjs` (commit `3b60c7e`):

```
$ npx vitest run src/sim/resolution.test.ts --reporter=basic
 ✓ src/sim/resolution.test.ts (3 tests) 5ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

All three resolution tests pass post-transform.

## 4. Claim cell references remapped

Verified by diffing every `claims[*].{from,to,enemy}` entry between the pre-transform
commit (`2d6ebfe`, `src/sim/config/data/arenas.json` at cellSize 2) and the post-transform
file, checking each against `[c,r] -> [3c+1, 3r+1]`:

```
arena-02: 4 refs — all OK
arena-03: 9 refs — all OK
arena-04: 20 refs — all OK
arena-01: 0 refs (its one claim, spawnBlockRobust, carries no from/to/enemy)
```

**33 of 33 cell references remapped correctly** (population: every `from`/`to`/`enemy`
array field across all 27 claims in the 4 shipped arenas — arena-01 has 1 claim/0 refs,
arena-02 has 4 claims/4 refs, arena-03 has 8 claims/9 refs, arena-04 has 14 claims/20
refs). No `enemy` key is present anywhere in the current data; the script's handling of it
is unexercised but harmless (the `Array.isArray` guard skips absent keys).

## 5. Full test suite after the transform

```
$ npx vitest run --reporter=basic
 Test Files  6 failed | 64 passed | 1 skipped (71)
      Tests  14 failed | 1208 passed | 1 skipped (1223)
```

`npx tsc --noEmit` is clean (no output, exit 0).

**14 of 1223 tests fail** (population: the full suite, 71 files). All 14, with root cause
classified by reading each assertion rather than assumed:

### Class A — population-pin literals expecting the old grid (Task 4's anticipated scope)

These assert counts that legitimately move now the grid is finer, matching the brief's own
description ("cell counts, wall counts, cover-ratio table"):

- `src/sim/arena-validation.test.ts > the cover ratio each arena quotes in its notes >
  recomputes every quoted count, and the ranking the note claims` — `EXPECTED` table
  (unseen/open per arena) is pinned to the old cell counts (e.g. arena-01 `{unseen:35,
  open:86}` vs. new `{unseen:288, open:774}`).
- `src/sim/arena-validation.test.ts > green's bank reach, which is why it is in level 4 >
  reaches 29 cells by ricochet it cannot see, covering 20 of the 35 nothing else sees` —
  same class, `{bankOnly:29, open:151}` vs. new `{bankOnly:275, open:1359}`.
- `src/sim/cell-mapping.test.ts > cellCentre and cellOf are exact inverses > round-trips
  every cell of every arena, including the non-square fixture` — pinned to 683 cells
  (expected 683, received 4379, matching the finer grid's total cell count).
- `src/sim/arena-claims.test.ts` — 7 sub-failures (`claimFailures reports a false claim of
  each type` x3, `spawnBlockRobust tags both wall phases...` x2, `renderBoard` x1, `failure
  boards point at the thing that failed` x1). These use small hand-built fixture grids and
  hardcoded cell coordinates/rendered-board strings sized for an 11x9 board; the module
  itself (`arena-claims.ts`) was not touched by this task, and CLAUDE.md's own "Known
  holes" section already documents `arena-claims.ts` as test-layer-only, imported by
  `arena-validation.test.ts`. Not individually decomposed further here — same class as the
  two above, a literal built against the old grid.

### Class B — stale literal offsets in fixtures/tests that assumed boundary thickness 2

Distinct from Class A (these aren't cell-count pins, they're hardcoded distances/dimensions
that assumed the old `cellSize` as the boundary ring's thickness), but still literal pins,
not geometry breaks:

- `src/game/loop.test.ts > startGameWith: construction > sizes the renderer to the arena
  and its boundary ring` — the test's own fake `levels.bounds()` fallback hardcodes
  `{ width: 22, height: 18, cellSize: 2 }` (`src/game/loop.test.ts:476`), not derived from
  the real `ARENAS`. Fails because `boundary` (2, from the fixture) no longer equals
  `CURRENT_ARENA.cellSize` (0.667, from the real data).
- `src/render/framing.test.ts > framedBounds > covers the playable area plus the boundary
  ring exactly` — hardcodes `{ width: W + 4, height: H + 4 }` (`framing.test.ts:31`),
  assuming a boundary ring 2 thick on each side (`+4` total). With the real boundary now
  `2/3`, the correct expectation is `W + BOUNDARY*2`, not `W + 4`.
- `src/sim/arena.test.ts > loadArena > encloses the play area with 4 boundary walls and no
  corner gaps` — the *exact-AABB-extent* assertions earlier in this same test
  (`arena.test.ts:137-149`, using `t = ARENA_01.cellSize` dynamically) did **not** fail —
  only the final sampling loop at line 186 did, over `samplePointsOnOutside` built with
  hardcoded offsets `-1`/`+1` (`arena.test.ts:156-170`) that assumed a boundary ring >= 1
  unit thick. With the ring now `2/3` thick, a probe 1 full unit outside the play area
  legitimately falls outside every boundary wall's AABB. This is confirmed to be a stale
  sample offset, not a real gap: the walls' own AABB extents (asserted exactly at lines
  137, 141, 145, 149, using `t` symbolically) all passed.

### Class C — a genuine float64 divergence the transform introduces (not a population pin)

- `src/render/framing.test.ts > framedBounds > matches the outer extent of the arena walls
  it has to cover` — expected `23.333333333333336`, received `23.333333333333332`: **a
  1-ULP difference**, reproduced directly:

  ```
  $ node -e "
  const cellSize = 2/3, cols = 33;
  const W = cols*cellSize, t = cellSize;
  console.log((W + t) - (-t));   // wall AABB extent: (W+t) - (-t)
  console.log(W + t*2);          // framedBounds: W + boundary*2
  "
  23.333333333333336
  23.333333333333332
  ```

  Both expressions are the same algebra (`W + 2t`), computed along two independent paths —
  `arena.ts`'s wall builder (`maxX = W + t`, `minX = -t`, extent = their difference) versus
  `framing.ts`'s `framedBounds` (`worldWidth + boundary * 2`) — that happened to agree
  exactly at `cellSize = 2` (an exact binary float) and diverge by 1 ULP now that
  `cellSize = 2/3` is not exactly representable. This is **not** a count that needs
  re-pinning; it is a precision/tolerance question (the test uses `toBe`, exact equality)
  that the plan's resolution tests did not cover — those only proved cell **centres**
  float-exact (`(3c+1+0.5)*(2/3) === (c+0.5)*2`), not compound **extents** built by summing
  independently-rounded terms. Flagging this explicitly as its own class, per the
  instruction not to let a step "fix" a number that moved for a reason the plan didn't
  anticipate: this is the one failure that is a genuine (if measure-zero, ~1.4e-16
  relative) numeric artifact of the transform rather than a stale literal, and Task 4
  should decide whether to loosen this one assertion to a tolerance rather than re-pin it
  to a new exact literal.

## What this task does NOT claim

`tools/baseline/trace.test.ts` ran as part of the full-suite pass above and did not throw,
but it contains no `expect` — it only computes and logs a hash (confirmed by
`grep -n "expect" tools/baseline/trace.test.ts` returning nothing). Its passing is evidence
only that it didn't crash, not that the seeded trace hash still matches Task 1's recorded
`178963a527144a4da1a9faa7b7058d758720010ca82be8d94470bee2f338ad5b`. Asserting hash
equivalence is explicitly Task 5's job; this report does not check or claim it.

## Summary for Task 4

14 of 1223 tests fail (population: full suite, 71 files, run via `npx vitest run
--reporter=basic`), across 6 files:

1. `src/sim/arena-validation.test.ts` (2 failures) — re-pin `EXPECTED`/`bankOnly` tables to
   the finer grid's counts.
2. `src/sim/cell-mapping.test.ts` (1 failure) — re-pin the 683-cell total.
3. `src/sim/arena-claims.test.ts` (7 failures) — fixture grids/rendered-board strings sized
   for the old resolution.
4. `src/game/loop.test.ts` (1 failure) — the test's own fake `levels.bounds()` fixture
   literal (`cellSize: 2`, `width: 22`, `height: 18`).
5. `src/render/framing.test.ts` (2 failures) — one literal-pin (`W + 4` -> `W + BOUNDARY*2`)
   and one genuine 1-ULP float divergence between two independently-computed extent
   formulas (needs a tolerance decision, not a re-pin).
6. `src/sim/arena.test.ts` (1 failure) — stale hardcoded probe offsets (`-1`/`+1`) that
   assumed boundary thickness >= 1; the underlying exact-AABB assertions in the same test
   already pass unchanged.

`npx tsc --noEmit` is clean. No test in this list was modified by this task.
