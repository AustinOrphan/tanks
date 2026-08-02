# Walls as Geometry, Not Cells — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sim's answers depend on the arena's geometry rather than on how that geometry happens to be sliced into grid cells, so a resolution change is a data edit and not a behaviour change.

**Architecture:** Three independent defects found in the Task 5 investigation of `2026-08-02-arena-resolution-upscale.md` (see `.superpowers/sdd/2026-08-02-arena-resolution-upscale/task-5-report-addendum.md` for the evidence). Tank ids are drawn from a counter shared with walls, so wall count reseeds every per-tank RNG stream; `resolveWalls` applies one push per overlapping wall, so a subdivided wall pushes several times and its interior seams present phantom corners; `bankShot` returns the first reflector in array order. Fixed by numbering tanks independently of walls, merging **solid** walls into maximal rectangles at load, and resolving collisions against the deepest single overlap iteratively.

**Tech Stack:** TypeScript, vitest, JSON arena data validated at module load. No new dependencies.

## Global Constraints

- `src/sim/` imports nothing from `three`, `howler`, or the DOM. `src/sim/purity.test.ts` scans raw text **including strings and test titles**.
- `CLAUDE.md` and `AGENTS.md` must stay **byte-identical** (`cmp CLAUDE.md AGENTS.md`).
- No `Co-Authored-By` or tool-attribution trailers in commit messages.
- Every new assertion must be able to fail. Before adding one, name the production change that breaks it, apply that change, watch it fail, revert.
- **Commit before running any mutation experiment.** The revert step is `git checkout -- FILE`, which cannot distinguish finished work from deliberate breakage.
- Write commit messages from `git diff --stat` / `git show`, never from recollection.
- State denominators: "32 of 36 (population: all 36 single-cell moves)", never a bare count.
- **`DESTRUCTIBLE WALLS ARE NEVER MERGED.`** A destructible cell is a destruction unit; mine blasts destroy by world-space radius (`mines.ts:141`), so finer cells mean finer breaching, which is the point of the resolution change. arena-02's centre barrier is authored as separate 2.0 blocks in runs of three (4 orthogonally-adjacent pairs in the pre-upscale data) — merging them would fuse a level's whole design into one entity.

## Baseline this plan starts from

`curve` at `294aa2b`. `npx vitest run tools/baseline/trace.test.ts` prints `BASELINE e214e0dcadbb3ffd143c265f5c1c9cb606dcb1044891832895094d5d77ce38ba`. That hash **will** change in this plan — deliberately, and once per behaviour task, which is why each task records it.

## File Structure

- `src/sim/arena.ts` — `loadArena` gains a tank pass separate from the wall pass, and a `mergeSolidRuns` step. This is the only file that turns data into entities, so both changes belong here.
- `src/sim/collision.ts` — `resolveWalls` rewritten. Its callers (`world.ts:116`, `collision.ts:340`) are unchanged.
- `src/sim/decomposition.test.ts` — **new.** The property this plan buys: an arena and a finer slicing of the same geometry must agree. Lives beside the sim it tests, not under `tools/`.
- `tools/baseline/trace.test.ts` — **kept, not deleted.** Becomes a permanent pinned golden trace (the original plan deleted it; CLAUDE.md's own rule is that a behaviour-preserving claim needs a golden trace, so it should ship).
- Pins that move: `src/sim/cell-mapping.test.ts`, `src/sim/arena-validation.test.ts`, `src/sim/arena.test.ts`, `src/sim/collision.test.ts`, `src/sim/escape.test.ts`.

---

### Task 1: Tank ids stop depending on wall count

**Files:**
- Modify: `src/sim/arena.ts` (the `loadArena` grid loop, ~lines 85–112)
- Test: `src/sim/arena.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `loadArena(arena)` returns `{ walls, tanks, spawns }` unchanged in shape. Tank ids are now `1..N` in grid scan order; wall ids are `N+1..N+M`. All ids stay globally unique, which `createWorld`'s `nextId = max(wall ids, tank ids) + 1` (`world.ts:47`) depends on.

- [ ] **Step 1: Write the failing test**

Add to `src/sim/arena.test.ts`:

```ts
it('numbers tanks independently of how many wall cells precede them', () => {
  // Same spawns, same order, different wall counts. A tank's id must not move.
  const base = {
    cols: 5, rows: 3, cellSize: 2,
    legend: { '#': 'solid' as const },
    grid: ['.....', '..P..', '.....'],
  };
  const walled = { ...base, grid: ['#####', '#.P..', '.....'] };
  const a = loadArena({ id: 'a', ...base } as never);
  const b = loadArena({ id: 'b', ...walled } as never);
  expect(a.tanks.map((t) => t.id)).toEqual(b.tanks.map((t) => t.id));
  // ...and ids are still globally unique, which createWorld's nextId relies on.
  const all = [...b.tanks.map((t) => t.id), ...b.walls.map((w) => w.id)];
  expect(new Set(all).size).toBe(all.length);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/sim/arena.test.ts -t 'numbers tanks independently'
```

Expected: FAIL. On `294aa2b` the walled grid's `P` is preceded by 6 wall cells, so its id is 7 against the unwalled grid's 1.

- [ ] **Step 3: Split the single pass into two**

In `src/sim/arena.ts`, replace the combined loop with a tank pass followed by a wall pass. Tanks first so their ids are the low, stable range:

```ts
  const walls: Wall[] = [];
  const tanks: Tank[] = [];
  const spawns: Spawn[] = [];

  // PASS 1 — spawns. Tank ids must be a function of the SPAWN ORDER alone. They used
  // to share a counter with walls, which made every tank's id a function of how many
  // wall cells preceded it -- and tank.id seeds all four per-tank RNG streams in
  // ai/targeting.ts (wanderMove, aimJitter, mineInclination, seekMove's retreat draw),
  // so re-slicing the grid silently rerolled every enemy's behaviour for the whole game.
  let id = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kind = SPAWN_LETTERS[grid[r][c]];
      if (!kind) continue;
      const pos = { x: (c + 0.5) * cellSize, y: (r + 0.5) * cellSize };
      spawns.push({ kind, pos: { ...pos }, angle: 0 });
      tanks.push(makeTank(id++, kind, pos, 0));
    }
  }

  // PASS 2 — walls, numbered after the tanks so every id in the world stays unique
  // (createWorld derives nextId from the maximum of both).
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wallKind = legend[grid[r][c]];
      if (!wallKind) continue;
      walls.push({
        id: id++,
        aabb: {
          minX: c * cellSize, minY: r * cellSize,
          maxX: (c + 1) * cellSize, maxY: (r + 1) * cellSize,
        },
        kind: wallKind,
        destroyed: false,
      });
    }
  }
```

Keep the three validation loops above it exactly as they are.

- [ ] **Step 4: Run the test and the suite**

```bash
npx vitest run src/sim/arena.test.ts -t 'numbers tanks independently'   # expect PASS
npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |Test Files"
```

Fix any test that pinned a literal tank or wall id. Record which ones moved and why in the commit body.

- [ ] **Step 5: Record the new trace hash**

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
```

Expected: differs from `e214e0d…`. That is the point of the task — write the value into the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/sim/arena.ts src/sim/arena.test.ts
git commit -m "sim: tank ids stop being a function of wall count"
```

---

### Task 2: Merge solid wall runs into maximal rectangles

**Files:**
- Modify: `src/sim/arena.ts`
- Test: `src/sim/arena.test.ts`

**Interfaces:**
- Consumes: Task 1's two-pass `loadArena`.
- Produces: `loadArena` emits **one `Wall` per maximal solid rectangle** and one per destructible cell. Wall count drops (arena-01 121 → 27 measured against the shipped data). Nothing downstream changes shape: `Wall` is `{ id, aabb, kind, destroyed }` as before.

- [ ] **Step 1: Write the failing tests**

```ts
it('emits one wall per maximal solid rectangle', () => {
  const a = loadArena({
    id: 'run', cols: 5, rows: 3, cellSize: 2,
    legend: { '#': 'solid' as const },
    grid: ['###..', '.....', '.....'],
  } as never);
  // 3 cells in a row -> ONE wall spanning them, plus the 4 boundary walls.
  const interior = a.walls.filter((w) => w.aabb.minX >= 0 && w.aabb.minY >= 0);
  expect(interior).toHaveLength(1);
  expect(interior[0].aabb).toEqual({ minX: 0, minY: 0, maxX: 6, maxY: 2 });
});

it('never merges destructible cells, which are destruction units', () => {
  const a = loadArena({
    id: 'bar', cols: 5, rows: 3, cellSize: 2,
    legend: { x: 'destructible' as const },
    grid: ['xxx..', '.....', '.....'],
  } as never);
  const dest = a.walls.filter((w) => w.kind === 'destructible');
  expect(dest).toHaveLength(3);
});
```

- [ ] **Step 2: Run them and watch the first fail**

```bash
npx vitest run src/sim/arena.test.ts -t 'maximal solid rectangle'
```

Expected: FAIL, `expected length 3 to be 1`. The second test passes already — it is the guard that the merge does not overreach, so it must be written now and watched to survive the change.

- [ ] **Step 3: Implement the merge**

Add above `loadArena` in `src/sim/arena.ts`:

```ts
/**
 * Maximal-rectangle decomposition of a solid-cell mask: horizontal runs per row, then
 * runs with identical extent stacked vertically.
 *
 * CANONICAL — the same region yields the same rectangles whatever cell size expressed
 * it, which is the whole point: resolveWalls and bankShot both read the wall ARRAY, so
 * a wall's slicing was leaking into collision and aiming.
 *
 * Solid only. A destructible cell is a destruction unit -- mine blasts destroy by
 * world-space radius, so finer cells mean finer breaching -- and arena-02's centre
 * barrier is authored as adjacent 2.0 blocks that must stay separately destructible.
 */
function mergeSolidRuns(mask: boolean[][], cols: number, rows: number): [number, number, number, number][] {
  const runs: { r: number; c0: number; c1: number }[] = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!mask[r][c]) { c++; continue; }
      let c1 = c;
      while (c1 + 1 < cols && mask[r][c1 + 1]) c1++;
      runs.push({ r, c0: c, c1 });
      c = c1 + 1;
    }
  }
  const used = new Set<number>();
  const rects: [number, number, number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const a = runs[i];
    let rEnd = a.r;
    for (;;) {
      const j = runs.findIndex((b, k) => !used.has(k) && b.r === rEnd + 1 && b.c0 === a.c0 && b.c1 === a.c1);
      if (j < 0) break;
      used.add(j);
      rEnd++;
    }
    rects.push([a.c0, a.r, a.c1 + 1, rEnd + 1]);
  }
  return rects;
}
```

Then replace Task 1's PASS 2 with:

```ts
  // PASS 2a -- solid walls, merged into maximal rectangles.
  const solid: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    solid.push([]);
    for (let c = 0; c < cols; c++) solid[r].push(legend[grid[r][c]] === 'solid');
  }
  for (const [c0, r0, c1, r1] of mergeSolidRuns(solid, cols, rows)) {
    walls.push({
      id: id++,
      aabb: { minX: c0 * cellSize, minY: r0 * cellSize, maxX: c1 * cellSize, maxY: r1 * cellSize },
      kind: 'solid',
      destroyed: false,
    });
  }

  // PASS 2b -- destructible walls, one per cell, never merged.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wallKind = legend[grid[r][c]];
      if (wallKind !== 'destructible') continue;
      walls.push({
        id: id++,
        aabb: {
          minX: c * cellSize, minY: r * cellSize,
          maxX: (c + 1) * cellSize, maxY: (r + 1) * cellSize,
        },
        kind: wallKind,
        destroyed: false,
      });
    }
  }
```

- [ ] **Step 4: Run the tests and the suite**

```bash
npx vitest run src/sim/arena.test.ts -t 'maximal solid rectangle'   # expect PASS
npx vitest run src/sim/arena.test.ts -t 'never merges destructible' # expect PASS
npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |Test Files"
```

`cell-mapping.test.ts` and any wall-count pin will fail; those move in Task 5. Note the failures, do not fix them yet.

- [ ] **Step 5: Prove the destructible guard can fail**

Delete `!== 'destructible'` from PASS 2b's filter so destructibles merge too, re-run `-t 'never merges destructible'`, watch it FAIL, revert. A guard nobody has seen fail is not a guard.

- [ ] **Step 6: Record the hash and commit**

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
git add src/sim/arena.ts src/sim/arena.test.ts
git commit -m "sim: solid walls load as maximal rectangles, not one box per cell"
```

---

### Task 3: `resolveWalls` resolves against the deepest overlap, iteratively

**Files:**
- Modify: `src/sim/collision.ts:297`
- Test: `src/sim/collision.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `resolveWalls(tank: Tank, walls: Wall[]): void` — same signature, same callers (`world.ts:116`, `collision.ts:340`).

- [ ] **Step 1: Write the failing test**

```ts
it('resolves a hull the same way however the wall is sliced', () => {
  const one: Wall[] = [
    { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 6, maxY: 2 } },
  ];
  const three: Wall[] = [0, 2, 4].map((x, i) => ({
    id: i + 1, kind: 'solid' as const, destroyed: false,
    aabb: { minX: x, minY: 0, maxX: x + 2, maxY: 2 },
  }));
  // A hull overlapping the seam at x=2 must land in the same place either way.
  for (const x of [1.9, 2.0, 2.1, 3.0]) {
    const a = { ...makeTank(1, 'player', { x, y: 2.3 }, 0) };
    const b = { ...makeTank(1, 'player', { x, y: 2.3 }, 0) };
    resolveWalls(a, one);
    resolveWalls(b, three);
    expect(b.pos.x, `x=${x}`).toBeCloseTo(a.pos.x, 9);
    expect(b.pos.y, `x=${x}`).toBeCloseTo(a.pos.y, 9);
  }
});

it('pushes a hull clear of a concave corner', () => {
  const walls: Wall[] = [
    { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 4, maxY: 2 } },
    { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 2, maxX: 2, maxY: 6 } },
  ];
  const t = makeTank(1, 'player', { x: 2.3, y: 2.3 }, 0);
  resolveWalls(t, walls);
  for (const w of walls) expect(circleVsAABB(t.pos, TANK_RADIUS, w.aabb).hit, `wall ${w.id}`).toBe(false);
});
```

- [ ] **Step 2: Run and watch the first fail**

```bash
npx vitest run src/sim/collision.test.ts -t 'however the wall is sliced'
```

Expected: FAIL at `x=1.9` or `x=2.1` — the three-box case applies two pushes where the one-box case applies one.

- [ ] **Step 3: Rewrite `resolveWalls`**

```ts
/**
 * Push a tank out of the walls it overlaps, resolving the DEEPEST overlap at a time
 * until it is clear.
 *
 * It used to apply a push for EVERY overlapping wall in array order, which made the
 * result a function of how the level data was sliced rather than of its geometry: a
 * hull straddling three sub-cells of one flat run took three compounding pushes, and
 * each interior seam offered the circle-vs-box nearest-feature test a CORNER where the
 * real surface is flat. Measured over the shipped boards, 8,846 of 48,207 reachable
 * wall-touching hull positions resolved somewhere different after a 3x re-slice, worst
 * case 0.481 against a TANK_RADIUS of 0.5.
 *
 * Taking only the deepest overlap fixes that, because the deepest penetration is a
 * property of the UNION: for a hull over a flat run, the sub-cell beneath the centre
 * offers a face push that is strictly deeper than its neighbours' corner pushes, which
 * is exactly what the unsliced wall would have offered. Ties are broken on the push
 * VECTOR, not array position, so the tiebreak is geometric too.
 *
 * Iterating is what keeps concave corners correct -- clearing the deepest wall can
 * leave the hull inside a perpendicular one, so it goes round again. Bounded by
 * SWEEP_MAX_ITERATIONS; a gap narrower than the hull cannot be resolved by any
 * displacement and simply exhausts the budget rather than looping forever.
 */
export function resolveWalls(tank: Tank, walls: Wall[]): void {
  for (let iter = 0; iter < SWEEP_MAX_ITERATIONS; iter++) {
    let best: Vec2 | null = null;
    let bestDepth = 0;
    for (const wall of walls) {
      if (wall.destroyed) continue;
      const hit = circleVsAABB(tank.pos, TANK_RADIUS, wall.aabb);
      if (!hit.hit) continue;
      const depth = Math.hypot(hit.push.x, hit.push.y);
      if (depth > bestDepth || (depth === bestDepth && best !== null &&
          (hit.push.x > best.x || (hit.push.x === best.x && hit.push.y > best.y)))) {
        bestDepth = depth;
        best = hit.push;
      }
    }
    if (best === null || bestDepth <= SWEEP_EPS) return;
    tank.pos = vadd(tank.pos, best);
  }
}
```

- [ ] **Step 4: Run the new tests, then the collision and escape suites**

```bash
npx vitest run src/sim/collision.test.ts src/sim/escape.test.ts 2>&1 | grep -E "Tests |×"
```

Expect both new tests PASS. Any pre-existing failure here is a real behaviour change: read it, decide whether the old expectation encoded the old bug, and record the judgement in the commit body. Do not blanket-update expectations.

- [ ] **Step 5: Prove the iteration bound is load-bearing**

Set `SWEEP_MAX_ITERATIONS` to 1 locally, run `-t 'concave corner'`, watch it FAIL, revert. Then commit before any further experiment.

- [ ] **Step 6: Record the hash and commit**

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
git add src/sim/collision.ts src/sim/collision.test.ts
git commit -m "sim: resolve a hull against the deepest wall overlap, not every one"
```

---

### Task 4: The invariance property, as a shipping test

**Files:**
- Create: `src/sim/decomposition.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: nothing other tasks read.

This is the test that would have caught all three defects before the upscale, and the reason the plan is worth doing. It asserts the property directly: **the same geometry, sliced two ways, must give the same answers.** Solid-only fixtures, because destructible granularity legitimately differs between resolutions.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { loadArena } from './arena';
import { resolveWalls } from './collision';
import { lineOfSight, bankShot } from './ai/targeting';
import { makeTank } from './arena';

/** The same solid geometry at cellSize 2, and re-expressed at cellSize 1. */
const COARSE = {
  id: 'coarse', cols: 6, rows: 6, cellSize: 2,
  legend: { '#': 'solid' as const },
  grid: ['......', '.###..', '.#....', '.#....', '......', '......'],
} as never;
const FINE = {
  id: 'fine', cols: 12, rows: 12, cellSize: 1,
  legend: { '#': 'solid' as const },
  grid: [
    '............', '............',
    '..######....', '..######....',
    '..##........', '..##........',
    '..##........', '..##........',
    '............', '............',
    '............', '............',
  ],
} as never;

describe('the sim reads geometry, not the grid that expressed it', () => {
  const a = loadArena(COARSE).walls;
  const b = loadArena(FINE).walls;
  const pts = [];
  for (let x = 0.35; x < 12; x += 0.37) for (let y = 0.35; y < 12; y += 0.37) pts.push({ x, y });

  it('resolves every hull position identically', () => {
    let moved = 0;
    for (const p of pts) {
      const ta = makeTank(1, 'player', { ...p }, 0);
      const tb = makeTank(1, 'player', { ...p }, 0);
      resolveWalls(ta, a);
      resolveWalls(tb, b);
      if (ta.pos.x !== p.x || ta.pos.y !== p.y) moved++;
      expect(tb.pos.x, `x=${p.x} y=${p.y}`).toBeCloseTo(ta.pos.x, 9);
      expect(tb.pos.y, `x=${p.x} y=${p.y}`).toBeCloseTo(ta.pos.y, 9);
    }
    // Guard against a vacuous pass: the sweep must actually touch the walls.
    expect(moved).toBeGreaterThan(50);
  });

  it('agrees on line of sight for every ordered pair', () => {
    for (const m of pts) for (const t of pts) {
      expect(lineOfSight(m, t, b), `${m.x},${m.y} -> ${t.x},${t.y}`).toBe(lineOfSight(m, t, a));
    }
  });

  it('agrees on the bank shot for every ordered pair', () => {
    for (const m of pts) for (const t of pts) {
      const x = bankShot(m, t, a, 1);
      const y = bankShot(m, t, b, 1);
      if (x === null || y === null) expect(y, `${m.x},${m.y} -> ${t.x},${t.y}`).toBe(x);
      else expect(y, `${m.x},${m.y} -> ${t.x},${t.y}`).toBeCloseTo(x, 9);
    }
  });
});
```

If the point sweep makes the pair tests too slow, thin `pts` for those two only and say so in a comment with the resulting population — do not silently sample.

- [ ] **Step 2: Run it**

```bash
npx vitest run src/sim/decomposition.test.ts 2>&1 | grep -E "Tests |×"
```

Expected: PASS. If the bank-shot case fails, that is the honest outcome — `bankShot` still returns the first reflector in array order and merging only reduced the exposure. Record the failure, mark that test `it.fails` with a comment naming the residual, and raise it in the PR body rather than weakening the assertion.

- [ ] **Step 3: Prove each assertion can fail**

Revert `resolveWalls` to the old every-wall loop, run, watch the first test FAIL, restore. Then disable the solid merge in `arena.ts`, run, watch it FAIL again, restore.

- [ ] **Step 4: Commit**

```bash
git add src/sim/decomposition.test.ts
git commit -m "test: the same geometry sliced two ways must give the same answers"
```

---

### Task 5: Move the pins that legitimately move, and re-baseline

**Files:**
- Modify: `src/sim/cell-mapping.test.ts`, `src/sim/arena-validation.test.ts`, `src/sim/arena.test.ts`
- Modify: `tools/baseline/trace.test.ts`

- [ ] **Step 1: See what is left failing**

```bash
npx tsc --noEmit && npx vitest run 2>&1 | grep -E "×|Tests |Test Files"
```

- [ ] **Step 2: Fix each failure, one commit-message line each**

For every failure, classify it as exactly one of: a wall-count denominator that legitimately shrank because solid runs merged; a coordinate that moved; or a real regression. **A real regression stops the task** — do not adjust the expectation.

- [ ] **Step 3: Turn the trace probe into a permanent pin**

The upscale plan deleted `tools/baseline/trace.test.ts` at the end. Keep it instead, and give it an assertion, because CLAUDE.md's own rule is that a behaviour-preserving claim needs a golden trace and `determinism.test.ts` cannot supply one:

```ts
    const hash = h.digest('hex');
    console.log(`BASELINE ${hash}`);
    // A golden trace over 4 arenas x 6 seeds x 2500 ticks. determinism.test.ts asserts
    // self-consistency, which is invariant under behaviour changes -- this is the pin
    // that actually moves when AI or collision behaviour moves. Changing it is a
    // deliberate act: re-record the value and say in the commit WHY it moved.
    expect(hash).toBe('<paste the value printed after Task 3>');
```

- [ ] **Step 4: Confirm it fails when behaviour moves**

Change `SEEK_APPROACH_BIAS` in `constants.ts` by 0.01, run the trace test, watch it FAIL, revert.

- [ ] **Step 5: Full gate**

```bash
npx tsc --noEmit
npx vitest run 2>&1 | grep -E "Tests |Test Files"
npm run build 2>&1 | tail -1
npm run test:gl 2>&1 | grep -E "FAIL|all [0-9]+ GL"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "tests: move the wall-count denominators the merge shrinks, and pin the trace"
```

---

### Task 6: Look at it, then document it

**Files:**
- Modify: `CLAUDE.md`, then `cp CLAUDE.md AGENTS.md`

- [ ] **Step 1: Screenshot all four levels**

Merged walls render as one `BoxGeometry` per rectangle instead of one per cell (`render/entities.ts:568`), and the solid material carries a **normal map** — tiling stretches over a larger box, so this needs eyes, not just a green `test:gl`.

```bash
node /home/dev/.claude/jobs/34bc5380/tmp/shoot.mjs 5231 '?dev=1&level=1&seed=7' /tmp/after-1.png
```

Compare each against the same shot before this branch. Geometry should be unchanged; report any seam or texture-scale difference rather than waving it through.

- [ ] **Step 2: Record what changed, in CLAUDE.md**

```markdown
**Walls load as geometry, not as cells.** `loadArena` merges SOLID cells into maximal
rectangles (`mergeSolidRuns`) and numbers tanks from a counter of their own. Both exist
because three parts of the sim read the wall ARRAY rather than the arena's shape, and
the 3x resolution upscale exposed all three: tank ids shared a counter with walls, so
wall count reseeded every per-tank RNG stream in `ai/targeting.ts`; `resolveWalls`
applied one push per overlapping wall, so a sliced wall pushed several times and its
interior seams offered phantom corners; `bankShot` returns the first reflector in array
order and still does — merging shrinks its exposure without closing it, which is a
known residual.

**Destructible walls are never merged**, and that is a rule, not an oversight. A
destructible cell is a destruction UNIT: mine blasts destroy by world-space radius
(`mines.ts`), so a finer grid means finer breaching. arena-02's centre barrier is
authored as adjacent blocks whose separate destruction is the level's design.

`src/sim/decomposition.test.ts` pins the property directly — the same geometry
expressed at two cell sizes must agree on `resolveWalls`, `lineOfSight` and `bankShot`.
`tools/baseline/trace.test.ts` is a golden trace over 4 arenas x 6 seeds x 2500 ticks
and is now ASSERTED, not merely printed: `determinism.test.ts` only proves
self-consistency, which is invariant under behaviour changes.
```

- [ ] **Step 3: Sync and gate**

```bash
cp CLAUDE.md AGENTS.md && cmp CLAUDE.md AGENTS.md && echo identical
npx vitest run 2>&1 | grep -E "Tests |Test Files"
git add CLAUDE.md AGENTS.md && git commit -m "docs: walls load as geometry, and why destructibles stay per-cell"
```

---

## Self-Review

**Spec coverage.** Mechanism 1 (tank ids) → Task 1. Mechanism 2 (`bankShot`) → reduced by Task 2, pinned by Task 4, explicitly left as a documented residual in Task 6; it is not fully closed and the plan says so rather than implying otherwise. Mechanism 3 (`resolveWalls`) → Task 3. Re-baseline → Task 5. The "is this the complete set?" caveat from the task-5 addendum is answered empirically by Task 4's invariance test rather than by assertion.

**Placeholder scan.** The one deliberate blank is the golden hash in Task 5 Step 3, which cannot be known before Task 3 runs; the step says exactly where it comes from.

**Type consistency.** `mergeSolidRuns(mask, cols, rows)` returns `[c0, r0, c1, r1]` with exclusive upper bounds, used only in Task 2. `resolveWalls(tank, walls): void` keeps its existing signature, so `world.ts:116` and `collision.ts:340` are untouched. `loadArena` keeps `{ walls, tanks, spawns }`.

**Known risk.** Task 3 changes collision for the pre-upscale geometry too — adjacent solid cells exist in every shipped arena (6 orthogonally-adjacent pairs in arena-01), so `collision.test.ts` and `escape.test.ts` are expected to move. That is the task's real cost and Step 4 is written to make it a judgement rather than a sweep.
