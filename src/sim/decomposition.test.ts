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
  grid: ['......', '.#....', '......', '...xx.', '...xx.', '......'],
} as never;
const FINE = {
  id: 'fine', cols: 12, rows: 12, cellSize: 1,
  legend: { '#': 'solid' as const, x: 'destructible' as const },
  grid: [
    '............', '............',
    '..##........', '..##........',
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
    // Population: 878 of the 1024 swept points (146 excluded as starting inside a wall
    // in one decomposition or the other).
    expect(exteriorPts.length).toBe(878);
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
  });
});
