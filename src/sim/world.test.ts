import { describe, it, expect } from 'vitest';
import { createWorld, cloneWorld, step } from './world';
import type { World } from './world';
import type { Tank, Wall, Spawn, InputState } from './types';

function makeTank(id: number, x: number, y: number): Tank {
  return {
    id,
    kind: 'player',
    pos: { x, y },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

function makeWall(id: number): Wall {
  return { id, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'solid', destroyed: false };
}

function makeWorld(): World {
  const tanks = [makeTank(5, 2, 3)];
  const walls = [makeWall(9)];
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: 2, y: 3 }, angle: 0 }];
  return createWorld({ walls, tanks, spawns, lives: 3 });
}

const noInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };

describe('createWorld', () => {
  it('starts playing with empty bullet/mine arrays and given lives', () => {
    const w = makeWorld();
    expect(w.status).toBe('playing');
    expect(w.tick).toBe(0);
    expect(w.bullets).toEqual([]);
    expect(w.mines).toEqual([]);
    expect(w.lives).toBe(3);
  });

  it('sets nextId above the highest wall/tank id', () => {
    const w = makeWorld();
    expect(w.nextId).toBe(10); // max(9, 5) + 1
  });
});

describe('cloneWorld', () => {
  it('is a true deep copy', () => {
    const w = makeWorld();
    const c = cloneWorld(w);
    c.tanks[0].pos.x = 999;
    c.walls[0].aabb.minX = 999;
    c.lives = 1;
    expect(w.tanks[0].pos.x).toBe(2);
    expect(w.walls[0].aabb.minX).toBe(0);
    expect(w.lives).toBe(3);
  });
});

describe('step (skeleton)', () => {
  it('returns a NEW deep world, leaving the input untouched', () => {
    const w = makeWorld();
    const result = step(w, noInput);
    expect(result.world).not.toBe(w);
    result.world.tanks[0].pos.x = 777;
    expect(w.tanks[0].pos.x).toBe(2);
    expect(result.events).toEqual([]);
  });

  it('increments tick each call', () => {
    let w = makeWorld();
    w = step(w, noInput).world;
    expect(w.tick).toBe(1);
    w = step(w, noInput).world;
    expect(w.tick).toBe(2);
  });

  it('is deterministic: identical worlds + input give identical results', () => {
    const a = step(makeWorld(), noInput).world;
    const b = step(makeWorld(), noInput).world;
    expect(a).toEqual(b);
  });
});
