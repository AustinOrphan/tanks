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
  boards point at the thing that failed` x1). Read directly, one (`renderBoard reports an
  out-of-grid mark instead of throwing`, `arena-claims.test.ts:228-231`) does
  `const arena = arenaById('arena-01')` — **the real shipped arena-01, now upscaled to
  33x27**, not a hand-built fixture — and then asserts a message hardcoded to the old
  size: `expect(out).toMatch(/not drawn -- outside the 11x9 grid: \[99, 99\]/)`. The
  mechanism is a stale dimension **string** baked into the expected message, not a
  fixture built at the wrong resolution. The remaining 6 sub-failures were not read
  individually line-by-line, so their exact mechanism inside this file is not
  independently confirmed by this report.

  What **is** confirmed, and is the stronger evidence for this class: `arena-claims.ts`
  is the machinery this file unit-tests against small hand-built fixtures, while the same
  machinery's behaviour on the 4 real, upscaled shipped arenas is checked by the generic
  runner in `arena-validation.test.ts`. Running that file in isolation
  (`npx vitest run src/sim/arena-validation.test.ts --reporter=verbose`) shows `every
  declared design claim holds` passing for all 4 arenas (arena-01 through arena-04) — i.e.
  every real `sightlineAfterBreach`, `lane`, and `spawnBlockRobust` claim in the shipped
  data still holds after the upscale — and `arena-02's spawnBlockRobust figures, which no
  claim can protect > recomputes 0 of 16 intact and 12 of 16 breached` passes with the
  identical 0/16 and 12/16 figures CLAUDE.md documents for the pre-upscale grid. Of the 26
  tests in `arena-validation.test.ts`, exactly 2 fail (the two Class A count-pins above);
  every claim-holding assertion on the real arenas passes unchanged. That is direct
  evidence the claim *behaviour* is preserved by the transform, which makes it far more
  likely (though, for the 6 unread sub-failures, not individually proven) that
  `arena-claims.test.ts`'s failures are confined to that file's own small fixtures sized
  for the old grid, rather than a behavioural regression.

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
3. `src/sim/arena-claims.test.ts` (7 failures) — at least one confirmed to be a stale
   dimension string against the real arena-01 (`arenaById('arena-01')`, now 33x27,
   compared against a hardcoded "11x9 grid" message — not a hand-built fixture at the
   wrong resolution). The machinery this file tests is confirmed behaviourally intact on
   the real upscaled arenas (all 4 arenas' `every declared design claim holds` pass in
   `arena-validation.test.ts`, and arena-02's spawnBlockRobust figures are byte-identical:
   0/16 intact, 12/16 breached). The remaining 6 sub-failures were not each read
   individually by this report. *Update, post-review:* an independent reviewer remapped
   the coordinates for all 7 and recovered the exact pre-transform failure counts (4 and
   8), confirming all 7 are the same benign class this report classified from 1 of 7 read
   directly plus the arena-validation.test.ts evidence above.
4. `src/game/loop.test.ts` (1 failure) — the test's own fake `levels.bounds()` fixture
   literal (`cellSize: 2`, `width: 22`, `height: 18`).
5. `src/render/framing.test.ts` (2 failures) — one literal-pin (`W + 4` -> `W + BOUNDARY*2`)
   and one genuine 1-ULP float divergence between two independently-computed extent
   formulas (needs a tolerance decision, not a re-pin).
6. `src/sim/arena.test.ts` (1 failure) — stale hardcoded probe offsets (`-1`/`+1`) that
   assumed boundary thickness >= 1; the underlying exact-AABB assertions in the same test
   already pass unchanged.

`npx tsc --noEmit` is clean. No test in this list was modified by this task.

## Fix report (addressing review finding)

**Review outcome:** SPEC PASS, QUALITY PASS. An independent reviewer re-derived the
transform cell by cell (0 mismatches across 462 old cells, 22 spawn world positions, 33
claim references — matching this report's 33-of-33 figure exactly), confirmed the 1-ULP
diagnosis, and further established it does not reach collision: no production code
re-derives AABB extents by subtraction the way `framing.test.ts`'s own assertion does, and
`SWEEP_EPS` (`src/sim/constants.ts:133`, `1e-7`) is roughly 9 orders of magnitude larger
than the ~4e-16 gap, confirmed by:

```
$ grep -n "SWEEP_EPS = " src/sim/constants.ts
133:export const SWEEP_EPS = 1e-7;
```

**Finding:** the "Class A" passage above, in its original form, misdescribed the one
`arena-claims.test.ts` failure it read directly — it said the test's `renderBoard` call ran
against "a fixture arena literally sized 11x9 — a small hand-built board, not one of the 4
shipped arenas." That is wrong. The reviewer read the actual line:

```
$ sed -n '220,235p' src/sim/arena-claims.test.ts
    const failures = structuralFailures(noPlayer);
    expect(() => structuralFailures(noPlayer)).not.toThrow();
    expect(failures).toContain('no player spawn');
  });

  it('renderBoard reports an out-of-grid mark instead of throwing', () => {
    // It runs on the failure path, so a raw TypeError here buries the failure it
    // was called to explain. Before this, `rows[r][c] = '*'` threw.
    const arena = arenaById('arena-01');
    expect(() => renderBoard(arena, [[99, 99]])).not.toThrow();
    const out = renderBoard(arena, [[99, 99], [1, 1]]);
    expect(out).toMatch(/not drawn -- outside the 11x9 grid: \[99, 99\]/);
    expect(out.split('\n')[1][1]).toBe('*'); // the in-range mark still drawn
  });
```

`arena = arenaById('arena-01')` is the **real shipped arena-01**, now upscaled to 33x27 by
this task's transform — not a hand-built fixture. The failure's actual mechanism is a
stale dimension **string** hardcoded into the expected message (`/outside the 11x9 grid/`),
compared against the real arena's now-current size. The overall classification (stale test
literal, benign, not a geometry regression) was correct — the reviewer proved it
independently for all 7 of the 7 failures in this file by remapping coordinates and
recovering the exact pre-transform failure counts (4 and 8) — but the specific evidentiary
description of what was read was wrong about which arena, and has been corrected in both
the "Class A" passage and the "Summary for Task 4" list above to say: real `arena-01`
(shipped, now 33x27), stale "11x9" string in the expected message, not a fixture built at
the wrong size.

**Verification the fix reads correctly:**

```
$ grep -n "arenaById('arena-01')" .superpowers/sdd/2026-08-02-arena-resolution-upscale/task-2-report.md
```
confirms the corrected passage now names the real arena and cites the same
`arena-claims.test.ts:228-231` lines the review pointed at.
