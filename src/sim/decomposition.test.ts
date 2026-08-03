import { describe, it, expect } from 'vitest';
import { loadArena } from './arena';
import { resolveWalls } from './collision';
import { lineOfSight, bankShot } from './ai/targeting';
import { makeTank } from './arena';

/** The same geometry at cellSize 2, and re-expressed at cellSize 1. `x` is
 *  destructible and therefore never merged, which is what keeps the two wall
 *  lists genuinely different decompositions.
 *
 *  The destructible cluster keeps a world-space gap of 2 (versus the 1.0 hull
 *  diameter) from BOTH the solid wall and the arena's own outer boundary,
 *  rather than touching either as two earlier drafts of this fixture had it
 *  (first the solid block, then -- after fixing that -- the boundary ring,
 *  which sits one cell outside every grid regardless). Adjacent solid geometry
 *  puts swept points inside the ALREADY-ACCEPTED oscillation regime pinned by
 *  collision.test.ts's "does not escape or NaN in a gap narrower than the
 *  hull": resolveWalls exhausts SWEEP_MAX_ITERATIONS bouncing between two
 *  boxes and lands wherever the (even) budget's parity leaves it, a property
 *  of the iteration count, not of the geometry. A wall-array-order shuffle at
 *  fixed decomposition confirmed that divergence is real but orthogonal to
 *  decomposition -- same answer either order -- but because destructible
 *  splitting changes which boxes get touched on which iteration, coarse and
 *  fine oscillation trajectories disagree too, which failed both earlier
 *  drafts even on correct production code.
 *
 *  A THIRD, distinct residual survived even with every gap real: a hull
 *  CENTRE placed inside a destructible mass diverged between coarse and fine,
 *  even fully isolated from any other wall -- a minimal isolated probe (one
 *  coarse destructible cell vs. its four fine sub-cells, no solid nearby) put
 *  820 of 1600 densely-swept interior points (0.05-unit steps) in disagreement.
 *  The mechanism was `circleVsAABB`'s `inside` branch: a centre inside a box
 *  pushed out through THAT box's nearest face, which for a fine sub-cell was
 *  often a buried internal seam rather than the mass's true outer edge -- the
 *  collision-side twin of the retroreflecting-seam residual this repo already
 *  accepts for rays, and the reason solid cells were merged at all (destructible
 *  cells never merge, so it stayed structurally open there).
 *
 *  It was NOT merely a synthetic-position artifact -- the inside branch was
 *  gameplay-reachable. `world.ts:98-104` documents `separateTanks` (tank-vs-tank
 *  shoving) driving a hull "0.375 units inside a solid block", and
 *  `stepMovement` calls `resolveWalls` immediately after every `separateTanks`
 *  pass (`world.ts:112-118`) -- so a shoved tank's centre could start a
 *  `resolveWalls` call already inside a wall, not just arrive at one from
 *  outside. Reviewer-probed with the real `moveTank`, legal non-overlapping
 *  starts, and the actual 3-pass alternation (4 tanks x 120 ticks): a FLAT
 *  destructible face saw 0 of 300 seeds reach the inside branch and 0 diverge
 *  (this fixture's regime, and the position test below stayed scoped to it on
 *  purpose); a CONCAVE destructible pocket saw 147 of 300 seeds call
 *  `resolveWalls` with a centre already inside the mass, and 168 of 300 seeds
 *  end at decomposition-dependent positions (21 of those with no inside event
 *  at all -- the already-accepted oscillation class above). Both figures were
 *  from a synthetic pocket fixture built to demonstrate reachability, not a
 *  shipped arena -- but `config/data/arenas.json` ships 3x3 destructible
 *  blocks, and a 3x3 block becomes concave the moment a mine blast destroys
 *  one interior cell, which shipped mines do.
 *
 *  CLOSED by Task 5b: `resolveWalls` now checks, before its deepest-overlap
 *  pass, whether the hull's centre sits inside ANY wall's box. If so it marches
 *  box-to-box along the four axes (`unionExitDistance`) to find where the wall
 *  MASS ends -- not the nearest face of whichever single box the centre happens
 *  to be in -- and pushes out along the cheapest axis, ties broken on the push
 *  vector for the same reason the deepest-overlap pass already was. That is a
 *  property of the union, so it reads the same regardless of how the mass was
 *  sliced. `circleVsAABB` itself is untouched (bullets.ts depends on its exact
 *  behaviour), so this is resolveWalls-only. The position test below no longer
 *  excludes interior starts -- it sweeps all 1,024 points, which is the actual
 *  proof this closed the residual rather than moved it. The mutation table for this
 *  work is in the PR description. */
const COARSE = {
  id: 'coarse', cols: 6, rows: 6, cellSize: 2,
  legend: { '#': 'solid' as const, x: 'destructible' as const },
  grid: ['......', '.##...', '......', '...xx.', '...xx.', '......'],
} as never;
const FINE = {
  id: 'fine', cols: 12, rows: 12, cellSize: 1,
  legend: { '#': 'solid' as const, x: 'destructible' as const },
  grid: [
    '............', '............',
    '..####......', '..####......',
    '............', '............',
    '......xxxx..', '......xxxx..',
    '......xxxx..', '......xxxx..',
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

    // The CANONICAL half of the same claim, direct rather than comparative: the fixture's
    // one contiguous 2-cell solid run must merge to exactly ONE rectangle at EITHER cell
    // size, matching mergeSolidRuns's own docstring ("the same region yields the same
    // rectangles whatever cell size expressed it"). This is what "stop merging solid cells
    // (emit one box per cell)" breaks -- LOS/bankShot/resolveWalls all stayed
    // decomposition-invariant for every EXTERIOR point probed under that mutation (measured;
    // (see this PR's description), because headingIntoBox absorbs ray seam-grazes and Task 4's
    // deepest-overlap resolveWalls absorbs circle seam-grazes -- so only a structural count
    // on the wall list itself catches it. Boundary walls (always solid, always 4) are
    // excluded by bounding the search to the interior.
    const interiorSolid = (w: typeof a) =>
      w.filter((x) => x.kind === 'solid' && x.aabb.minX >= 0 && x.aabb.maxX <= 12 && x.aabb.minY >= 0 && x.aabb.maxY <= 12);
    expect(interiorSolid(a).length).toBe(1);
    expect(interiorSolid(b).length).toBe(1);
  });
  const pts: { x: number; y: number }[] = [];
  for (let x = 0.35; x < 12; x += 0.37) for (let y = 0.35; y < 12; y += 0.37) pts.push({ x, y });

  // circleVsAABB's `inside` branch (centre already inside a box) USED to not be
  // decomposition-invariant -- see the fixture comment's third residual. Task 5b closed
  // it in resolveWalls, so the position test below no longer needs to exclude interior
  // starts; `inside` stays in use by the dedicated interior-only regression test further
  // down, which pins the narrower "inside both decompositions" case on its own.
  const inside = (p: { x: number; y: number }, walls: { aabb: { minX: number; minY: number; maxX: number; maxY: number } }[]) =>
    walls.some((w) => p.x >= w.aabb.minX && p.x <= w.aabb.maxX && p.y >= w.aabb.minY && p.y <= w.aabb.maxY);

  it('resolves every hull position identically', () => {
    // Population: all 1,024 swept points -- widened from the 848-of-1024 exterior-only
    // sweep Task 5 shipped with. The 176 previously-excluded points (interior to at least
    // one decomposition) are exactly what Task 5b's inside-the-mass fix makes safe to
    // include; their presence here, passing, is the actual proof that fix worked rather
    // than merely narrowing where the divergence hides.
    expect(pts.length).toBe(1024);
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

  // Population for the two paired (O(n^2)) tests below, LOS and bank shot: every 2nd
  // x-index and every 2nd y-index of the 32x32 grid above (stride 2 on each axis), giving
  // 16 x-values x 16 y-values = 256 points, i.e. 256*256 = 65,536 ordered pairs -- a
  // deliberate 16x thinning (stride 2 on two independent axes composes to 2^4) from the
  // position test's full 1,024-point / 1,048,576-pair sweep, which stays on `pts`
  // unthinned since it is only O(n). Both paired tests were measured timing out under
  // vitest's 5000ms default on CI (15,885ms / 21,452ms there) while passing locally
  // (10,359ms / 23,030ms) -- a runner-dependent result for a synchronous CPU-bound loop,
  // which is a flakiness defect independent of CI simply being slower. Thinning plus the
  // explicit timeout below (`tools/baseline/trace.test.ts` precedent) fixes both: on this
  // machine the thinned population runs in well under a second per test (see the durations
  // recorded in this PR's description).
  const swept: { x: number; y: number }[] = pts.filter((_, i) => Math.floor(i / 32) % 2 === 0 && i % 32 % 2 === 0);

  it('agrees on line of sight for every ordered pair', () => {
    expect(swept.length).toBe(256);
    let blocked = 0;
    for (const m of swept) for (const t of swept) {
      const clear = lineOfSight(m, t, a);
      if (!clear) blocked++;
      expect(lineOfSight(m, t, b), `${m.x},${m.y} -> ${t.x},${t.y}`).toBe(clear);
    }
    // Guard against a vacuous pass: a `lineOfSight` gutted to `return true` unconditionally
    // agrees with itself on both decompositions and this test would stay green. Some pairs
    // in this fixture must actually be blocked for the comparison to mean anything.
    expect(blocked).toBeGreaterThan(0);
  }, 30_000);

  it('agrees on the bank shot for every ordered pair', () => {
    expect(swept.length).toBe(256);
    let nonNull = 0;
    for (const m of swept) for (const t of swept) {
      const x = bankShot(m, t, a, 1);
      const y = bankShot(m, t, b, 1);
      if (x !== null) nonNull++;
      if (x === null || y === null) expect(y, `${m.x},${m.y} -> ${t.x},${t.y}`).toBe(x);
      else expect(y, `${m.x},${m.y} -> ${t.x},${t.y}`).toBeCloseTo(x, 9);
    }
    // Guard against a vacuous pass: `bankShot` gutted to `return null` unconditionally
    // agrees with itself on both decompositions (null === null, every pair) and this test
    // stayed green under that mutation before this guard existed (measured: see the report
    // above). Some pairs in this fixture must actually resolve a real bank shot on both
    // sides for the comparison to mean anything.
    expect(nonNull).toBeGreaterThan(0);
  }, 30_000);

  // The sweep above doesn't reach bankShot's internal selection logic: its destructible
  // cluster is convex and isolated enough that only ONE candidate per face survives
  // raySegmentVsAABB's own bounds check regardless of decomposition, so "first valid" and
  // "shortest valid" coincide there by construction (measured: 0 mismatches over 2.2M
  // swept exterior pairs against three different fixture shapes, including an L-shaped
  // destructible mass, under the first-valid mutation -- (see this PR's description). A flat
  // multi-cell destructible ROW does expose headingIntoBox, but not first-vs-shortest, for
  // the same reason. Two targeted checks below close that gap -- each is the SOLE killer
  // of its mutation (see this PR's description)'s mutation table), so each gets its own `it`
  // with a distinguishing name/label: sharing one block with the ~23s sweep above would
  // both bury an unlabelled failure and let an earlier failure abort the run before these
  // execute at all.

  it('agrees on the bank shot across a destructible row seam (headingIntoBox)', () => {
    // A flat 3-coarse-cell / 6-fine-cell destructible row, muzzle/target symmetric above it
    // so the bounce lands exactly on a seam for interior x values -- mirrors the proven
    // pattern in ai/targeting.test.ts's "returns the same bank shot however the reflector
    // is sliced" (solid there; destructible, which actually differs between COARSE and
    // FINE, here). The grid is generously padded (10x10 / 20x20, not sized to the row) so
    // the boundary ring -- itself one cell thick, hence a DIFFERENT absolute thickness at
    // each cellSize -- sits far enough away that it never becomes a competing bank
    // candidate and confounds the measurement; a tighter grid tried first did exactly that
    // and read as a false negative (0 of 121) for this same mutation.
    const ROW_COARSE = {
      id: 'row-coarse', cols: 10, rows: 10, cellSize: 2,
      legend: { x: 'destructible' as const },
      grid: [
        '..........', '..........', '..........', '..........',
        '..xxx.....', '..........', '..........', '..........',
        '..........', '..........',
      ],
    } as never;
    const ROW_FINE = {
      id: 'row-fine', cols: 20, rows: 20, cellSize: 1,
      legend: { x: 'destructible' as const },
      grid: [
        '....................', '....................', '....................', '....................',
        '....................', '....................', '....................', '....................',
        '....xxxxxx..........', '....xxxxxx..........', '....................', '....................',
        '....................', '....................', '....................', '....................',
        '....................', '....................', '....................', '....................',
      ],
    } as never;
    const rowA = loadArena(ROW_COARSE).walls;
    const rowB = loadArena(ROW_FINE).walls;
    let rowCompared = 0;
    let nonNullA = 0;
    let nonNullB = 0;
    for (let mx = 4.5; mx < 10; mx += 0.5) for (let tx = 4.5; tx < 10; tx += 0.5) {
      const m = { x: mx, y: 6 };
      const t = { x: tx, y: 4 };
      rowCompared++;
      const x = bankShot(m, t, rowA, 1);
      const y = bankShot(m, t, rowB, 1);
      if (x !== null) nonNullA++;
      if (y !== null) nonNullB++;
      if (x === null || y === null) expect(y, `row ${mx}->${tx}`).toBe(x);
      else expect(y, `row ${mx}->${tx}`).toBeCloseTo(x, 9);
    }
    expect(rowCompared).toBe(121); // population: 11 muzzle x 11 target x-positions
    // Guard against a vacuous pass: `x === null && y === null` satisfies the comparison
    // above trivially, so a future fixture edit that made every candidate invalid on both
    // sides would still read green. Today all 121 of 121 pairs resolve a bank shot on
    // both sides.
    expect(nonNullA).toBe(121);
    expect(nonNullB).toBe(121);
  });

  it('resolves a hull whose centre is inside the mass identically', () => {
    const interiorPts = pts.filter((p) => inside(p, a) && inside(p, b));
    // Population pin: 176 of the 1024 swept points -- the exact complement of the 848-point
    // exterior sweep above. `interiorPts` requires inside BOTH decompositions (`&&`), which
    // happens to equal the OR-complement (inside at least one) for this fixture: verified
    // by measuring inside(a)||inside(b) separately, also 176 -- the destructible fine sub-
    // cells partition their coarse cell without changing the union's footprint, so a point
    // is never inside one decomposition's wall without being inside the other's too.
    expect(interiorPts.length).toBe(176);
    for (const p of interiorPts) {
      const ta = makeTank(1, 'player', { ...p }, 0);
      const tb = makeTank(1, 'player', { ...p }, 0);
      resolveWalls(ta, a);
      resolveWalls(tb, b);
      expect(tb.pos.x, `x=${p.x} y=${p.y}`).toBeCloseTo(ta.pos.x, 9);
      expect(tb.pos.y, `x=${p.x} y=${p.y}`).toBeCloseTo(ta.pos.y, 9);
    }
  });

  it('picks the shorter of two non-collinear bank reflectors (first-vs-shortest)', () => {
    // Two NON-collinear reflectors so neither blocks the other's path, listed FAR-then-NEAR
    // so array order and length order disagree. Not a coarse/fine comparison (that pair
    // never diverges here either, per the note above) -- a direct correctness check
    // against the analytically shorter path.
    const far = { id: 101, kind: 'solid' as const, destroyed: false, aabb: { minX: 20, minY: -10, maxX: 21, maxY: 10 } };
    const near = { id: 102, kind: 'solid' as const, destroyed: false, aabb: { minX: -10, minY: 5, maxX: 20, maxY: 6 } };
    const muzzle = { x: 0, y: 0 };
    const target = { x: 3, y: 0 };
    // Mirroring target(3,0) across near's top face (y=5) and intersecting the line from
    // muzzle gives the analytic bounce (1.5, 5); off far's left face (x=20) gives (20, 0).
    // near's round trip (2*sqrt(1.5^2+5^2) ~ 10.44) is far shorter than far's (2*20 = 40).
    const expectedAngle = Math.atan2(5, 1.5);
    expect(bankShot(muzzle, target, [far, near], 1)).toBeCloseTo(expectedAngle, 9);
  });
});
