import { describe, it, expect } from 'vitest';
import { lineOfSight, aimLead, mirrorAcrossAABB, bankShot, wanderMove } from './targeting';
import type { Tank, Wall } from '../types';
import type { World } from '../world';

function wall(id: number, minX: number, minY: number, maxX: number, maxY: number,
             kind: 'solid' | 'destructible' = 'solid', destroyed = false): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind, destroyed };
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
    tick, nextId: 100, seed, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0,
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
