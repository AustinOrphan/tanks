import type { Wall, Tank, Spawn, AABB, TankKind, WallKind } from './types';
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
    '........#..', // 5  bank-shot reflector: Teal's only route around the center block
    '..#.....#..', // 6
    '..#..P..#..', // 7  Player
    '...........', // 8
  ],
};

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

export function createArenaWorld(): World {
  return createWorld({ ...loadArena(ARENA_01), lives: LIVES });
}
