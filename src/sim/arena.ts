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

function makeTank(id: number, kind: TankKind, pos: { x: number; y: number }, angle: number): Tank {
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
  let id = 1;

  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      const wallKind = legend[ch];
      if (wallKind) {
        walls.push({
          id: id++,
          aabb: {
            minX: c * cellSize,
            minY: r * cellSize,
            maxX: (c + 1) * cellSize,
            maxY: (r + 1) * cellSize,
          },
          kind: wallKind,
          destroyed: false,
        });
      } else if (SPAWN_LETTERS[ch]) {
        const kind = SPAWN_LETTERS[ch];
        const pos = { x: (c + 0.5) * cellSize, y: (r + 0.5) * cellSize };
        const angle = 0;
        spawns.push({ kind, pos: { ...pos }, angle });
        tanks.push(makeTank(id++, kind, pos, angle));
      }
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
