import { describe, it, expect } from 'vitest';
import { ARENA_01, loadArena, createArenaWorld } from './arena';
import { raySegmentVsAABB } from './collision';
import { bankShot } from './ai/targeting';
import { RICOCHET_BOUNCES, LIVES, TANK_RADIUS } from './constants';
import { step } from './world';
import type { InputState } from './types';

function countChar(grid: string[], ch: string): number {
  return grid.reduce((n, row) => n + [...row].filter((c) => c === ch).length, 0);
}

describe('loadArena', () => {
  it('produces the interior walls plus exactly 4 solid boundary walls', () => {
    const { walls } = loadArena(ARENA_01);
    const solidCells = countChar(ARENA_01.grid, '#');
    const destructibleCells = countChar(ARENA_01.grid, 'x');

    expect(walls.length).toBe(solidCells + destructibleCells + 4);

    const destructible = walls.filter((w) => w.kind === 'destructible');
    const solid = walls.filter((w) => w.kind === 'solid');
    expect(destructible.length).toBe(destructibleCells);
    expect(solid.length).toBe(solidCells + 4); // interior solids + 4 boundaries
  });

  it('assigns unique ids across walls and tanks', () => {
    const { walls, tanks } = loadArena(ARENA_01);
    const ids = [...walls.map((w) => w.id), ...tanks.map((t) => t.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps spawn chars to the right TankKind at grid-to-world coordinates', () => {
    const { tanks } = loadArena(ARENA_01);
    const kinds = tanks.map((t) => t.kind).sort();
    expect(kinds).toEqual(['brown', 'grey', 'player', 'teal']);

    // Teal spawn is at grid (col 5, row 3), cellSize 2 -> center (11, 7).
    const teal = tanks.find((t) => t.kind === 'teal')!;
    expect(teal.pos).toEqual({ x: 11, y: 7 });
    expect(teal.alive).toBe(true);
  });

  it('has geometry where Teal cannot hit the player directly (bank shot required)', () => {
    const { tanks, walls } = loadArena(ARENA_01);
    const teal = tanks.find((t) => t.kind === 'teal')!;
    const player = tanks.find((t) => t.kind === 'player')!;
    // A direct line from Teal to the player must be blocked by some solid wall,
    // which is exactly what forces Teal into a bank shot.
    const blocked = walls.some(
      (w) => w.kind === 'solid' && raySegmentVsAABB(teal.pos, player.pos, w.aabb) !== null,
    );
    expect(blocked).toBe(true);
  });

  it('affords Teal a real single-bounce bank shot at the player (signature slice feature)', () => {
    const { tanks, walls } = loadArena(ARENA_01);
    const teal = tanks.find((t) => t.kind === 'teal')!;
    const player = tanks.find((t) => t.kind === 'player')!;
    // The direct line is blocked (previous test), so ricochet-around-cover REQUIRES a
    // valid bank path to exist — it is the whole reason Teal (and this slice) exists.
    // If this assertion fails, the geometry does not afford one: TUNE ARENA_01 (widen
    // the side lanes / reposition the flanking blocks) until a single-bounce path is
    // found. Do NOT ship the slice with this red — a bank-less Teal just repositions
    // forever and the signature behavior never appears.
    expect(bankShot(teal.pos, player.pos, walls, RICOCHET_BOUNCES)).not.toBeNull();
  });

  it('keeps tanks and spawns in lockstep (index, kind, and position) for resetArena', () => {
    const { tanks, spawns } = loadArena(ARENA_01);
    expect(tanks.length).toBe(spawns.length);
    for (let i = 0; i < tanks.length; i++) {
      expect(tanks[i].kind).toBe(spawns[i].kind);
      expect(tanks[i].pos).toEqual(spawns[i].pos);
    }
  });

  it('encloses the play area with 4 boundary walls and no corner gaps', () => {
    const { walls } = loadArena(ARENA_01);
    const W = ARENA_01.cols * ARENA_01.cellSize;
    const H = ARENA_01.rows * ARENA_01.cellSize;
    const boundaries = walls.filter(
      (w) =>
        w.kind === 'solid' &&
        (w.aabb.minX <= 0 || w.aabb.maxX >= W || w.aabb.minY <= 0 || w.aabb.maxY >= H) &&
        (w.aabb.minX < 0 || w.aabb.maxX > W || w.aabb.minY < 0 || w.aabb.maxY > H),
    );
    expect(boundaries.length).toBe(4);

    // No gap at any corner: every corner of the play rect must be covered by some
    // boundary wall's AABB (with a little slack for TANK_RADIUS so a tank driven to
    // the extreme edge cannot slip past).
    const corners = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: 0, y: H },
      { x: W, y: H },
    ];
    for (const corner of corners) {
      const covered = boundaries.some(
        (w) =>
          corner.x >= w.aabb.minX - TANK_RADIUS &&
          corner.x <= w.aabb.maxX + TANK_RADIUS &&
          corner.y >= w.aabb.minY - TANK_RADIUS &&
          corner.y <= w.aabb.maxY + TANK_RADIUS,
      );
      expect(covered).toBe(true);
    }

    // A tank sitting exactly on the extreme edge of the play area must be inside
    // (or touching) some boundary wall, so moveTank's penetration resolution keeps
    // it on the map.
    const edgePoints = [
      { x: 0, y: H / 2 },
      { x: W, y: H / 2 },
      { x: W / 2, y: 0 },
      { x: W / 2, y: H },
    ];
    for (const p of edgePoints) {
      const inside = boundaries.some(
        (w) => p.x >= w.aabb.minX && p.x <= w.aabb.maxX && p.y >= w.aabb.minY && p.y <= w.aabb.maxY,
      );
      expect(inside).toBe(true);
    }
  });

  it('maps legend chars to the right WallKind and skips empty/spawn chars', () => {
    const { walls } = loadArena(ARENA_01);
    // Every interior wall (not one of the 4 appended boundaries) must come from
    // a '#' (solid) or 'x' (destructible) cell — never from '.' or a spawn char.
    const interior = walls.slice(0, walls.length - 4);
    for (const w of interior) {
      expect(['solid', 'destructible']).toContain(w.kind);
    }
    const solidCells = countChar(ARENA_01.grid, '#');
    const destructibleCells = countChar(ARENA_01.grid, 'x');
    expect(interior.filter((w) => w.kind === 'solid').length).toBe(solidCells);
    expect(interior.filter((w) => w.kind === 'destructible').length).toBe(destructibleCells);
  });
});

describe('createArenaWorld', () => {
  it('yields a playing world with a player and three enemies', () => {
    const w = createArenaWorld();
    expect(w.status).toBe('playing');
    expect(w.lives).toBe(3);
    expect(w.tanks.filter((t) => t.kind === 'player').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind !== 'player').length).toBe(3);
    expect(w.nextId).toBeGreaterThan(Math.max(...w.walls.map((wall) => wall.id)));
  });

  it('is a smoke-testable World: playing status, LIVES lives, non-empty arrays, one of each kind', () => {
    const w = createArenaWorld();
    expect(w.status).toBe('playing');
    expect(w.lives).toBe(LIVES);
    expect(w.tanks.length).toBeGreaterThan(0);
    expect(w.walls.length).toBeGreaterThan(0);
    expect(w.spawns.length).toBeGreaterThan(0);
    expect(w.tanks.filter((t) => t.kind === 'player').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind === 'brown').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind === 'grey').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind === 'teal').length).toBe(1);
  });

  it('steps without throwing and stays in playing status under no-op input', () => {
    let world = createArenaWorld();
    const noInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };
    expect(() => {
      for (let i = 0; i < 30; i++) {
        world = step(world, noInput).world;
      }
    }).not.toThrow();
    expect(world.status).toBe('playing');
  });
});
