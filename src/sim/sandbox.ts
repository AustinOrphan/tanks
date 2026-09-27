import type { TankKind } from './types';
import { nextRng } from './types';
import type { Arena } from './arena';
import { ARENA_01, loadArena } from './arena';
import { createWorld, type World } from './world';
import type { WorldRulesInit } from './rules';
import { LIVES } from './constants';

/**
 * The dev sandbox: an open floor whose contents come from plain options.
 *
 * This file is pure -- options in, Arena/World out. The query-string parsing that
 * produces the options lives in the game layer (devflags), the same route `seed` takes,
 * so runtime flags never enter src/sim/ and a sandbox session replays exactly.
 */
export interface SandboxOptions {
  /** Enemy kinds to spawn, any multiset. Default: the classic trio (brown, grey, teal) -- deliberately not every kind, so existing sandbox links keep meaning what they meant. */
  tanks?: TankKind[];
  /** Weapons off for every enemy. Default true: the sandbox is scenery until asked. */
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
 *
 * Authored in cells of `SANDBOX_AUTHORED_CELL` world units and rescaled to whatever
 * resolution ARENA_01 currently uses -- see `blockScale`. They are not grid indices.
 */
export const SANDBOX_ENEMY_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [9, 2], [3, 1], [7, 1], [5, 2], [1, 3], [9, 3], [3, 3], [7, 3], [5, 1],
];

const PLAYER_CELL: readonly [number, number] = [5, 7];

/**
 * The cell size the anchors above and the wall/clearance sizes below were authored
 * against. The sandbox borrows ARENA_01's dimensions, so read as raw indices at a finer
 * cell size those numbers silently change meaning: the anchors collapse into the board's
 * top-left corner and `walls=N` scatters sub-tank-sized pillars.
 *
 * Everything here is therefore expressed in these units and scaled through `blockScale`,
 * so a resolution change moves the sandbox with the arenas instead of past them.
 * `sandbox.test.ts` pins the resulting world positions and wall sizes, not just grid
 * characters.
 */
const SANDBOX_AUTHORED_CELL = 2;

/** How many of today's cells make up one authored block. 1 if nothing was rescaled. */
function blockScale(cellSize: number): number {
  return Math.max(1, Math.round(SANDBOX_AUTHORED_CELL / cellSize));
}

/**
 * An authored cell's index in today's grid: its centre sub-cell, which is what keeps the
 * world position identical across a rescale (`(k*c + (k-1)/2 + 0.5) * cellSize` is
 * `(c + 0.5) * SANDBOX_AUTHORED_CELL` for odd k).
 */
function scaleCell([c, r]: readonly [number, number], k: number): readonly [number, number] {
  const off = (k - 1) >> 1;
  return [c * k + off, r * k + off];
}

const KIND_LETTER: Record<Exclude<TankKind, 'player'>, string> = {
  brown: 'B',
  grey: 'G',
  teal: 'T',
  olive: 'O',
  // 'N' because grey already holds 'G'. Re-lettering grey would rewrite every
  // campaign grid, so the newcomer takes the free letter -- see SPAWN_LETTERS,
  // which this table must agree with.
  green: 'N',
  yellow: 'Y',
};

/**
 * Within one authored block of any spawn cell: walls may not crowd a tank at birth.
 * `reach` is in today's cells, so the world-space clearance is the same whatever the
 * resolution -- a raw Chebyshev-1 would shrink with the cells and stop clearing a tank's
 * own hull.
 */
function nearSpawn(
  c: number,
  r: number,
  spawnCells: ReadonlyArray<readonly [number, number]>,
  reach: number,
): boolean {
  return spawnCells.some(([sc, sr]) => Math.abs(sc - c) <= reach && Math.abs(sr - r) <= reach);
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
  const k = blockScale(cellSize);

  const cells: string[][] = Array.from({ length: rows }, () => Array(cols).fill('.'));
  const player = scaleCell(PLAYER_CELL, k);
  const spawnCells: Array<readonly [number, number]> = [player];
  cells[player[1]][player[0]] = 'P';
  kinds.forEach((kind, i) => {
    if (kind === 'player') throw new Error('tanks= lists ENEMIES; the player is always present');
    const [c, r] = scaleCell(SANDBOX_ENEMY_ANCHORS[i], k);
    cells[r][c] = KIND_LETTER[kind];
    spawnCells.push([c, r]);
  });

  // Scatter walls: seeded shuffle of the eligible cells, then take placements one at a
  // time, skipping any that would seal a pocket. Refusing loudly beats returning fewer
  // than asked -- a silent cap reads as "the board has 12 walls" when it has 7.
  // A "wall" is one authored block (k x k of today's cells), not one cell: at k=3 a single
  // cell is 0.667 units against a 1.0 tank diameter, which is a pillar rather than the
  // cover this knob exists to place.
  const wanted = opts.walls ?? 0;
  if (wanted > 0) {
    let seed = opts.seed ?? 1;
    const candidates: Array<[number, number]> = [];
    for (let br = 0; br + k <= rows; br += k) {
      for (let bc = 0; bc + k <= cols; bc += k) {
        let free = true;
        for (let r = br; r < br + k && free; r++) {
          for (let c = bc; c < bc + k && free; c++) {
            if (cells[r][c] !== '.' || nearSpawn(c, r, spawnCells, k)) free = false;
          }
        }
        if (free) candidates.push([bc, br]);
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const draw = nextRng(seed);
      seed = draw.seed;
      const j = Math.floor(draw.value * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const paint = (bc: number, br: number, ch: string): void => {
      for (let r = br; r < br + k; r++) for (let c = bc; c < bc + k; c++) cells[r][c] = ch;
    };
    // A block may not touch one already placed. `loadArena` merges adjacent solid cells
    // into maximal rectangles, so two blocks side by side load as one wall and `walls=N`
    // quietly yields fewer than N entities; `levels.test.ts`'s "scatters the requested
    // walls" pins the count.
    const touchesPlaced = (bc: number, br: number): boolean => {
      for (let r = br - 1; r <= br + k; r++) {
        for (let c = bc - 1; c <= bc + k; c++) {
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          if (cells[r][c] === '#') return true;
        }
      }
      return false;
    };
    let placed = 0;
    for (const [bc, br] of candidates) {
      if (placed === wanted) break;
      if (touchesPlaced(bc, br)) continue;
      paint(bc, br, '#');
      if (fullyConnected(cells.map((row) => row.join('')), legend)) placed++;
      else paint(bc, br, '.');
    }
    if (placed < wanted) {
      throw new Error(`could only place ${placed} of ${wanted} walls without sealing a pocket`);
    }
  }

  return { cols, rows, cellSize, legend, grid: cells.map((row) => row.join('')) };
}

/**
 * Rules arrive as one `WorldRulesInit` object rather than trailing optional positionals
 * (issue #493), which made a caller naming the last one carry an `undefined` for each
 * before it. A rule added to `WorldRules` grows `WorldRulesInit` and no signature here.
 */
export function createSandboxWorld(opts: SandboxOptions, rules: WorldRulesInit = {}): World {
  const loaded = loadArena(sandboxArena(opts));
  const disarmed = opts.disarmed ?? true;
  if (disarmed) {
    for (const t of loaded.tanks) {
      if (t.kind !== 'player') t.disarmed = true;
    }
  }
  // `arenaGeometry` off `rules` for the same reason `createWorldFor` takes it off: it is a
  // `WorldRulesInit` key that `loadArena` derives, so a caller deriving rules from an
  // existing world would otherwise stamp that world's geometry onto this one.
  const worldRules: WorldRulesInit = { ...rules };
  delete worldRules.arenaGeometry;
  return createWorld({ ...loaded, ...worldRules, lives: LIVES, seed: opts.seed });
}
