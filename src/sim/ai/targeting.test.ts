import { describe, it, expect } from 'vitest';
import { lineOfSight, aimLead, mirrorAcrossAABB, bankShot, wanderMove, aimJitter, shotHitsOwnSide, friendlyInMineBlast } from './targeting';
import { AI_AIM_SPREAD, AI_JITTER_TICKS, TANK_RADIUS, BULLET_RADIUS, AI_HULL_CLEARANCE, AI_MINE_FLEE_RADIUS } from '../constants';
import { raySegmentVsAABB } from '../collision';
import type { Tank, Wall, Vec2 } from '../types';
import { nextRng } from '../types';
import type { World } from '../world';

function wall(id: number, minX: number, minY: number, maxX: number, maxY: number,
             kind: 'solid' | 'destructible' = 'solid', destroyed = false): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind, destroyed };
}

// Hand-written geometry helpers for the bank-shot self-hit property test below. Written
// out here rather than imported so the test derives its expectation independently of the
// production code it is validating.
function distPointSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
function firstWallHit(from: Vec2, to: Vec2, walls: Wall[]) {
  let best: { t: number; point: Vec2 } | null = null;
  for (const w of walls) {
    if (w.destroyed) continue;
    const h = raySegmentVsAABB(from, to, w.aabb);
    if (h !== null && (best === null || h.t < best.t)) best = h;
  }
  return best;
}

// Minimal fixtures for wanderMove — targeting.test.ts has no shared tank/world
// helpers (danger.test.ts and grey.test.ts each define their own).
function wanderTank(id: number): Tank {
  return {
    id, kind: 'grey', pos: { x: 0, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}
function wanderWorld(seed: number, tick: number): World {
  return {
    tick, nextId: 100, seed, tanks: [], bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none' as const,
  };
}

describe('lineOfSight', () => {
  it('is blocked by a solid wall between the two points', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(false);
  });

  it('is clear through a gap between walls', () => {
    const walls = [wall(1, 1.5, 1, 2.5, 3), wall(2, 1.5, -3, 2.5, -1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });

  it('is clear once the blocking wall is destroyed', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1, 'destructible', true)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });
});

describe('aimLead', () => {
  it('aims directly at a stationary target', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 0 }, 6);
    expect(angle).toBeCloseTo(0, 6);
  });

  it('leads a crossing target ahead of its current position', () => {
    // target at (5,0) moving +y at 3, bullet speed 6.
    // a = 9-36 = -27, b = 0, c = 25, D = 2700, t = sqrt(2700)/54 = 0.96225...
    // intercept = (5, 2.88675) -> angle = atan2(2.88675, 5) = pi/6 exactly.
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 3 }, 6);
    expect(angle).toBeCloseTo(Math.PI / 6, 9);
  });

  it('returns a sane direct-aim angle when no intercept exists (target faster than bullet)', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 100, y: 0 }, 6);
    expect(Number.isNaN(angle)).toBe(false);
    expect(angle).toBeCloseTo(0, 6); // falls back to direct aim
  });

  it('selects the earlier (Math.min) root when both quadratic roots are positive', () => {
    // Head-on closing target: rel=(5,0), v=(-10,0), s=6.
    // a = 100-36 = 64, b = 2*(5*-10) = -100, c = 25.
    // D = 10000-6400 = 3600, sqrt(D) = 60.
    // t1 = (100+60)/128 = 1.25, t2 = (100-60)/128 = 0.3125 -> both positive, pick min = t2.
    // intercept = (5 + -10*0.3125, 0) = (1.875, 0) -> angle = 0.
    // (The rejected root t1 gives intercept (-7.5, 0) -> angle = pi, so this
    // assertion alone already distinguishes correct vs. incorrect root choice.)
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: -10, y: 0 }, 6);
    expect(angle).toBeCloseTo(0, 9);
  });

  it('selects the earlier root with a case where the two roots differ in angle', () => {
    // rel=(5,0), v=(-10,3), s=6.
    // a = (100+9)-36 = 73, b = 2*(5*-10) = -100, c = 25.
    // D = 10000 - 4*73*25 = 2700, sqrt(D) = 30*sqrt(3).
    // t1 = (100+30*sqrt(3))/146 = 1.04083..., t2 = (100-30*sqrt(3))/146 = 0.32903...
    // both positive -> pick min = t2.
    // intercept = (5-10*t2, 3*t2) = (-7/6 * ... ) -> exactly (x = y*sqrt(3)),
    // so angle = atan2(y, x) = pi/6 exactly (verified numerically: 0.5235987755982988).
    // The rejected root t1 gives intercept angle ~2.618 (150 degrees), so this
    // pins root selection via the angle itself.
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: -10, y: 3 }, 6);
    expect(angle).toBeCloseTo(Math.PI / 6, 9);
  });

  it('uses the linear (|a| < AIM_EPS) branch when target speed equals bullet speed', () => {
    // rel=(3,4), v=(-5,0), s=5 -> |v| = s = 5 so a = 25-25 = 0 (degenerate quadratic).
    // b = 2*(3*-5 + 4*0) = -30 (< 0, so t = -c/b is positive), c = 3^2+4^2 = 25.
    // t = -25/-30 = 5/6.
    // intercept = (3 + -5*5/6, 4 + 0) = (-7/6, 4) -> angle = atan2(4, -7/6)
    // = atan2(24, -7) = 1.8545904360032246 (not the fallback angleOf(rel),
    // which would be atan2(4,3) = 0.9272952180016122 -- distinct, so this
    // pins the linear branch actually running rather than falling back).
    const angle = aimLead({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: -5, y: 0 }, 5);
    expect(angle).toBeCloseTo(1.8545904360032246, 9);
  });

  it('aims directly (angle 0, not NaN) when the target is exactly at the muzzle', () => {
    const angle = aimLead({ x: 2, y: -1 }, { x: 2, y: -1 }, { x: 0, y: 0 }, 6);
    expect(Number.isNaN(angle)).toBe(false);
    expect(angle).toBe(0);
  });
});

describe('mirrorAcrossAABB', () => {
  it('reflects a point across all four face planes (left,right,bottom,top)', () => {
    const box = { minX: 1.5, minY: 2, maxX: 2.5, maxY: 3 };
    const [left, right, bottom, top] = mirrorAcrossAABB({ x: 4, y: 0 }, box);
    expect(left).toEqual({ x: 2 * 1.5 - 4, y: 0 });   // x = minX plane -> (-1, 0)
    expect(right).toEqual({ x: 2 * 2.5 - 4, y: 0 });  // x = maxX plane -> (1, 0)
    expect(bottom).toEqual({ x: 4, y: 2 * 2 - 0 });   // y = minY plane -> (4, 4)
    expect(top).toEqual({ x: 4, y: 2 * 3 - 0 });      // y = maxY plane -> (4, 6)
  });
});

describe('bankShot', () => {
  it('finds a valid single-bounce path off a side wall around a blocker', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);            // blocks the direct line (0,0)->(4,0)
    const topWall = wall(2, -5, 2, 10, 3);               // bounce surface: bottom face y=2
    const walls = [blocker, topWall];
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, walls, 3);
    expect(angle).not.toBeNull();
    // bounce point is (2,2) -> firing angle = atan2(2,2) = pi/4
    expect(angle as number).toBeCloseTo(Math.PI / 4, 6);
  });

  it('returns null when the target has no valid bank path (only the blocker exists)', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, [blocker], 3);
    expect(angle).toBeNull();
  });

  it('reflected direction across the chosen face points at the real target', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);
    const topWall = wall(2, -5, 2, 10, 3);
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, [blocker, topWall], 3) as number;
    // The shot travels (0,0)->(2,2); reflecting velocity across the horizontal face flips y:
    // dir (1,1) becomes (1,-1); from (2,2) that reaches (4,0) = the target.
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const reflected = { x: dir.x, y: -dir.y };
    // Physical claim: leaving the bounce point (2,2), the reflected direction
    // points straight at the real target (4,0) — collinear AND same-facing.
    const d = { x: 4 - 2, y: 0 - 2 };
    expect(reflected.x * d.y - reflected.y * d.x).toBeCloseTo(0, 6); // cross == 0 -> collinear
    expect(reflected.x * d.x + reflected.y * d.y).toBeGreaterThan(0); // dot > 0 -> toward, not away
  });

  it('returns null when the reflector wall is destroyed', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);
    const destroyedReflector = wall(2, -5, 2, 10, 3, 'destructible', true);
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, [blocker, destroyedReflector], 3);
    expect(angle).toBeNull();
  });

  it('returns null when maxBounces < 1', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);
    const topWall = wall(2, -5, 2, 10, 3);
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, [blocker, topWall], 0);
    expect(angle).toBeNull();
  });

  // ---- Self-hit rejection. resolveBulletHits (bullets.ts) makes a shell lethal to its
  // OWNER the moment vdot(vel, ownerPos - bulletPos) > 0, i.e. as soon as it heads back.
  // A bank path whose reflected leg passes through the muzzle is therefore a self-kill,
  // and both legs being wall-clear says nothing about that. ----

  it('rejects a bank path whose reflected leg travels back through the shooter', () => {
    // One wall directly BELOW the muzzle. Mirroring the target (4.4,9) across that wall's
    // TOP face (y = -1) puts the mirror at (4.4,-11), so the "bank" fires almost straight
    // down (~-1.5422 rad) into the floor at (4.267,-1) and the reflected leg climbs back
    // up through x~4.2 at y=3 -- 0.214 units from the muzzle at (4,3), well inside
    // TANK_RADIUS + BULLET_RADIUS (0.6). Both legs are wall-clear, so the old
    // two-leg-LOS-only check happily returned it.
    const walls = [wall(1, 0, -2, 8, -1)];
    expect(bankShot({ x: 4, y: 3 }, { x: 4.4, y: 9 }, walls, 3)).toBeNull();
  });

  it('property: no returned bank path passes within a hull-width of its own muzzle', () => {
    // Deterministic fuzz (nextRng chained, no Math.random) over random 3-wall arenas.
    // For every non-null result, reconstruct the bounce point the same way a shell would
    // reach it (nearest wall hit along the firing ray) and measure the muzzle against the
    // reflected leg [bounce -> target] with the hand-written distPointSeg above.
    let seed = 20240719;
    const rnd = (lo: number, hi: number) => {
      const r = nextRng(seed);
      seed = r.seed;
      return lo + r.value * (hi - lo);
    };
    let returned = 0;
    let selfHits = 0;
    for (let i = 0; i < 4000; i++) {
      const walls: Wall[] = [];
      for (let k = 0; k < 3; k++) {
        const x = rnd(-8, 8);
        const y = rnd(-8, 8);
        walls.push(wall(k + 1, x, y, x + rnd(0.5, 5), y + rnd(0.5, 5)));
      }
      const muzzle = { x: rnd(-8, 8), y: rnd(-8, 8) };
      const target = { x: rnd(-8, 8), y: rnd(-8, 8) };
      const angle = bankShot(muzzle, target, walls, 3);
      if (angle === null) continue;
      returned++;
      const far = { x: muzzle.x + Math.cos(angle) * 1000, y: muzzle.y + Math.sin(angle) * 1000 };
      const hit = firstWallHit(muzzle, far, walls);
      if (hit === null) continue; // shouldn't happen, but don't assert on a non-bank
      if (distPointSeg(muzzle, hit.point, target) < TANK_RADIUS + BULLET_RADIUS) selfHits++;
    }
    expect(returned).toBeGreaterThan(200); // the fuzz must actually exercise the happy path
    expect(selfHits).toBe(0);
  });

  it('returns the same bank shot however the reflector is sliced', () => {
    const merged: Wall[] = [
      { id: 1, kind: 'solid', destroyed: false, aabb: { minX: 0, minY: 0, maxX: 6, maxY: 2 } },
    ];
    const three: Wall[] = [0, 2, 4].map((x, i) => ({
      id: i + 1, kind: 'solid' as const, destroyed: false,
      aabb: { minX: x, minY: 0, maxX: x + 2, maxY: 2 },
    }));
    let compared = 0;

    // Muzzle/target ABOVE the run (y outside its [0,2] band) -- reflects off the run's
    // TOP face. The bounce point's x-coordinate coincides EXACTLY with a seam (x=2 or 4)
    // for 8 of these 121 pairs, which is what originally exposed a losIgnoring
    // boundary-touch bug: the muzzle->bounce / bounce->target legs graze the NEIGHBOURING
    // sub-cell's corner at that exact x, and an unfixed losIgnoring reported that graze as
    // a block. This is a regression test for that fix specifically -- reverting it
    // (temporarily, by hand, during development) reintroduced mismatches here.
    //
    // A second sub-sweep used to run here too (muzzle/target beside the run, y WITHIN its
    // [0,2] band, to make a vertical seam face itself geometrically reachable rather than
    // merely coincided with). It reported 0 mismatches under every mutation tried --
    // dropping either LOS leg, dropping both, first-valid selection, reversed wall order,
    // longest-path selection -- and was deleted rather than kept as an inert "proof of
    // nothing". The narrow, measured reason: for endpoints OUTSIDE every wall -- the only
    // muzzle/target positions the game can ever call bankShot with, since callers pass
    // tank centres and resolveWalls guarantees a tank is never inside a wall -- merged and
    // sliced agree at 0 differences across ~1.9M probes swept over 6 reflector shapes (a
    // 3-cell row, a 3-cell column, a 3x3 square, an L-shape, a T-junction, two separated
    // runs) at 2 grid alignments each. Disagreements DO exist, but only when an endpoint
    // sits inside or exactly on a wall corner (48-192 mismatches per shape on a
    // lattice-aligned grid, 0 on a non-aligned grid, always a muzzle sitting exactly on a
    // wall corner) -- states resolveWalls never produces, so a "repaired Pattern B" built
    // on them would assert behaviour at unreachable positions, which is worse than no
    // test. See the two tests below for what replaced this sub-sweep's actual job: a
    // seam/buried candidate's own rejection now has fixtures where it demonstrably
    // matters, and `faceIsBuried` (the guard this sub-sweep was originally written to
    // control for) no longer exists to give it a control anyway.
    let nonNullMerged = 0;
    for (let mx = 0.5; mx < 6; mx += 0.5) {
      for (let tx = 0.5; tx < 6; tx += 0.5) {
        const m = { x: mx, y: 4 };
        const t = { x: tx, y: 6 };
        const a = bankShot(m, t, merged, 1);
        const b = bankShot(m, t, three, 1);
        compared++;
        if (a !== null) nonNullMerged++;
        if (a === null || b === null) expect(b, `${mx}->${tx}`).toBe(a);
        else expect(b, `${mx}->${tx}`).toBeCloseTo(a, 9);
      }
    }

    expect(compared).toBe(121); // population: 11 muzzle x 11 target positions
    // Guard against a vacuous pass: `a === null && b === null` satisfies the comparison
    // above trivially, so a future change that made every candidate invalid on both sides
    // would still read green -- same approach as decomposition.test.ts's row-seam sibling.
    // Today 72 of the 121 pairs resolve a real bank shot on both sides (the other 49 sit
    // where neither muzzle nor target has line of sight to a reflecting face); pinning that
    // count catches a regression that silently drains the non-vacuous portion too.
    expect(nonNullMerged).toBe(72);
  });

  it('falls through to a farther reflector when the nearer one\'s reflected leg is blocked', () => {
    // Two reflectors: NEAR (the shorter, and so normally-winning, path) and FAR (always
    // clear, longer path). An obstacle sits between the NEAR bounce point and the target
    // ONLY -- confirmed below not to touch the muzzle->bounce leg of either reflector, nor
    // any of FAR's legs -- so this isolates the bounce->target LOS check specifically.
    // Unlike a single-reflector "returns null" test, FAR being available and CORRECT
    // means shortest-path selection cannot silently prefer NEAR anyway if the rejection
    // is missing: a missing bounce->target check makes NEAR (wrongly) win over FAR, which
    // is directly observable as the wrong angle, not just non-null vs null.
    const near: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: -20, minY: 0, maxX: 20, maxY: 2 } };
    const far: Wall = { id: 2, kind: 'solid', destroyed: false, aabb: { minX: -20, minY: 20, maxX: 20, maxY: 22 } };
    const obstacle: Wall = { id: 3, kind: 'solid', destroyed: false, aabb: { minX: 7.5, minY: 3, maxX: 9, maxY: 5 } };
    const m = { x: 5, y: 4 };
    const t = { x: 10, y: 6 };

    const soloNear = bankShot(m, t, [near], 1);
    const soloFar = bankShot(m, t, [far], 1);
    expect(soloNear).not.toBeNull();
    expect(soloFar).not.toBeNull();
    expect(soloNear).not.toBeCloseTo(soloFar as number, 6); // genuinely different candidates

    // Without the obstacle, NEAR (shorter) wins -- confirms it really is the closer one.
    expect(bankShot(m, t, [near, far], 1)).toBeCloseTo(soloNear as number, 9);

    // With the obstacle blocking ONLY near's reflected leg, the answer must become FAR's,
    // not near's (which would mean the rejection was skipped) and not null (which would
    // mean FAR's own candidate was wrongly rejected too).
    expect(bankShot(m, t, [near, far, obstacle], 1)).toBeCloseTo(soloFar as number, 9);
    // FAR's own candidate is unaffected by the obstacle in isolation, confirming the
    // obstacle's placement doesn't leak into FAR's legs.
    expect(bankShot(m, t, [far, obstacle], 1)).toBeCloseTo(soloFar as number, 9);
  });

  it('falls through to a farther reflector when the nearer one\'s approach leg is blocked', () => {
    // Mirror of the previous test: muzzle and target swapped, so the same obstacle now
    // sits between NEAR's bounce point and the MUZZLE instead, isolating the
    // muzzle->bounce LOS check.
    const near: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: -20, minY: 0, maxX: 20, maxY: 2 } };
    const far: Wall = { id: 2, kind: 'solid', destroyed: false, aabb: { minX: -20, minY: 20, maxX: 20, maxY: 22 } };
    const obstacle: Wall = { id: 3, kind: 'solid', destroyed: false, aabb: { minX: 7.5, minY: 3, maxX: 9, maxY: 5 } };
    const m = { x: 10, y: 6 };
    const t = { x: 5, y: 4 };

    const soloNear = bankShot(m, t, [near], 1);
    const soloFar = bankShot(m, t, [far], 1);
    expect(soloNear).not.toBeNull();
    expect(soloFar).not.toBeNull();
    expect(soloNear).not.toBeCloseTo(soloFar as number, 6);

    expect(bankShot(m, t, [near, far], 1)).toBeCloseTo(soloNear as number, 9);
    expect(bankShot(m, t, [near, far, obstacle], 1)).toBeCloseTo(soloFar as number, 9);
    expect(bankShot(m, t, [far, obstacle], 1)).toBeCloseTo(soloFar as number, 9);
  });

  it('blocks a leg that crosses a wall far from either endpoint, on a long segment', () => {
    // REGRESSION. `hit.t` is a fraction of the leg's length; `headingIntoBox` probes a
    // fixed SWEEP_EPS of WORLD distance. Comparing them directly made the graze branch
    // fire for any hit within SWEEP_EPS*len of an endpoint, while the probe still looked
    // only SWEEP_EPS ahead -- so on a segment longer than 1 unit there was a band of
    // offsets where a REAL crossing probed clear and was waved through as a graze.
    //
    // The obstacle sits squarely across the muzzle->bounce leg. `delta` slides the muzzle
    // just off the obstacle's top face; the leg is ~7 units long, so the leaked band was
    // (SWEEP_EPS, SWEEP_EPS*len] ~= (1e-7, 7e-7].
    const reflector: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: -100, minY: 0, maxX: 100, maxY: 2 } };
    const obstacle: Wall = { id: 2, kind: 'solid', destroyed: false, aabb: { minX: -1, minY: 8, maxX: 1, maxY: 9 } };
    const target = { x: 0.5, y: 6 };

    // The obstacle must actually be in the way: without it every offset resolves a bank.
    for (const delta of [0, 1e-8, 2e-7, 6e-7, 1e-6]) {
      expect(bankShot({ x: 0, y: 9 + delta }, target, [reflector], 1), `clear delta=${delta}`).not.toBeNull();
    }
    // With it, every offset must be blocked. 2e-7 and 6e-7 are inside the old leak band
    // and returned the unobstructed angle before this was fixed; 0/1e-8 (probe lands
    // inside) and 1e-6 (past the band entirely) were always blocked and are the controls
    // that prove the fixture straddles the boundary rather than sitting on one side.
    for (const delta of [0, 1e-8, 2e-7, 6e-7, 1e-6]) {
      expect(bankShot({ x: 0, y: 9 + delta }, target, [reflector, obstacle], 1), `blocked delta=${delta}`).toBeNull();
    }
  });

  it('picks between two equal-length reflectors deterministically, not by array order', () => {
    // A boxed room: muzzle and target sit near the LEFT wall, so LEFT is both listed
    // first below and would be the first candidate found in wall/face iteration order.
    //
    // The two candidate paths here are EXACTLY the same length -- both sqrt(52), by the
    // symmetry of (1,5)/(5,9) about the room -- so what this test pins is the ANGLE
    // tiebreak, not the length comparison. (An earlier version of this comment claimed
    // the top path was shorter and that this proved selection by path length. It is not
    // shorter; the lengths are bit-identical. Length ordering is pinned instead by the
    // two fall-through tests above and by decomposition.test.ts's 'picks the shorter of
    // two non-collinear bank reflectors'.) It still kills first-valid, which is what the
    // final assertion is for.
    const left: Wall = { id: 1, kind: 'solid', destroyed: false, aabb: { minX: -1, minY: -1, maxX: 0, maxY: 11 } };
    const right: Wall = { id: 2, kind: 'solid', destroyed: false, aabb: { minX: 10, minY: -1, maxX: 11, maxY: 11 } };
    const bottom: Wall = { id: 3, kind: 'solid', destroyed: false, aabb: { minX: -1, minY: -1, maxX: 11, maxY: 0 } };
    const top: Wall = { id: 4, kind: 'solid', destroyed: false, aabb: { minX: -1, minY: 10, maxX: 11, maxY: 11 } };
    const m = { x: 1, y: 5 };
    const t = { x: 5, y: 9 };

    // Each wall alone gives a valid, genuinely different candidate -- confirms they
    // actually compete rather than one being degenerate or unreachable.
    const soloLeft = bankShot(m, t, [left], 1);
    const soloTop = bankShot(m, t, [top], 1);
    expect(soloLeft).not.toBeNull();
    expect(soloTop).not.toBeNull();
    expect(soloLeft).not.toBeCloseTo(soloTop as number, 6);

    // Both candidate paths are analytically sqrt(52): mirroring t across left's inner
    // face x=0 gives (-5,9) and across top's inner face y=10 gives (5,11), and the muzzle
    // is equidistant from both mirrors. Asserted rather than left as prose -- if a fixture
    // edit ever made the two lengths differ, this test would quietly stop exercising the
    // tiebreak and nothing else would notice.
    expect(Math.hypot(-5 - m.x, 9 - m.y)).toBeCloseTo(Math.sqrt(52), 12);
    expect(Math.hypot(5 - m.x, 11 - m.y)).toBeCloseTo(Math.sqrt(52), 12);

    // left is listed FIRST; a first-valid implementation returns soloLeft's angle for this
    // exact array (verified directly against a first-valid build during development).
    // The real implementation must return soloTop's angle -- the smaller angle of the two
    // tied candidates -- instead.
    const combined = bankShot(m, t, [left, right, bottom, top], 1);
    expect(combined).toBeCloseTo(soloTop as number, 9);
    expect(combined).not.toBeCloseTo(soloLeft as number, 6);

    // Array order must not matter: every ordering of the same 4 walls gives the same
    // shortest answer.
    const permutations: Wall[][] = [
      [left, right, bottom, top],
      [top, bottom, right, left],
      [right, left, top, bottom],
      [bottom, top, left, right],
    ];
    for (const walls of permutations) {
      expect(bankShot(m, t, walls, 1)).toBeCloseTo(soloTop as number, 9);
    }
    // population: 4 of the 24 possible orderings of these 4 walls (4! = 24) -- a
    // hand-picked sample (original order plus 3 rotations/swaps), not an exhaustive
    // sweep of the full permutation group.
    expect(permutations.length).toBe(4);
  });
});

describe('shotHitsOwnSide', () => {
  function aiTank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
    return {
      id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
      desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
      aiState: 'idle', aiTimer: 0, ...over,
    };
  }
  function w(tanks: Tank[], walls: Wall[] = []): World {
    return {
      tick: 0, nextId: 100, seed: 1, tanks, bullets: [], mines: [], blasts: [], walls,
      spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none' as const,
    };
  }

  it('reports a teammate sitting squarely on the firing line', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    const mate = aiTank(2, 'brown', { x: 4, y: 0 });
    expect(shotHitsOwnSide(w([shooter, mate]), shooter, 0, 'normal')).toBe(true);
  });

  it('reports a teammate grazing the line at exactly the clearance boundary', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    // Just inside the clearance -> blocked; just outside -> clear. Pins the threshold
    // rather than only the obvious dead-centre case.
    const inside = aiTank(2, 'brown', { x: 4, y: AI_HULL_CLEARANCE - 1e-6 });
    const outside = aiTank(2, 'brown', { x: 4, y: AI_HULL_CLEARANCE + 1e-6 });
    expect(shotHitsOwnSide(w([shooter, inside]), shooter, 0, 'normal')).toBe(true);
    expect(shotHitsOwnSide(w([shooter, outside]), shooter, 0, 'normal')).toBe(false);
  });

  it('reports a teammate who is off the line now but walks into the shell', () => {
    // The check ran against where teammates STAND at the trigger pull, but Grey and Teal
    // roam, and a shell is in flight for up to AI_SHOT_LOOKAHEAD seconds. The teammate
    // below is 2.5 units clear of the firing line -- five times the hull clearance -- and
    // drives straight through it, arriving exactly when the shell does.
    // Shell: speed 6 along +x, so it reaches x=5 at t = 5/6 s.
    // Mate: TANK_SPEED 3 along -y from y=2.5, so it reaches y=0 at t = 2.5/3 = 5/6 s.
    // The mate is a GREY: the choreography needs a full-TANK_SPEED walker, and the
    // 2026-07-31 balance pass slowed teal to 0.6x -- a teal arrives after the shell
    // has passed and the intercept this test is about never happens.
    const shooter = aiTank(1, 'brown', { x: 0, y: 0 });
    const mate = aiTank(2, 'grey', { x: 5, y: 2.5 }, { desiredMove: { x: 0, y: -1 } });
    expect(shotHitsOwnSide(w([shooter, mate]), shooter, 0, 'normal')).toBe(true);
  });

  it('does not report a teammate whose motion carries it clear of the shell', () => {
    // The mirror of the case above: prediction must not turn into blanket paranoia about
    // any teammate near the line, or the AI stops shooting, which is its own bug.
    // This mate starts 2.5 clear and drives AWAY, so it is never near the shell.
    // Grey, to mirror the walk-in case exactly (teal creeps since 2026-07-31).
    const shooter = aiTank(1, 'brown', { x: 0, y: 0 });
    const mate = aiTank(2, 'grey', { x: 5, y: 2.5 }, { desiredMove: { x: 0, y: 1 } });
    expect(shotHitsOwnSide(w([shooter, mate]), shooter, 0, 'normal')).toBe(false);
  });

  it('does not report the player (the AI is supposed to shoot at that one)', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    const player = aiTank(2, 'player', { x: 4, y: 0 });
    expect(shotHitsOwnSide(w([shooter, player]), shooter, 0, 'normal')).toBe(false);
  });

  it('does not report a dead teammate (a corpse blocks nothing)', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    const mate = aiTank(2, 'brown', { x: 4, y: 0 }, { alive: false });
    expect(shotHitsOwnSide(w([shooter, mate]), shooter, 0, 'normal')).toBe(false);
  });

  it('does not report the shooter itself (the muzzle is inside its own hull)', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    expect(shotHitsOwnSide(w([shooter]), shooter, 0, 'normal')).toBe(false);
  });

  it('does not report a teammate BEHIND the muzzle', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    const mate = aiTank(2, 'brown', { x: -4, y: 0 }); // opposite the firing direction
    expect(shotHitsOwnSide(w([shooter, mate]), shooter, 0, 'normal')).toBe(false);
  });

  it('does not report a teammate standing beyond a wall a bounce-less shell dies on', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    const mate = aiTank(2, 'brown', { x: 6, y: 0 });
    const walls = [wall(9, 2, -1, 3, 1)];
    // 'fast' has FAST_BOUNCES = 0, so the shell stops dead at x=2 and never reaches x=6.
    expect(shotHitsOwnSide(w([shooter, mate], walls), shooter, 0, 'fast')).toBe(false);
  });

  // ---- The whole ricochet polyline is checked, not just the opening leg. Checking only
  // the opening leg missed every kill that happened after a bounce -- which is most of
  // them, since resolveBulletHits turns a returning shell lethal to its own owner. ----

  it('reports the SHOOTER when the shell bounces straight back off a wall in front of it', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 0 });
    const walls = [wall(9, 2, -1, 3, 1)]; // head-on: the shell reflects to -x, back through (0,0)
    // NORMAL_BOUNCES is 1, so this shell really does come back and really does kill its
    // owner. The opening leg (0,0)->(2,0) is completely clear, which is exactly why a
    // first-leg-only check let this through.
    expect(shotHitsOwnSide(w([shooter], walls), shooter, 0, 'normal')).toBe(true);
  });

  it('reports a teammate the shell only reaches AFTER a bounce', () => {
    const shooter = aiTank(1, 'grey', { x: 0, y: 3 });
    // Fire down-right at -45deg into the floor: the shell reaches y=0 at (3,0), reflects to
    // up-right, and runs along y = x-3 -- straight through a teammate at (6,3). The opening
    // leg (0,3)->(3,0) has nothing on it at all.
    const mate = aiTank(2, 'brown', { x: 6, y: 3 });
    const walls = [wall(9, -10, -1, 10, 0)];
    expect(shotHitsOwnSide(w([shooter, mate], walls), shooter, -Math.PI / 4, 'normal')).toBe(true);
  });
});

describe('friendlyInMineBlast', () => {
  function aiTank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
    return {
      id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
      desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
      aiState: 'idle', aiTimer: 0, ...over,
    };
  }
  function w(tanks: Tank[]): World {
    return {
      tick: 0, nextId: 100, seed: 1, tanks, bullets: [], mines: [], blasts: [], walls: [],
      spawns: [], status: 'playing', lives: 3, roundStartTick: 0, unarmedTrigger: 'none' as const,
    };
  }

  it('reports a teammate standing where the mine would go off', () => {
    const layer = aiTank(1, 'grey', { x: 0, y: 0 });
    const mate = aiTank(2, 'brown', { x: 1, y: 0 });
    expect(friendlyInMineBlast(w([layer, mate]), layer)).toBe(true);
  });

  it('boundary: inside AI_MINE_FLEE_RADIUS blocks the drop, outside allows it', () => {
    const layer = aiTank(1, 'grey', { x: 0, y: 0 });
    const inside = aiTank(2, 'brown', { x: AI_MINE_FLEE_RADIUS - 1e-6, y: 0 });
    const outside = aiTank(2, 'brown', { x: AI_MINE_FLEE_RADIUS + 1e-6, y: 0 });
    expect(friendlyInMineBlast(w([layer, inside]), layer)).toBe(true);
    expect(friendlyInMineBlast(w([layer, outside]), layer)).toBe(false);
  });

  it('does not report the player (mining the player is the entire point)', () => {
    const layer = aiTank(1, 'grey', { x: 0, y: 0 });
    const player = aiTank(2, 'player', { x: 1, y: 0 });
    expect(friendlyInMineBlast(w([layer, player]), layer)).toBe(false);
  });

  it('does not report the layer itself (it is standing on the mine by construction)', () => {
    const layer = aiTank(1, 'grey', { x: 0, y: 0 });
    expect(friendlyInMineBlast(w([layer]), layer)).toBe(false);
  });

  it('does not report a dead teammate', () => {
    const layer = aiTank(1, 'grey', { x: 0, y: 0 });
    const corpse = aiTank(2, 'brown', { x: 1, y: 0 }, { alive: false });
    expect(friendlyInMineBlast(w([layer, corpse]), layer)).toBe(false);
  });
});

describe('wanderMove', () => {
  it('is pure: same (seed, id, bucket) yields the identical heading', () => {
    const t = wanderTank(1);
    const a = wanderMove(wanderWorld(7, 0), t);
    const b = wanderMove(wanderWorld(7, 0), t);
    expect(a).toEqual(b);
  });

  it('always returns a unit-length heading', () => {
    const t = wanderTank(1);
    const v = wanderMove(wanderWorld(7, 0), t);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 9);
  });

  it('different tank.id yields a different heading for the same (seed, tick)', () => {
    const w = wanderWorld(7, 0);
    const a = wanderMove(w, wanderTank(1));
    const b = wanderMove(w, wanderTank(2));
    expect(a).not.toEqual(b);
  });

  it('holds the heading across a bucket (ticks 0 and 29) and changes at the boundary (tick 30)', () => {
    const t = wanderTank(1);
    const atTick0 = wanderMove(wanderWorld(7, 0), t);
    const atTick29 = wanderMove(wanderWorld(7, 29), t);
    const atTick30 = wanderMove(wanderWorld(7, 30), t);
    expect(atTick29).toEqual(atTick0);
    expect(atTick30).not.toEqual(atTick0);
  });

  it('pins the exact heading for (seed=7, id=1, tick=0) to lock the PRNG contract', () => {
    // Derived by evaluating the real nextRng/fromAngle path:
    // rngSeed = world.seed + tank.id*1000 + bucket = 7 + 1*1000 + 0 = 1007
    // nextRng(1007).value = 0.8710461324080825
    // angle = value * 2*PI = 5.472944261022068
    // fromAngle(angle) = (cos, sin) = (0.689323826282066, -0.7244533542746918)
    const v = wanderMove(wanderWorld(7, 0), wanderTank(1));
    expect(v.x).toBeCloseTo(0.689323826282066, 9);
    expect(v.y).toBeCloseTo(-0.7244533542746918, 9);
  });
});

describe('aimJitter', () => {
  it('is pure: same (seed, id, tick bucket) yields the identical offset', () => {
    const t = wanderTank(1);
    const a = aimJitter(wanderWorld(7, 0), t, AI_AIM_SPREAD);
    const b = aimJitter(wanderWorld(7, 0), t, AI_AIM_SPREAD);
    expect(a).toBe(b);
  });

  it('is bounded by ±spread AND genuinely two-sided', () => {
    // Sample many (seed, tick) combinations; every offset must stay in range.
    // |offset| <= spread ALONE is a one-sided bound that a never-negative jitter (i.e. a
    // mutation dropping the `* 2 - 1` recentring) satisfies perfectly -- and a jitter that
    // only ever misses to one side is a fixed aiming bias, not scatter. So assert both
    // signs actually occur.
    const offsets: number[] = [];
    for (let seed = 0; seed < 20; seed++) {
      for (let tick = 0; tick < 20; tick++) {
        const offset = aimJitter(wanderWorld(seed, tick * AI_JITTER_TICKS), wanderTank(1), AI_AIM_SPREAD);
        expect(Math.abs(offset)).toBeLessThanOrEqual(AI_AIM_SPREAD);
        offsets.push(offset);
      }
    }
    expect(offsets.some((o) => o < 0)).toBe(true);
    expect(offsets.some((o) => o > 0)).toBe(true);
  });

  it('pins the exact offset for (seed=7, id=1, bucket=0) to lock the PRNG contract', () => {
    // Hand-derived from the real nextRng path, NOT by calling aimJitter (the personality
    // tests in brown/grey/teal.test.ts assert wiring by calling aimJitter, which cannot
    // catch a wrong jitter; this is the independent anchor that can):
    //   rngSeed = world.seed + tank.id * 7919 + floor(tick / AI_JITTER_TICKS)
    //           = 7 + 1 * 7919 + 0 = 7926
    //   nextRng(7926).value = 0.4734923338983208
    //   offset = (value * 2 - 1) * AI_AIM_SPREAD
    //          = -0.0530153322033584 * 0.08 = -0.0042412265762686725
    // Note the NEGATIVE sign: a jitter that dropped the `* 2 - 1` recentring cannot
    // produce this number at all.
    const v = aimJitter(wanderWorld(7, 0), wanderTank(1), AI_AIM_SPREAD);
    expect(v).toBeCloseTo(-0.0042412265762686725, 12);
  });

  it('pins the exact offset for the NEXT bucket and for a different tank id', () => {
    // Same derivation, different rngSeed inputs -- these pin the two multipliers
    // (bucket + 1, and tank.id * 7919) independently of each other.
    //   id=1, bucket=1 -> 7 + 7919 + 1 = 7927; nextRng(7927).value = 0.5667016815859824
    //     offset = 0.1334033631719648 * 0.08 = 0.010672269053757184
    //   id=2, bucket=0 -> 7 + 15838 + 0 = 15845; nextRng(15845).value = 0.5161849558353424
    //     offset = 0.0323699116706848 * 0.08 = 0.0025895929336547843
    expect(aimJitter(wanderWorld(7, AI_JITTER_TICKS), wanderTank(1), AI_AIM_SPREAD))
      .toBeCloseTo(0.010672269053757184, 12);
    expect(aimJitter(wanderWorld(7, 0), wanderTank(2), AI_AIM_SPREAD))
      .toBeCloseTo(0.0025895929336547843, 12);
  });

  it('differs across tanks at the same tick (not a shared/global offset)', () => {
    const w = wanderWorld(7, 0);
    const a = aimJitter(w, wanderTank(1), AI_AIM_SPREAD);
    const b = aimJitter(w, wanderTank(2), AI_AIM_SPREAD);
    expect(a).not.toBe(b);
  });

  it('differs across tick buckets for the same tank (re-rolls, not a fixed miss)', () => {
    const t = wanderTank(1);
    const atBucket0 = aimJitter(wanderWorld(7, 0), t, AI_AIM_SPREAD);
    const atBucket1 = aimJitter(wanderWorld(7, AI_JITTER_TICKS), t, AI_AIM_SPREAD);
    expect(atBucket0).not.toBe(atBucket1);
  });

  it('holds within a bucket (ticks 0 and AI_JITTER_TICKS-1) and changes at the boundary', () => {
    const t = wanderTank(1);
    const atTick0 = aimJitter(wanderWorld(7, 0), t, AI_AIM_SPREAD);
    const atTickLast = aimJitter(wanderWorld(7, AI_JITTER_TICKS - 1), t, AI_AIM_SPREAD);
    const atTickNext = aimJitter(wanderWorld(7, AI_JITTER_TICKS), t, AI_AIM_SPREAD);
    expect(atTickLast).toBe(atTick0);
    expect(atTickNext).not.toBe(atTick0);
  });

  it('is NOT correlated with that tank\'s wanderMove heading (distinct multiplier from wanderMove\'s tank.id*1000)', () => {
    // If aimJitter used the same multiplier as wanderMove, its sign/magnitude would move
    // in lockstep with the wander heading's angle for every tank id at a fixed tick. Probe
    // several ids and confirm the two signals are not simply reproductions of each other.
    const w = wanderWorld(7, 0);
    let anyDifferentRelationship = false;
    let prevRatioSign: number | null = null;
    for (let id = 1; id <= 8; id++) {
      const t = wanderTank(id);
      const jitter = aimJitter(w, t, AI_AIM_SPREAD);
      const wander = wanderMove(w, t);
      const wanderAngle = Math.atan2(wander.y, wander.x);
      const sign = Math.sign(jitter) * Math.sign(wanderAngle);
      if (prevRatioSign !== null && sign !== prevRatioSign) anyDifferentRelationship = true;
      prevRatioSign = sign;
    }
    expect(anyDifferentRelationship).toBe(true);
  });

  it('scales with the spread parameter (zero spread yields zero offset)', () => {
    const t = wanderTank(1);
    expect(aimJitter(wanderWorld(7, 0), t, 0)).toBeCloseTo(0, 12);
  });
});
