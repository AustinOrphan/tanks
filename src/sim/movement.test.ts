import { describe, it, expect } from 'vitest';
import { moveTank, separateTanks, circleVsAABB } from './collision';
import { stepMovement } from './world';
import { createWorld } from './world';
import { TANK_RADIUS, DT } from './constants';
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

function makeWall(id: number, aabb: AABB, kind: WallKind = 'solid'): Wall {
  return { id, aabb, kind, destroyed: false };
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
});

describe('separateTanks', () => {
  it('pushes two overlapping tanks apart to non-overlapping', () => {
    const a = makeTank({ id: 1, pos: { x: 0, y: 0 } });
    const b = makeTank({ id: 2, pos: { x: 0.5, y: 0 } });
    separateTanks([a, b]);
    expect(vdist(a.pos, b.pos)).toBeGreaterThanOrEqual(2 * TANK_RADIUS - 1e-9);
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
    expect(vdist(world.tanks[0].pos, world.tanks[1].pos)).toBeGreaterThanOrEqual(
      2 * TANK_RADIUS - 1e-9,
    );
  });

  it('does not move dead tanks', () => {
    const dead = makeTank({ id: 1, pos: { x: 0, y: 0 }, alive: false, desiredMove: { x: 1, y: 0 } });
    const world = createWorld({ walls: [], tanks: [dead], spawns: [], lives: 3 });
    stepMovement(world, DT);
    expect(world.tanks[0].pos).toEqual({ x: 0, y: 0 });
  });
});
