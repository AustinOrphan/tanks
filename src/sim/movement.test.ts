import { describe, it, expect } from 'vitest';
import { moveTank, separateTanks, circleVsAABB } from './collision';
import { stepMovement } from './world';
import { createWorld } from './world';
import { TANK_RADIUS, TANK_SPEED, DT } from './constants';
import { vdist } from './types';
import type { Tank, Wall, AABB, WallKind } from './types';

function makeTank(overrides: Partial<Tank>): Tank {
  return {
    id: 0,
    kind: 'player',
    pos: { x: 0, y: 0 },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
    ...overrides,
  };
}

function makeWall(id: number, aabb: AABB, kind: WallKind = 'solid', destroyed = false): Wall {
  return { id, aabb, kind, destroyed };
}

// A tall wall occupying x in [1, 3].
const WALL: Wall = makeWall(1, { minX: 1, minY: -5, maxX: 3, maxY: 5 });

describe('moveTank', () => {
  it('slides along an axis-aligned wall on a diagonal drive (keeps tangential motion, zero penetration)', () => {
    const tank = makeTank({ pos: { x: 0.9, y: 0 }, desiredMove: { x: 1, y: 1 } });
    moveTank(tank, [WALL], DT);
    // right edge resolves to exactly the wall face
    expect(tank.pos.x + TANK_RADIUS).toBeCloseTo(WALL.aabb.minX, 9);
    // tangential (y) motion is retained
    expect(tank.pos.y).toBeGreaterThan(0);
    // no residual penetration
    expect(circleVsAABB(tank.pos, TANK_RADIUS, WALL.aabb).hit).toBe(false);
  });

  it('stops with no overlap when driving straight into a wall', () => {
    const tank = makeTank({ pos: { x: 0.9, y: 0 }, desiredMove: { x: 1, y: 0 } });
    moveTank(tank, [WALL], DT);
    expect(tank.pos.x + TANK_RADIUS).toBeCloseTo(WALL.aabb.minX, 9);
    expect(tank.pos.y).toBeCloseTo(0, 9);
    expect(circleVsAABB(tank.pos, TANK_RADIUS, WALL.aabb).hit).toBe(false);
  });

  it('produces zero drift and leaves bodyAngle unchanged when desiredMove is zero', () => {
    const tank = makeTank({ pos: { x: 0, y: 0 }, desiredMove: { x: 0, y: 0 }, bodyAngle: 1.23 });
    moveTank(tank, [], DT);
    expect(tank.pos).toEqual({ x: 0, y: 0 });
    expect(tank.bodyAngle).toBe(1.23);
  });

  it('sets bodyAngle to the movement direction when moving', () => {
    const tank = makeTank({ desiredMove: { x: 0, y: 1 } });
    moveTank(tank, [], DT);
    expect(tank.bodyAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('drives straight THROUGH a destroyed wall, and is still blocked by the same wall intact', () => {
    // `moveTank` skips walls with `destroyed: true`, but until now no test ever
    // handed it one: every wall fixture in this file was built by a helper that
    // hardcoded `destroyed: false`, so deleting the skip changed nothing the
    // suite could see. This is live behaviour, not a hypothetical -- mines
    // destroy destructible walls (mines.ts sets `w.destroyed = true`), and the
    // whole point of doing so is "mines can open new lines of fire"
    // (docs/superpowers/specs/2026-07-22-tanks-design.md). A destroyed wall that
    // still collides is an invisible wall: the arena LOOKS open and the tank
    // bounces off nothing.
    //
    // 30 ticks at TANK_SPEED * DT = 0.05/tick carries the tank 1.5 units from
    // x=0.9 to x=2.4, which is well INSIDE the wall's [1, 3] span -- not merely
    // up against its face, so a resurrected collision check cannot be satisfied
    // by a near-miss.
    const rubble = makeWall(1, { minX: 1, minY: -5, maxX: 3, maxY: 5 }, 'destructible', true);
    const tank = makeTank({ pos: { x: 0.9, y: 0 }, desiredMove: { x: 1, y: 0 } });
    for (let i = 0; i < 30; i++) moveTank(tank, [rubble], DT);
    expect(tank.pos.x).toBeCloseTo(0.9 + 30 * TANK_SPEED * DT, 9); // 2.4: unimpeded
    expect(tank.pos.x).toBeGreaterThan(rubble.aabb.minX); // ...and genuinely inside it

    // Mirror case, same wall, same drive: intact, it blocks. Without this the
    // test above would also pass if collision stopped working entirely.
    const intact = makeWall(1, { minX: 1, minY: -5, maxX: 3, maxY: 5 }, 'destructible', false);
    const blocked = makeTank({ pos: { x: 0.9, y: 0 }, desiredMove: { x: 1, y: 0 } });
    for (let i = 0; i < 30; i++) moveTank(blocked, [intact], DT);
    expect(blocked.pos.x + TANK_RADIUS).toBeCloseTo(intact.aabb.minX, 9); // 0.5: stopped at the face
  });
});

describe('separateTanks', () => {
  it('pushes two overlapping tanks apart to exactly touching, not further', () => {
    // `toBeGreaterThanOrEqual(2*TANK_RADIUS - 1e-9)` was a one-sided bound, and
    // separation is a two-sided property: doubling the per-tank push factor
    // (0.5 -> 1.0 in collision.ts) resolves this overlap to 1.5 apart instead
    // of 1.0 and satisfied the old assertion perfectly. In game that is a
    // teleport -- two tanks brushing get flung a full diameter apart, every
    // tick they touch, because the resolver overshoots and separateTanks runs
    // again next tick on whatever new overlap that caused.
    //
    // The correct resolution lands EXACTLY on contact: each tank moves half the
    // overlap along the separating axis, so the final centre distance is
    // 2 * TANK_RADIUS. Assert that, not "at least" that.
    const a = makeTank({ id: 1, pos: { x: 0, y: 0 } });
    const b = makeTank({ id: 2, pos: { x: 0.5, y: 0 } });
    separateTanks([a, b]);
    expect(vdist(a.pos, b.pos)).toBeCloseTo(2 * TANK_RADIUS, 9);
  });

  it('ignores dead tanks', () => {
    const a = makeTank({ id: 1, pos: { x: 0, y: 0 }, alive: false });
    const b = makeTank({ id: 2, pos: { x: 0.5, y: 0 } });
    separateTanks([a, b]);
    expect(a.pos).toEqual({ x: 0, y: 0 });
    expect(b.pos).toEqual({ x: 0.5, y: 0 });
  });
});

describe('stepMovement', () => {
  it('moves alive tanks by desiredMove and separates overlaps', () => {
    const a = makeTank({ id: 1, pos: { x: 0, y: 0 }, desiredMove: { x: 1, y: 0 } });
    const b = makeTank({ id: 2, pos: { x: 0.4, y: 0 } });
    const world = createWorld({ walls: [], tanks: [a, b], spawns: [], lives: 3 });
    stepMovement(world, DT);
    // Exact contact, not merely "no overlap" -- see the separateTanks test above
    // for why the one-sided bound this replaces let an overshooting push
    // through.
    expect(vdist(world.tanks[0].pos, world.tanks[1].pos)).toBeCloseTo(2 * TANK_RADIUS, 9);
  });

  it('does not move dead tanks', () => {
    const dead = makeTank({ id: 1, pos: { x: 0, y: 0 }, alive: false, desiredMove: { x: 1, y: 0 } });
    const world = createWorld({ walls: [], tanks: [dead], spawns: [], lives: 3 });
    stepMovement(world, DT);
    expect(world.tanks[0].pos).toEqual({ x: 0, y: 0 });
  });
});
