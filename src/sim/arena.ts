import type {
  Wall, Tank, Spawn, AABB, TankKind, WallKind, GameMode, ArenaGeometry, BotDifficulty,
} from './types';
import { createWorld, type World } from './world';
import type { WorldRulesInit } from './rules';
import { LIVES, TANK_RADIUS, VERSUS_STOCK } from './constants';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { PP1_ROLE_SHELL_CAPS, PP1_ROLE_MINE_CAPS } from './config/pp1-roles';
import { SPAWN_LETTERS } from './config/arena-types';
import {
  CAMPAIGN,
  CAMPAIGN_LEVELS,
  campaignLevelById,
  FIRST_CAMPAIGN_LEVEL,
} from './config/campaign';
import type { CampaignDefinition, CampaignLevel } from './config/campaign-types';
import { pickVersusSpawnSet } from './versus-spawns';
import { pickVersusVariantGrid } from './versus-variants';
import { mergeSolidRuns } from './wall-merge';

// Re-exported so `src/game/` imports campaign identity from where it imports arena identity.
export { CAMPAIGN, CAMPAIGN_LEVELS, campaignLevelById, FIRST_CAMPAIGN_LEVEL };
export type { CampaignDefinition, CampaignLevel };

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
// Re-exported so `src/game/` resolves a level's arenaId from where it imports arena identity.
export { arenaById, ARENA_DEFS };

/**
 * The playable area, in world units. Not measurable from `loadArena`'s walls: its boundary
 * walls sit one cell outside play, so `max(wall.aabb.maxX)` overstates the arena by a cell in
 * each axis, and a renderer centring the ground on that reading draws the board off-centre.
 */
export function arenaBounds(arena: Arena): { width: number; height: number } {
  return { width: arena.cols * arena.cellSize, height: arena.rows * arena.cellSize };
}

// A one-player load's tanks carry no `controlledBy` (pinned in arena.test.ts).
export function makeTank(
  id: number,
  kind: TankKind,
  pos: { x: number; y: number },
  angle: number,
  controlledBy?: number,
): Tank {
  const tank: Tank = {
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
  if (controlledBy !== undefined) tank.controlledBy = controlledBy;
  return tank;
}

/** Default only: an uneven or more-than-two-team split arrives through `teams` (issue #281). */
export function teamOf(slot: number): number {
  return slot % 2;
}

// [Δcol, Δrow], cardinal before diagonal, E first: P2 conventionally spawns "to the right" of P1.
const RING_DIRECTIONS: [number, number][] = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

/**
 * Falls back to P1's own cell when no ring has a free cell: `stepMovement` (world.ts)
 * separates overlapping tanks every tick, so a cramped arena degrades instead of throwing.
 */
function findCoPlayerSpawnCell(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  p1Row: number,
  p1Col: number,
  claimed: Set<string>,
): { row: number; col: number } {
  const cellsNeeded = Math.ceil((2 * TANK_RADIUS) / cellSize);
  for (let ring = 1; ring <= 4; ring++) {
    const dist = ring * cellsNeeded;
    for (const [dCol, dRow] of RING_DIRECTIONS) {
      const row = p1Row + dRow * dist;
      const col = p1Col + dCol * dist;
      if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
      if (grid[row][col] !== '.') continue;
      const key = `${row},${col}`;
      if (claimed.has(key)) continue;
      return { row, col };
    }
  }
  return { row: p1Row, col: p1Col };
}

/**
 * A function rather than inline in loadArena's else branch: there `mode` is narrowed to
 * `'campaign-coop'`, and the `mode === 'teams'` line below would fail to compile (TS2367).
 */
function placeCampaignCoPlayers(
  grid: string[],
  cols: number,
  rows: number,
  cellSize: number,
  p1Row: number,
  p1Col: number,
  playerCount: number,
  mode: GameMode,
  tanks: Tank[],
  spawns: Spawn[],
  id: number,
): number {
  const claimed = new Set<string>([`${p1Row},${p1Col}`]);
  for (let i = 1; i < playerCount; i++) {
    const cell = findCoPlayerSpawnCell(grid, cols, rows, cellSize, p1Row, p1Col, claimed);
    claimed.add(`${cell.row},${cell.col}`);
    const pos = { x: (cell.col + 0.5) * cellSize, y: (cell.row + 0.5) * cellSize };
    spawns.push({ kind: 'player', pos: { ...pos }, angle: 0 });
    const tank = makeTank(id++, 'player', pos, 0, i);
    if (mode === 'teams') tank.team = teamOf(i);
    tanks.push(tank);
  }
  return id;
}

export function loadArena(
  arena: Arena,
  playerCount: number = 1,
  // Must match resolveWorldRules' default (rules.ts): createWorldFor passes an absent mode
  // to both.
  mode: GameMode = 'campaign-coop',
  // Picks a versus map variant. campaign-coop ignores it here, so a variant cannot move
  // BASELINE_HASH; a versus load without it gets the authored board.
  seed?: number,
  // Ignored outside 'ffa'/'teams'.
  stock: number = VERSUS_STOCK,
  // Per slot, sparse: `undefined` falls back to `teamOf(slot)`, so a partial setup and an
  // unconfigured one take the same path. Read only in 'teams' mode.
  teams?: readonly (number | undefined)[],
  // A boolean, not a table: threading the caps would let a caller invent an unapproved
  // roster, which issue #358 forbids.
  pp1Roles: boolean = false,
  // Per slot, sparse like `teams`: `undefined` is a human, a value a bot at that difficulty.
  // Ignored outside 'ffa'/'teams'; campaign-coop's computer opponents are enemy-kind tanks.
  bots?: readonly (BotDifficulty | undefined)[],
): { walls: Wall[]; tanks: Tank[]; spawns: Spawn[]; arenaGeometry: ArenaGeometry } {
  const { cols, rows, cellSize, legend } = arena;

  if (arena.grid.length !== rows) {
    throw new Error(`Grid has ${arena.grid.length} rows but Arena declares ${rows} rows`);
  }

  for (let r = 0; r < rows; r++) {
    const row = arena.grid[r];
    if (row.length !== cols) {
      throw new Error(`Row ${r} has length ${row.length} but Arena declares ${cols} columns`);
    }
  }

  for (let r = 0; r < rows; r++) {
    const row = arena.grid[r];
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      if (ch !== '.' && !legend[ch] && !SPAWN_LETTERS[ch]) {
        throw new Error(`Unrecognized character '${ch}' at (row ${r}, col ${c})`);
      }
    }
  }

  // Validation above runs on the authored grid only: a variant only turns recognized
  // destructible cells into '.', so re-validating would check nothing new, and a bad grid
  // should fail naming the real grid.
  let grid = arena.grid;
  if ((mode === 'ffa' || mode === 'teams') && seed !== undefined) {
    grid = pickVersusVariantGrid(grid, cols, rows, cellSize, legend, playerCount, seed);
  }

  const walls: Wall[] = [];
  const tanks: Tank[] = [];
  const spawns: Spawn[] = [];

  // PASS 1a — spawns. Tank ids must depend on spawn order alone: tank.id seeds the per-tank
  // RNG streams in ai/, so an id that also counted wall cells would let re-slicing the grid
  // reroll every enemy's behaviour.
  let id = 1;
  let p1Row = -1;
  let p1Col = -1;
  let p1SpawnIndex = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kind = SPAWN_LETTERS[grid[r][c]];
      if (!kind) continue;
      // Versus drops enemy spawn letters rather than reusing them as player slots, which
      // would tie a session's player count to each level's authored campaign roster.
      if (kind !== 'player' && mode !== 'campaign-coop') continue;
      const pos = { x: (c + 0.5) * cellSize, y: (r + 0.5) * cellSize };
      spawns.push({ kind, pos: { ...pos }, angle: 0 });
      const tank = makeTank(id++, kind, pos, 0);
      // P1 (slot 0) is stamped here, not in PASS 1b: that branch only relocates P1 and never
      // rebuilds its tank. PASS 1b stamps every co-player the same way.
      if (kind === 'player' && mode === 'teams') tank.team = teams?.[0] ?? teamOf(0);
      if (kind === 'player' && (mode === 'ffa' || mode === 'teams')) tank.stockRemaining = stock;
      if (kind === 'player' && (mode === 'ffa' || mode === 'teams')) {
        const bot = bots?.[0];
        if (bot !== undefined) tank.botDifficulty = bot;
      }
      tanks.push(tank);
      if (kind === 'player' && p1Row < 0) { p1Row = r; p1Col = c; p1SpawnIndex = spawns.length - 1; }
    }
  }

  // PASS 1b — additional players, appended after PASS 1a rather than interleaved at the P
  // cell, so every enemy's id (and seeded RNG stream) matches a one-player load. Only wall
  // ids shift, which is harmless.
  if (playerCount > 1 && p1Row >= 0) {
    const p1Tank = tanks.find((t) => t.kind === 'player')!;
    p1Tank.controlledBy = 0;

    // Versus skips the ring search, which would put every player in one small ring in
    // mutual point-blank line of sight (see versus-spawns.ts's module doc).
    if (mode === 'ffa' || mode === 'teams') {
      // The whole set is chosen at once, P1 included -- a design ruling: versus is
      // symmetric, so no player may keep the campaign's `P` cell as a privileged start.
      //
      // P1 is relocated here, not created here: creating it in this branch would renumber
      // the tanks, and with them every RNG stream keyed on `tank.id`.
      const cells = pickVersusSpawnSet(grid, cols, rows, cellSize, legend, playerCount);
      for (let i = 0; i < playerCount; i++) {
        const pos = { x: (cells[i].col + 0.5) * cellSize, y: (cells[i].row + 0.5) * cellSize };
        if (i === 0) {
          // The spawn moves too: world.ts respawns from `spawns`, so P1 would otherwise
          // respawn on the campaign's `P` cell.
          p1Tank.pos = { ...pos };
          spawns[p1SpawnIndex].pos = { ...pos };
          continue;
        }
        spawns.push({ kind: 'player', pos: { ...pos }, angle: 0 });
        const tank = makeTank(id++, 'player', pos, 0, i);
        if (mode === 'teams') tank.team = teams?.[i] ?? teamOf(i);
        tank.stockRemaining = stock;
        const bot = bots?.[i];
        if (bot !== undefined) tank.botDifficulty = bot;
        tanks.push(tank);
      }
    } else {
      id = placeCampaignCoPlayers(grid, cols, rows, cellSize, p1Row, p1Col, playerCount, mode, tanks, spawns, id);
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

  // Boundary walls outside play, so reflectSweep bounces shells off the edges with no
  // map-escape special case.
  const W = cols * cellSize;
  const H = rows * cellSize;
  const t = cellSize;
  const boundaries: AABB[] = [
    { minX: -t, minY: -t, maxX: W + t, maxY: 0 },
    { minX: -t, minY: H, maxX: W + t, maxY: H + t },
    { minX: -t, minY: 0, maxX: 0, maxY: H },
    { minX: W, minY: 0, maxX: W + t, maxY: H },
  ];
  for (const aabb of boundaries) {
    walls.push({ id: id++, aabb, kind: 'solid', destroyed: false });
  }

  // PP1 caps (issue #358) are stamped over the finished list, not at each of the three spawn
  // sites, so no co-player can miss them and run a different roster from P1.
  if (pp1Roles) {
    for (const tank of tanks) {
      const shells = PP1_ROLE_SHELL_CAPS[tank.kind];
      if (shells !== undefined) tank.shellCap = shells;
      const mines = PP1_ROLE_MINE_CAPS[tank.kind];
      if (mines !== undefined) tank.mineCap = mines;
    }
  }

  // Not `arena` itself, so a field later added to `Arena` does not leak onto every World.
  return { walls, tanks, spawns, arenaGeometry: { cols, rows, cellSize, grid, legend } };
}

/**
 * `rules` nests rather than flattening in, so a new rule is added in rules.ts and never
 * touches this interface. `seed` stays positional: nearly every caller passes it, and
 * `createWorldFor(arena, 7)` is the shape most of the suite is written in.
 */
export interface WorldForInit {
  lives?: number;
  playerCount?: number;
  stock?: number;
  teams?: readonly (number | undefined)[];
  pp1Roles?: boolean;
  bots?: readonly (BotDifficulty | undefined)[];
  rules?: WorldRulesInit;
}

/**
 * The progression's per-level constructor: `init.lives` is how a cleared level's remaining
 * lives carry into the next one.
 */
export function createWorldFor(arena: Arena, seed?: number, init: WorldForInit = {}): World {
  const { lives = LIVES, playerCount = 1, stock, teams, pp1Roles, bots, rules = {} } = init;
  // `loadArena` derives `arenaGeometry`, so it is dropped from `rules`: a caller passing
  // `rules: { ...world.rules }`, as a versus rematch would, otherwise overwrites the geometry
  // of the board just loaded with that of the board it came from.
  const worldRules: WorldRulesInit = { ...rules };
  delete worldRules.arenaGeometry;
  // One seed for the versus variant and the world, not a second variant-only seed, so a
  // replay's stamped seed (replayMetaFor, game/replay.ts) reproduces the board it was
  // played on.
  return createWorld({
    ...loadArena(arena, playerCount, rules.mode, seed, stock, teams, pp1Roles, bots),
    ...worldRules,
    lives,
    seed,
  });
}

