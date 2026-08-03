import type { Wall, Tank, Spawn, AABB, TankKind, WallKind, UnarmedTrigger } from './types';
import { createWorld, type World } from './world';
import { LIVES } from './constants';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { SPAWN_LETTERS } from './config/arena-types';

export interface Arena {
  cols: number;
  rows: number;
  cellSize: number;
  grid: string[];
  legend: Record<string, WallKind>;
}

// Grids, notes and design claims live in config/data/arenas.json, validated at load
// (config/validate.ts). These named exports stay so every consumer -- levels.ts, the
// gl harness, the gallery, dozens of tests -- is untouched by the move.
export const ARENA_01: Arena = arenaById('arena-01');
export const ARENA_02: Arena = arenaById('arena-02');
export const ARENA_03: Arena = arenaById('arena-03');
export const ARENA_04: Arena = arenaById('arena-04');
export const ARENAS: Arena[] = ARENA_DEFS;

/**
 * The playable area, in world units. Derived from the same `cols * cellSize`
 * that `loadArena` lays the grid out with, so the two can never drift.
 *
 * Deliberately NOT measurable from the returned walls: `loadArena` rings the
 * arena with boundary walls one cell THICK and OUTSIDE play (see below), so
 * `max(wall.aabb.maxX)` overstates the arena by a cell in each axis. A renderer
 * that sizes and centres the ground from that reading draws the board
 * off-centre with its own boundary walls hanging over the void.
 */
export function arenaBounds(arena: Arena): { width: number; height: number } {
  return { width: arena.cols * arena.cellSize, height: arena.rows * arena.cellSize };
}

export function makeTank(id: number, kind: TankKind, pos: { x: number; y: number }, angle: number): Tank {
  return {
    id,
    kind,
    pos: { ...pos },
    bodyAngle: angle,
    turretAngle: angle,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

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
 * barrier is authored as adjacent blocks that must stay separately destructible. (Those
 * blocks were 2.0 units when this was written and are 0.667 since the rescale, which is
 * exactly the point: merging them would fuse a barrier the level breaches piecemeal.)
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

export function loadArena(arena: Arena): { walls: Wall[]; tanks: Tank[]; spawns: Spawn[] } {
  const { cols, rows, cellSize, grid, legend } = arena;

  // Validate grid dimensions
  if (grid.length !== rows) {
    throw new Error(`Grid has ${grid.length} rows but Arena declares ${rows} rows`);
  }

  // Validate each row's column count
  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    if (row.length !== cols) {
      throw new Error(`Row ${r} has length ${row.length} but Arena declares ${cols} columns`);
    }
  }

  // Validate each character is recognized
  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      if (ch !== '.' && !legend[ch] && !SPAWN_LETTERS[ch]) {
        throw new Error(`Unrecognized character '${ch}' at (row ${r}, col ${c})`);
      }
    }
  }

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

  // 4 solid boundary walls (thickness = one cell) around the playable area, so
  // reflectSweep bounces bullets off the edges with no map-escape special case.
  const W = cols * cellSize;
  const H = rows * cellSize;
  const t = cellSize;
  const boundaries: AABB[] = [
    { minX: -t, minY: -t, maxX: W + t, maxY: 0 }, // top
    { minX: -t, minY: H, maxX: W + t, maxY: H + t }, // bottom
    { minX: -t, minY: 0, maxX: 0, maxY: H }, // left
    { minX: W, minY: 0, maxX: W + t, maxY: H }, // right
  ];
  for (const aabb of boundaries) {
    walls.push({ id: id++, aabb, kind: 'solid', destroyed: false });
  }

  return { walls, tanks, spawns };
}

/**
 * Where a single-arena consumer should point. The gl harness sizes its board from
 * this; the game layer proper walks ARENAS. Kept as ARENAS[0] so "the first level"
 * and "the arena tools assume" cannot drift apart.
 */
export const CURRENT_ARENA: Arena = ARENAS[0];

/**
 * Build a playable world from any arena. The progression's per-level constructor;
 * `lives` is how a cleared level's remaining lives carry into the next one.
 */
export function createWorldFor(
  arena: Arena,
  seed?: number,
  unarmedTrigger?: UnarmedTrigger,
  lives: number = LIVES,
): World {
  return createWorld({ ...loadArena(arena), lives, seed, unarmedTrigger });
}

/**
 * `seed` drives every random draw in the sim (AI wander headings, aim jitter).
 * It is a parameter rather than a constant because the default made every
 * playthrough byte-identical: 78 consecutive rounds measured at exactly 1,276
 * ticks each, with the enemies walking the same paths and missing by the same
 * angles forever. The game layer passes a fresh one per session; tests and
 * replays omit it and get the reproducible default.
 *
 * Kept at its old one-arena signature: dozens of tests (and the pacifist suite's
 * headline metric) mean "level 1" when they say createArenaWorld.
 */
export function createArenaWorld(seed?: number, unarmedTrigger?: UnarmedTrigger): World {
  return createWorldFor(ARENAS[0], seed, unarmedTrigger);
}
