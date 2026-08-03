# Walls as Geometry, Not Cells — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sim's answers depend on the arena's geometry rather than on how that geometry happens to be sliced into grid cells, so a resolution change is a data edit and not a behaviour change.

**Architecture:** Three independent defects found in the Task 5 investigation of `2026-08-02-arena-resolution-upscale.md` (see `.superpowers/sdd/2026-08-02-arena-resolution-upscale/task-5-report-addendum.md` for the evidence). Tank ids are drawn from a counter shared with walls, so wall count reseeds every per-tank RNG stream; `resolveWalls` applies one push per overlapping wall, so a subdivided wall pushes several times and its interior seams present phantom corners; `bankShot` returns the first reflector in array order. Fixed by numbering tanks independently of walls, merging **solid** walls into maximal rectangles at load, choosing the shortest bank path off a face that is not buried, and resolving collisions against the deepest single overlap iteratively. All three mechanisms are closed, not reduced.

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
- `src/sim/ai/targeting.ts` — `bankShot` selects by path length instead of array position, and `losIgnoring` gains a `headingIntoBox` graze probe. Its callers (`brown.ts`, `teal.ts`, `arena-claims.ts`) are unchanged.
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

`cell-mapping.test.ts` and any wall-count pin will fail; those move in Task 6. Note the failures, do not fix them yet.

- [ ] **Step 5: Prove the destructible guard can fail**

Delete `!== 'destructible'` from PASS 2b's filter so destructibles merge too, re-run `-t 'never merges destructible'`, watch it FAIL, revert. A guard nobody has seen fail is not a guard.

- [ ] **Step 6: Record the hash and commit**

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
git add src/sim/arena.ts src/sim/arena.test.ts
git commit -m "sim: solid walls load as maximal rectangles, not one box per cell"
```

---

### Task 3: `bankShot` picks a canonical reflector, not the first in the array

**Files:**
- Modify: `src/sim/ai/targeting.ts` (`bankShot`, ~line 241)
- Test: `src/sim/ai/targeting.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `bankShot(muzzle: Vec2, target: Vec2, walls: Wall[], maxBounces: number): number | null` — signature unchanged. It now returns the SHORTEST valid bank path rather than the first found, and rejects bounces on buried faces. Callers (`brown.ts`, `teal.ts`, `arena-claims.ts`'s `structuralFailures`) are unchanged.

Merging (Task 2) removes interior seams inside solid runs but not between destructible cells — arena-02's centre barrier is 72 destructible cells — so the array-order dependence has to be closed in the function itself.

- [ ] **Step 1: Write the failing test**

```ts
it('returns the same bank shot however the reflector is sliced', () => {
  const one: Wall[] = [
    { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 6, maxY: 2 } },
  ];
  const three: Wall[] = [0, 2, 4].map((x, i) => ({
    id: i + 1, kind: 'solid' as const, destroyed: false,
    aabb: { minX: x, minY: 0, maxX: x + 2, maxY: 2 },
  }));
  let compared = 0;
  for (let mx = 0.5; mx < 6; mx += 0.5) {
    for (let tx = 0.5; tx < 6; tx += 0.5) {
      const m = { x: mx, y: 4 };
      const t = { x: tx, y: 6 };
      const a = bankShot(m, t, one, 1);
      const b = bankShot(m, t, three, 1);
      compared++;
      if (a === null || b === null) expect(b, `${mx}->${tx}`).toBe(a);
      else expect(b, `${mx}->${tx}`).toBeCloseTo(a, 9);
    }
  }
  expect(compared).toBe(121); // population: 11 muzzle x 11 target positions
});

it('never reflects off a face buried inside a neighbouring wall', () => {
  // Two abutting boxes. The shared plane at x=2 is interior: nothing can bounce off it.
  const walls: Wall[] = [
    { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 2, maxY: 2 } },
    { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 2, minY: 0, maxX: 4, maxY: 2 } },
  ];
  const merged: Wall[] = [
    { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 4, maxY: 2 } },
  ];
  for (let mx = 0.25; mx < 4; mx += 0.25) {
    const m = { x: mx, y: 3 };
    const t = { x: 4 - mx, y: 3.5 };
    const a = bankShot(m, t, merged, 1);
    const b = bankShot(m, t, walls, 1);
    if (a === null || b === null) expect(b, `mx=${mx}`).toBe(a);
    else expect(b, `mx=${mx}`).toBeCloseTo(a, 9);
  }
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/sim/ai/targeting.test.ts -t 'however the reflector is sliced'
```

Expected: FAIL. On the current code the three-box array offers interior seam faces at x=2 and x=4 as reflectors and returns whichever comes first.

- [ ] **Step 3: Rewrite the selection**

In `src/sim/ai/targeting.ts`, add `SWEEP_EPS` to the existing `../constants` import, then add above `bankShot`:

```ts
/**
 * True if `point` lies on a face that is buried inside another wall — i.e. not a
 * surface at all. Subdividing a wall manufactures one of these at every interior seam,
 * which is how the level data's SLICING used to reach the AI's aim.
 *
 * Containment is tested with STRICT inequalities on purpose. A bounce point at a
 * concave corner sits exactly on the abutting wall's boundary, and a `<=` test would
 * call that legitimate surface buried and refuse a real shot -- the failure mode that
 * got the equivalent fix reverted in reflectSweep (see CLAUDE.md).
 */
function faceIsBuried(point: Vec2, normal: Vec2, walls: Wall[], self: Wall): boolean {
  const p = { x: point.x + normal.x * SWEEP_EPS, y: point.y + normal.y * SWEEP_EPS };
  for (const w of walls) {
    if (w === self || w.destroyed) continue;
    const b = w.aabb;
    if (p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY) return true;
  }
  return false;
}
```

Then replace `bankShot`'s loop body's `return` with a shortest-path selection. The doc comment's "returns the FIRST valid path in wall/face iteration order" paragraph must be rewritten, not left stale:

```ts
export function bankShot(muzzle: Vec2, target: Vec2, walls: Wall[], maxBounces: number): number | null {
  if (maxBounces < 1) return null;
  let bestAngle: number | null = null;
  let bestLength = Infinity;
  for (const w of walls) {
    if (w.destroyed) continue;
    const mirrors = mirrorAcrossAABB(target, w.aabb);
    for (let face = 0; face < FACE_NORMALS.length; face++) {
      const mirror = mirrors[face];
      const hit = raySegmentVsAABB(muzzle, mirror, w.aabb);
      if (!hit) continue;
      const n = FACE_NORMALS[face];
      if (hit.normal.x !== n.x || hit.normal.y !== n.y) continue;
      const bounce = hit.point;
      if (faceIsBuried(bounce, n, walls, w)) continue;
      if (!losIgnoring(muzzle, bounce, walls, w)) continue;
      if (!losIgnoring(bounce, target, walls, w)) continue;
      if (pointSegmentDistance(muzzle, bounce, target) < AI_HULL_CLEARANCE) continue;
      // Chosen by PATH LENGTH, not array position. The shortest bank is the fastest
      // shell to arrive, and -- unlike "first valid" -- it is a property of the arena's
      // geometry rather than of how that geometry was sliced into cells. Exact ties are
      // real in symmetric arenas, so they break on the ANGLE, which is geometric too.
      const length = vdist(muzzle, bounce) + vdist(bounce, target);
      const angle = angleOf(vsub(bounce, muzzle));
      const better =
        length < bestLength - AIM_EPS ||
        (Math.abs(length - bestLength) <= AIM_EPS && bestAngle !== null && angle < bestAngle);
      if (better || bestAngle === null) {
        bestLength = Math.min(length, bestLength);
        bestAngle = angle;
      }
    }
  }
  return bestAngle;
}
```

- [ ] **Step 4: Run both new tests, then the AI suite**

```bash
npx vitest run src/sim/ai/ 2>&1 | grep -E "Tests |×"
```

`teal.test.ts`, `brown.test.ts` and `arena-validation.test.ts`'s bank-sightline rule may move — `structuralFailures` forbids a stationary banker a ricochet onto the player spawn, and a shorter chosen path can change which spawns are reachable. Any arena that now FAILS that rule is a real finding about the level, not a test to relax: report it and stop.

- [ ] **Step 5: Prove each guard can fail**

Delete the `faceIsBuried` call, run `-t 'never reflects off a face buried'`, watch it FAIL, restore. Then change the selection back to returning on the first valid candidate, run `-t 'however the reflector is sliced'`, watch it FAIL, restore.

- [ ] **Step 6: Check the cost**

`bankShot` no longer early-returns, so it now scans every wall on every call. Time the AI-heaviest test before and after:

```bash
npx vitest run src/sim/step-integration.test.ts --reporter=basic 2>&1 | grep -E "step-integration|Duration"
```

If it has more than doubled, say so in the commit body — the merge in Task 2 cut arena-01 from 121 walls to 27, which is what makes the full scan affordable.

- [ ] **Step 7: Record the hash and commit**

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
git add src/sim/ai/targeting.ts src/sim/ai/targeting.test.ts
git commit -m "ai: bank shots pick the shortest path, and never off a buried face"
```

---

### Task 4: `resolveWalls` resolves against the deepest overlap, iteratively

**Files:**
- Modify: `src/sim/collision.ts:297`
- Test: `src/sim/collision.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
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

### Task 5: The invariance property, as a shipping test

**Files:**
- Create: `src/sim/decomposition.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: nothing other tasks read.

This is the test that would have caught all three defects before the upscale, and the reason the plan is worth doing. It asserts the property directly: **the same geometry, sliced two ways, must give the same answers.**

**The fixture MUST include destructible cells, and this is the whole subtlety of the task.** Task 2 merges solid cells into maximal rectangles, so a solid-only fixture expressed at two cell sizes loads into the *same* AABBs — the test would compare a wall list against itself and pass no matter what the production code did. Destructible cells are never merged, so they are the one family whose decomposition genuinely still differs between resolutions: one 2x2 box at `cellSize` 2 becomes four 1x1 boxes covering the same region at `cellSize` 1. That residual difference is exactly what the shipped game carries, and exactly what this test must guard.

Step 1 therefore opens with a **non-vacuity assertion**: the two wall lists must not be identical. If that assertion ever starts failing, the fixture has stopped testing anything and the rest of the file is decoration.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { loadArena } from './arena';
import { resolveWalls } from './collision';
import { lineOfSight, bankShot } from './ai/targeting';
import { makeTank } from './arena';

/** The same geometry at cellSize 2, and re-expressed at cellSize 1. `x` is
 *  destructible and therefore never merged, which is what keeps the two wall
 *  lists genuinely different decompositions of one region. */
const COARSE = {
  id: 'coarse', cols: 6, rows: 6, cellSize: 2,
  legend: { '#': 'solid' as const, x: 'destructible' as const },
  grid: ['......', '.###..', '.#x...', '.#....', '..xx..', '......'],
} as never;
const FINE = {
  id: 'fine', cols: 12, rows: 12, cellSize: 1,
  legend: { '#': 'solid' as const, x: 'destructible' as const },
  grid: [
    '............', '............',
    '..######....', '..######....',
    '..##xx......', '..##xx......',
    '..##........', '..##........',
    '....xxxx....', '....xxxx....',
    '............', '............',
  ],
} as never;

describe('the sim reads geometry, not the grid that expressed it', () => {
  const a = loadArena(COARSE).walls;
  const b = loadArena(FINE).walls;

  it('is not comparing a wall list against itself', () => {
    // THE guard that keeps the rest of this file meaningful. Solid runs merge to the
    // same rectangles at any cell size; only the unmerged destructible cells make these
    // two lists genuinely different decompositions. If this ever fails, the fixture has
    // stopped testing anything.
    const shape = (w: { aabb: { minX: number; minY: number; maxX: number; maxY: number } }[]) =>
      w.map((x) => `${x.aabb.minX},${x.aabb.minY},${x.aabb.maxX},${x.aabb.maxY}`).sort().join('|');
    expect(a.length).not.toBe(b.length);
    expect(shape(a)).not.toBe(shape(b));
  });
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

Expected: PASS on all three, including the bank shot — Task 3 closed that mechanism, and this is the independent check on it. **Do not weaken an assertion or mark a test `it.fails` to get green.** A failure here means a mechanism is still open: report it with the failing case and stop, because Task 6's re-baseline would otherwise enshrine the defect in the golden hash.

- [ ] **Step 3: Prove each assertion can fail**

Revert `resolveWalls` to the old every-wall loop, run, watch the first test FAIL, restore. Then disable the solid merge in `arena.ts`, run, watch it FAIL again, restore.

- [ ] **Step 4: Commit**

```bash
git add src/sim/decomposition.test.ts
git commit -m "test: the same geometry sliced two ways must give the same answers"
```

---

### Task 5b: a hull INSIDE a wall escapes the mass, not the sub-cell

**Files:**
- Modify: `src/sim/collision.ts` (`resolveWalls`)
- Test: `src/sim/collision.test.ts`, `src/sim/decomposition.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `resolveWalls(tank, walls): void` — signature unchanged, callers unchanged. `circleVsAABB` is **not** modified (bullets.ts uses it; changing it would ripple).

**Why this exists.** Task 4 fixed the case where a hull *touches* walls — measured 8,846 → 0 divergences on arena-01. The case where the hull's CENTRE is already inside wall geometry is still decomposition-dependent, because `circleVsAABB`'s `inside` branch pushes out through the nearest face of the ONE box it is handed, and for a sub-cell that face is often a buried internal seam rather than the mass's outer edge. Task 5 measured 820 of 1,600 densely-swept interior points diverging for an isolated destructible mass, and the review showed it is reachable: `separateTanks` (`world.ts:99`) drives hulls up to 0.375 units into a block and `stepMovement` calls `resolveWalls` immediately after — 147 of 300 seeds reached it on a concave pocket, 0 of 300 on a flat face. Destructible cells cannot be merged (a destructible cell is a destruction unit), so this must be fixed in the resolver.

- [ ] **Step 1: Write the failing test**

In `src/sim/decomposition.test.ts`, add a test that sweeps hull centres INSIDE the destructible mass and asserts coarse and fine agree. Use the same `COARSE`/`FINE` fixtures already in the file, and sweep the interior points the existing position test excludes:

```ts
  it('resolves a hull whose centre is inside the mass identically', () => {
    const interiorPts = pts.filter((p) => inside(p, a) && inside(p, b));
    // Population pin: the complement of the exterior sweep, same 1024-point grid.
    expect(interiorPts.length).toBeGreaterThan(20);
    for (const p of interiorPts) {
      const ta = makeTank(1, 'player', { ...p }, 0);
      const tb = makeTank(1, 'player', { ...p }, 0);
      resolveWalls(ta, a);
      resolveWalls(tb, b);
      expect(tb.pos.x, `x=${p.x} y=${p.y}`).toBeCloseTo(ta.pos.x, 9);
      expect(tb.pos.y, `x=${p.x} y=${p.y}`).toBeCloseTo(ta.pos.y, 9);
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/sim/decomposition.test.ts -t 'inside the mass'
```

Expected: FAIL. Record the first diverging point and both resolved positions.

- [ ] **Step 3: Escape the union, not the box**

In `resolveWalls`, handle the inside case BEFORE the deepest-overlap pass. The distance to leave the wall mass along each axis direction is a property of the union, so marching box-to-box along the ray gives the same answer at any cell size:

```ts
const AXES: Vec2[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

function containsPoint(b: AABB, p: Vec2): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/** How far from `p` along `dir` until the wall MASS ends. Marches box to box, so a run
 *  of sub-cells gives the same answer as the single box covering the same span. */
function unionExitDistance(p: Vec2, dir: Vec2, walls: Wall[]): number {
  let dist = 0;
  for (let step = 0; step <= walls.length; step++) {
    const probe = { x: p.x + dir.x * (dist + SWEEP_EPS), y: p.y + dir.y * (dist + SWEEP_EPS) };
    const w = walls.find((x) => !x.destroyed && containsPoint(x.aabb, probe));
    if (!w) return dist;
    dist = dir.x === 1 ? w.aabb.maxX - p.x
      : dir.x === -1 ? p.x - w.aabb.minX
      : dir.y === 1 ? w.aabb.maxY - p.y
      : p.y - w.aabb.minY;
  }
  return dist;
}
```

Then, at the top of each iteration of `resolveWalls`'s loop:

```ts
    // A centre INSIDE the mass escapes the mass. circleVsAABB's `inside` branch pushes
    // out through the nearest face of the one box it is given, which for a sub-cell is
    // usually a buried seam -- so the same hull in the same place resolved differently
    // depending only on how the wall was sliced. Ties break on the push VECTOR, never
    // on array or axis position, for the same reason the deepest-overlap pass does.
    if (walls.some((w) => !w.destroyed && containsPoint(w.aabb, tank.pos))) {
      let escape: Vec2 | null = null;
      let escapeDist = Infinity;
      for (const dir of AXES) {
        const d = unionExitDistance(tank.pos, dir, walls);
        const cand = { x: dir.x * (d + TANK_RADIUS), y: dir.y * (d + TANK_RADIUS) };
        if (d < escapeDist || (d === escapeDist && escape !== null &&
            (cand.x < escape.x || (cand.x === escape.x && cand.y < escape.y)))) {
          escapeDist = d;
          escape = cand;
        }
      }
      if (escape !== null) { tank.pos = vadd(tank.pos, escape); continue; }
    }
```

- [ ] **Step 4: Run the new test, then the whole suite**

```bash
npx vitest run src/sim/decomposition.test.ts   # the new test must PASS
npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |Test Files"
```

`collision.test.ts`'s narrow-gap and concave-corner tests are the ones most likely to move. Judge each: does the old expectation encode the old per-box behaviour, or did you break something real? Do not blanket-update.

- [ ] **Step 5: Prove it can fail, and that the single-box case is untouched**

Delete the whole inside-case block, re-run `-t 'inside the mass'`, watch it FAIL, restore. Then confirm a hull inside a SINGLE box resolves exactly as before by adding a direct test with one wall and an analytically-known exit.

- [ ] **Step 6: Drop Task 5's interior exclusion, which is now the real proof**

The position test restricts its sweep to exterior centres and the fixture comment explains why. That restriction is now unnecessary. Widen the sweep to all 1,024 points, update the population pin, and rewrite the fixture comment's third-residual paragraph to say it was CLOSED here and how.

- [ ] **Step 7: Record the hash and commit**

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
git add -A && git commit -m "sim: a hull inside a wall escapes the mass, not the sub-cell it sits in"
```

---

### Task 6: Move the pins that legitimately move, and re-baseline

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
    expect(hash).toBe('<paste the value printed after Task 4>');
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

### Task 7: Look at it, then document it

**Files:**
- Modify: `CLAUDE.md`, then `cp CLAUDE.md AGENTS.md`

- [ ] **Step 1: Screenshot all four levels**

Merged walls render as one `BoxGeometry` per rectangle instead of one per cell (`render/entities.ts:568`), and the solid material carries a **normal map** — tiling stretches over a larger box, so this needs eyes, not just a green `test:gl`.

```bash
node /home/dev/.claude/jobs/17681316/tmp/shoot.mjs 5231 '?dev=1&level=1&seed=7' /tmp/after-1.png
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
interior seams offered phantom corners; and `bankShot` chose the first reflector in
wall-array order.

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

An explicit `faceIsBuried` guard was written first and then DELETED, because with the
graze fix in place it changed nothing: 0 differences across 1,374,336 probes over
T-junctions, partial overlaps, nested boxes, staircases, L-shapes and 300 randomised
configurations, plus 0 buried candidates surviving `losIgnoring` in 776,160 probes of
the shipped arenas. If a face is buried, the neighbour occupies the space outside it, so
any ray reaching that face is already a real penetration of the neighbour. Do not
re-add the guard without a fixture that fails when it is removed.

**Destructible walls are never merged**, and that is a rule, not an oversight. A
destructible cell is a destruction UNIT: mine blasts destroy by world-space radius
(`mines.ts`), so a finer grid means finer breaching. arena-02's centre barrier is
authored as adjacent blocks whose separate destruction is the level's design.

**A hull INSIDE a wall escapes the mass, not the sub-cell.** `circleVsAABB`'s `inside`
branch pushes out through the nearest face of the ONE box it is handed, which for a
sub-cell is usually a buried internal seam — so the same hull in the same place resolved
differently depending only on the slicing (measured: 780 of 1,681 interior centres on an
isolated destructible mass). `resolveWalls` now marches box to box along each axis to
find where the wall MASS ends, which is a property of the union. `circleVsAABB` itself is
untouched, because `bullets.ts` depends on it. This was reachable, not theoretical:
`separateTanks` drives hulls up to 0.375 units into a block and `stepMovement` calls
`resolveWalls` immediately afterwards.

`src/sim/decomposition.test.ts` pins the property directly — the same geometry
expressed at two cell sizes must agree on `resolveWalls`, `lineOfSight` and `bankShot`.
`tools/baseline/trace.test.ts` is a golden trace over 4 arenas x 6 seeds x 2500 ticks
and is now ASSERTED, not merely printed: `determinism.test.ts` only proves
self-consistency, which is invariant under behaviour changes. **Know what it does not
cover.** Across this work the hash moved for the tank-id and wall-merge changes and for
the deepest-overlap resolver, but did NOT move for the bank-shot rewrite or the
inside-wall escape — the seeded replay never drives a hull inside a wall and never
depends on which reflector was chosen. It is a pin on arena and movement behaviour; the
decomposition guarantees are held by `decomposition.test.ts`, not by this hash.
```

- [ ] **Step 3: Sync and gate**

```bash
cp CLAUDE.md AGENTS.md && cmp CLAUDE.md AGENTS.md && echo identical
npx vitest run 2>&1 | grep -E "Tests |Test Files"
git add CLAUDE.md AGENTS.md && git commit -m "docs: walls load as geometry, and why destructibles stay per-cell"
```

---

## Self-Review

**Spec coverage.** Mechanism 1 (tank ids) → Task 1. Mechanism 2 (`bankShot`) → exposure reduced by Task 2 and closed by Task 3. Mechanism 3 (`resolveWalls`) → Task 4. All three are pinned by Task 5's invariance test, which is also the empirical answer to the task-5 addendum's "is this the complete set?" caveat — it asserts the property rather than enumerating causes. Re-baseline → Task 6. Documentation → Task 7.

**Placeholder scan.** The one deliberate blank is the golden hash in Task 6 Step 3, which cannot be known before Task 4 runs; the step says exactly where it comes from.

**Type consistency.** `mergeSolidRuns(mask, cols, rows)` returns `[c0, r0, c1, r1]` with exclusive upper bounds, used only in Task 2. `headingIntoBox(start, target, box): boolean` is used only inside `losIgnoring` (Task 3), which in turn has only `bankShot` as a caller. `bankShot` and `resolveWalls` both keep their existing signatures, so every caller is untouched. `loadArena` keeps `{ walls, tanks, spawns }`.

**Known risks, in the order they will bite.**

1. **Task 3 can fail an arena's bank-spawn rule.** `structuralFailures` forbids a stationary banker a ricochet onto the player spawn; picking the shortest path instead of the first can change which spawns are reachable. Step 4 says to stop and report rather than relax the rule, because that would be a real finding about a shipped level.
2. **Task 4 changes collision for the pre-upscale geometry too** — every shipped arena has adjacent solid cells (6 orthogonally-adjacent pairs in arena-01) — so `collision.test.ts` and `escape.test.ts` are expected to move. Step 4 is written to make each one a judgement rather than a sweep.
3. **`bankShot` loses its early return** (Task 3) and `resolveWalls` gains a loop (Task 4), both in per-tick AI paths. Task 3 Step 6 times it. Task 2's merge is what pays for this: arena-01 drops from 121 walls to 27.
4. **The trace hash moves four times** (Tasks 1, 2, 3, 4). Each task records its own value, so a later surprise can be bisected to the task that caused it.
