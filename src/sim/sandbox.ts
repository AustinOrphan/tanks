import type { TankKind, UnarmedTrigger } from './types';
import { nextRng } from './types';
import type { Arena } from './arena';
import { ARENA_01, loadArena } from './arena';
import { createWorld, type World } from './world';
import { LIVES } from './constants';

/**
 * The dev sandbox: an open floor whose contents come from plain options.
 *
 * This file is PURE -- options in, Arena/World out. The query-string parsing that
 * produces the options lives in the game layer (devflags), the same route `seed` takes,
 * so runtime flags never enter src/sim/ and a sandbox session replays exactly.
 */
export interface SandboxOptions {
  /** Enemy kinds to spawn, any multiset. Default: one of each. */
  tanks?: TankKind[];
  /** Weapons off for every enemy. Default TRUE: the sandbox is scenery until asked. */
  disarmed?: boolean;
  /** Interior wall cells to scatter, seeded. Default 0: open floor. */
  walls?: number;
  /** Drives wall placement here and every AI draw once the world runs. */
  seed?: number;
}

/**
 * Where enemies stand, in fill order: the corners of the enemy half first, then the
 * gaps. Fixed rather than random so "the second brown" is always the same tank in the
 * same place -- a sandbox exists to make observations repeatable.
 */
export const SANDBOX_ENEMY_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [9, 2], [3, 1], [7, 1], [5, 2], [1, 3], [9, 3], [3, 3], [7, 3], [5, 1],
];

const PLAYER_CELL: readonly [number, number] = [5, 7];

const KIND_LETTER: Record<Exclude<TankKind, 'player'>, string> = {
  brown: 'B',
  grey: 'G',
  teal: 'T',
  olive: 'O',
};

/** Chebyshev-adjacent to any spawn cell: walls may not crowd a tank at birth. */
function nearSpawn(c: number, r: number, spawnCells: ReadonlyArray<readonly [number, number]>): boolean {
  return spawnCells.some(([sc, sr]) => Math.abs(sc - c) <= 1 && Math.abs(sr - r) <= 1);
}

/** 4-neighbour flood fill over open cells; true when every open cell is reached. */
function fullyConnected(grid: string[], legend: Arena['legend']): boolean {
  const rows = grid.length;
  const cols = grid[0].length;
  const open = (r: number, c: number): boolean => !legend[grid[r][c]];
  let start: [number, number] | null = null;
  let openCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (open(r, c)) {
        openCount++;
        if (!start) start = [r, c];
      }
    }
  }
  if (!start) return true;
  const seen = grid.map((row) => [...row].map(() => false));
  const stack = [start];
  seen[start[0]][start[1]] = true;
  let reached = 0;
  while (stack.length) {
    const [r, c] = stack.pop()!;
    reached++;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (seen[nr][nc] || !open(nr, nc)) continue;
      seen[nr][nc] = true;
      stack.push([nr, nc]);
    }
  }
  return reached === openCount;
}

export function sandboxArena(opts: SandboxOptions): Arena {
  const kinds = opts.tanks ?? (['brown', 'grey', 'teal'] as TankKind[]);
  if (kinds.length > SANDBOX_ENEMY_ANCHORS.length) {
    throw new Error(
      `sandbox holds at most ${SANDBOX_ENEMY_ANCHORS.length} enemies, got ${kinds.length}`,
    );
  }
  const { cols, rows, cellSize } = ARENA_01; // the one board size the renderer can show
  const legend: Arena['legend'] = { '#': 'solid' };

  const cells: string[][] = Array.from({ length: rows }, () => Array(cols).fill('.'));
  const spawnCells: Array<readonly [number, number]> = [PLAYER_CELL];
  cells[PLAYER_CELL[1]][PLAYER_CELL[0]] = 'P';
  kinds.forEach((kind, i) => {
    if (kind === 'player') throw new Error('tanks= lists ENEMIES; the player is always present');
    const [c, r] = SANDBOX_ENEMY_ANCHORS[i];
    cells[r][c] = KIND_LETTER[kind];
    spawnCells.push([c, r]);
  });

  // Scatter walls: seeded shuffle of the eligible cells, then take placements one at a
  // time, skipping any that would seal a pocket. Refusing loudly beats returning fewer
  // than asked -- a silent cap reads as "the board has 12 walls" when it has 7.
  const wanted = opts.walls ?? 0;
  if (wanted > 0) {
    let seed = opts.seed ?? 1;
    const candidates: Array<[number, number]> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (cells[r][c] === '.' && !nearSpawn(c, r, spawnCells)) candidates.push([c, r]);
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const draw = nextRng(seed);
      seed = draw.seed;
      const j = Math.floor(draw.value * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    let placed = 0;
    for (const [c, r] of candidates) {
      if (placed === wanted) break;
      cells[r][c] = '#';
      if (fullyConnected(cells.map((row) => row.join('')), legend)) placed++;
      else cells[r][c] = '.';
    }
    if (placed < wanted) {
      throw new Error(`could only place ${placed} of ${wanted} walls without sealing a pocket`);
    }
  }

  return { cols, rows, cellSize, legend, grid: cells.map((row) => row.join('')) };
}

export function createSandboxWorld(opts: SandboxOptions, unarmedTrigger?: UnarmedTrigger): World {
  const loaded = loadArena(sandboxArena(opts));
  const disarmed = opts.disarmed ?? true;
  if (disarmed) {
    for (const t of loaded.tanks) {
      if (t.kind !== 'player') t.disarmed = true;
    }
  }
  return createWorld({ ...loaded, lives: LIVES, seed: opts.seed, unarmedTrigger });
}
