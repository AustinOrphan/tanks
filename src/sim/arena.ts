import type { Wall, Tank, Spawn, AABB, TankKind, WallKind, UnarmedTrigger } from './types';
import { createWorld, type World } from './world';
import { LIVES } from './constants';

export interface Arena {
  cols: number;
  rows: number;
  cellSize: number;
  grid: string[];
  legend: Record<string, WallKind>;
}

// Hand-designed slice arena. Player at the bottom (row 7), a Brown + Grey + Teal
// across the top (rows 2-3). The center solid block at (col 5, row 4) sits directly
// on the Teal->player line, so Teal must bank a ricochet off a side wall. Flanking
// destructibles ('x') can be blown open by mines to create new lines of fire.
// The solid cell at (col 8, row 5) is the bank-shot reflector: it sits just past
// the center block's east edge and just north of the col-8 side walls, so a shell
// from Teal (11,7) can clear the center block through the (12,16) gap at row 4,
// bank off that cell's west face at (16,11), and reach the player (11,15) through
// the same gap at rows 6-7 without touching any other wall. See
// arena.test.ts's "affords Teal a real single-bounce bank shot" test.
//
// Cover depth (col 5, row 5): Brown (9,5) and Grey (13,5) sit symmetrically about the
// player's x=11, and the row-4 block alone (x:[10,12], y:[8,10]) put both of their direct
// lines to the player spawn (11,15) exactly tangent to its corners -- (10,10) for Brown,
// (12,10) for Grey -- a single-point knife edge where a 0.1-unit nudge in either x
// direction gave ONE of them a fully clear 10-unit lane (see task-balance-report.md).
// Stacking a second solid cell directly below it at (col 5, row 5) extends the block to
// y:[8,12], turning that corner-graze into a real chord through the box for both lines
// (verified by direct search over player-position perturbations, not by hand-argued
// geometry -- see the coverOk check in the report). It does not touch column 6/7 at
// row 4 or row 5, so Teal's bank-shot corridor (through the row-4 gap, off the (8,5)
// reflector, back down through rows 6-7) is untouched.
//        col: 0123456789A   (A = 10)
export const ARENA_01: Arena = {
  cols: 11,
  rows: 9,
  cellSize: 2,
  legend: { '#': 'solid', x: 'destructible' },
  grid: [
    '...........', // 0
    '..#.....#..', // 1
    '..#.B.G.#..', // 2  Brown, Grey
    '.....T.....', // 3  Teal
    '..x..#..x..', // 4  center cover + flanking destructibles
    '.....#..#..', // 5  cover depth (col 5) + bank-shot reflector (col 8)
    '..#.....#..', // 6
    '..#..P..#..', // 7  Player
    '...........', // 8
  ],
};

// Level 2. Two horizontal bars split the field into an upper enemy half and a lower
// player half, with a tall centre spine forcing engagements around its ends. Every
// enemy's straight line to the player spawn is blocked -- arena-validation.test.ts
// checks that with the sim's own lineOfSight. For the UPPER pair (Brown at row 2, Grey
// at row 2) the only block is the DESTRUCTIBLE inner end of a bar ('x'), so blowing one
// open is a real trade that opens the lane for both sides; the LOWER pair (Brown and
// Teal at row 3) stays blocked by the bars' solid outer ends whatever is destroyed.
// Measured, not argued: destroying both x's opens exactly the two upper lanes (see the
// "destructible trade" test in arena-validation.test.ts). Four enemies against level
// 1's three: two Browns anchoring the left, Grey and Teal roaming the right.
export const ARENA_02: Arena = {
  cols: 11,
  rows: 9,
  cellSize: 2,
  legend: { '#': 'solid', x: 'destructible' },
  grid: [
    '...........', // 0
    '...........', // 1
    '.B...#...G.', // 2
    '.B...#...T.', // 3
    '.#x..#..x#.', // 4  bars: solid outer ends, destructible inner ends
    '.....#.....', // 5
    '..#.....#..', // 6  the player's flank guards, as in level 1
    '.....P.....', // 7
    '...........', // 8
  ],
};

/**
 * The shipped sequence, in play order. The game layer walks this list; the sim never
 * knows a level number. Every entry is structurally validated by
 * arena-validation.test.ts (connectivity, spawn sightlines, dimensions), so adding a
 * level here is what makes it real -- and what makes it checked.
 */
export const ARENAS: Arena[] = [ARENA_01, ARENA_02];

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

const SPAWN_KINDS: Record<string, TankKind> = {
  P: 'player',
  B: 'brown',
  G: 'grey',
  T: 'teal',
};

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
      if (ch !== '.' && !legend[ch] && !SPAWN_KINDS[ch]) {
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
      } else if (SPAWN_KINDS[ch]) {
        const kind = SPAWN_KINDS[ch];
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
