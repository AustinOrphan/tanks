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
 *  A THIRD, distinct residual survives even with every gap real: a hull
 *  CENTRE placed inside a destructible mass diverges between coarse and fine,
 *  even fully isolated from any other wall -- a minimal isolated probe (one
 *  coarse destructible cell vs. its four fine sub-cells, no solid nearby) put
 *  820 of 1600 densely-swept interior points (0.05-unit steps) in disagreement.
 *  The mechanism is `circleVsAABB`'s `inside` branch: a centre inside a box
 *  pushes out through THAT box's nearest face, which for a fine sub-cell is
 *  often a buried internal seam rather than the mass's true outer edge -- the
 *  collision-side twin of the retroreflecting-seam residual this repo already
 *  accepts for rays, and the reason solid cells are merged at all (destructible
 *  cells never merge, so it is structurally still open there). It is not
 *  gameplay-reachable: resolveWalls only ever sees hulls that arrived by
 *  ~0.05-unit/tick incremental movement, never teleported a hull-radius deep
 *  into a wall, so `moveTank`'s per-tick resolution never enters that branch
 *  from rest. The position test below therefore sweeps only hull centres that
 *  start OUTSIDE every wall in both decompositions -- the exterior,
 *  `circleVsAABB`'s closest-point branch, which is exactly the gameplay-
 *  reachable regime and, empirically, decomposition-invariant. See
 *  task-5-report.md for the full mutation table and both residuals. */
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
    // see task-5-report.md), because headingIntoBox absorbs ray seam-grazes and Task 4's
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

  // circleVsAABB's `inside` branch (centre already inside a box) is not decomposition-
  // invariant -- see the fixture comment's third residual. resolveWalls only ever meets
  // hulls arriving from OUTSIDE a wall (moveTank steps ~0.05 units/tick), so the position
  // test restricts its sweep to centres outside every wall in BOTH decompositions, which
  // is both the gameplay-reachable regime and, empirically, the invariant one.
  const inside = (p: { x: number; y: number }, walls: { aabb: { minX: number; minY: number; maxX: number; maxY: number } }[]) =>
    walls.some((w) => p.x >= w.aabb.minX && p.x <= w.aabb.maxX && p.y >= w.aabb.minY && p.y <= w.aabb.maxY);
  const exteriorPts = pts.filter((p) => !inside(p, a) && !inside(p, b));

  it('resolves every hull position identically', () => {
    // Population: 848 of the 1024 swept points (176 excluded as starting inside a wall
    // in one decomposition or the other).
    expect(exteriorPts.length).toBe(848);
    let moved = 0;
    for (const p of exteriorPts) {
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

    // Neither of the two checks above reaches bankShot's internal selection logic: the main
    // sweep's destructible cluster is convex and isolated enough that only ONE candidate
    // per face survives raySegmentVsAABB's own bounds check regardless of decomposition, so
    // "first valid" and "shortest valid" coincide there by construction (measured: 0
    // mismatches over 2.2M swept exterior pairs against three different fixture shapes,
    // including an L-shaped destructible mass, under the first-valid mutation -- see
    // task-5-report.md). A flat multi-cell destructible ROW does expose headingIntoBox
    // (below), but not first-vs-shortest, for the same reason. Two targeted checks close
    // that gap.

    // (1) headingIntoBox: a flat 3-coarse-cell / 6-fine-cell destructible row, muzzle/target
    // symmetric above it so the bounce lands exactly on a seam for interior x values --
    // mirrors the proven pattern in ai/targeting.test.ts's "returns the same bank shot
    // however the reflector is sliced" (solid there; destructible, which actually differs
    // between COARSE and FINE, here). The grid is generously padded (10x10 / 20x20, not
    // sized to the row) so the boundary ring -- itself one cell thick, hence a DIFFERENT
    // absolute thickness at each cellSize -- sits far enough away that it never becomes a
    // competing bank candidate and confounds the measurement; a tighter grid tried first
    // did exactly that and read as a false negative (0 of 121) for this same mutation.
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
    for (let mx = 4.5; mx < 10; mx += 0.5) for (let tx = 4.5; tx < 10; tx += 0.5) {
      const m = { x: mx, y: 6 };
      const t = { x: tx, y: 4 };
      rowCompared++;
      const x = bankShot(m, t, rowA, 1);
      const y = bankShot(m, t, rowB, 1);
      if (x === null || y === null) expect(y, `row ${mx}->${tx}`).toBe(x);
      else expect(y, `row ${mx}->${tx}`).toBeCloseTo(x, 9);
    }
    expect(rowCompared).toBe(121); // population: 11 muzzle x 11 target x-positions

    // (2) first-vs-shortest: two NON-collinear reflectors so neither blocks the other's
    // path, listed FAR-then-NEAR so array order and length order disagree. Not a
    // coarse/fine comparison (that pair never diverges here either, per the note above) --
    // a direct correctness check against the analytically shorter path.
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
