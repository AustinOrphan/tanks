import type {
  Wall, Tank, Spawn, AABB, TankKind, WallKind, UnarmedTrigger, GameMode, ArenaGeometry, BotDifficulty,
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

// Re-exported so `src/game/` keeps importing campaign identity from the same place
// it already imports arena identity (`ARENAS`/`arenaById`) -- see config/campaign.ts.
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
export const ARENA_04: Arena = arenaById('arena-04');
export const ARENAS: Arena[] = ARENA_DEFS;
// Re-exported (not just consumed above) so a CampaignLevel's arenaId -- a level's
// only pointer to its board, since #154 -- can be resolved from the same module
// `src/game/` already imports arena identity from. ARENA_DEFS carries `id`; the
// narrower `Arena` shape above deliberately does not, so a caller that needs an
// arena's id reaches for this rather than `ARENAS[i]`.
export { arenaById, ARENA_DEFS };

/**
 * The playable area, in world units. Derived from the same `cols * cellSize`
 * that `loadArena` lays the grid out with, so the two can never drift.
 *
 * Deliberately not measurable from the returned walls: `loadArena` rings the
 * arena with boundary walls one cell thick and outside play (see below), so
 * `max(wall.aabb.maxX)` overstates the arena by a cell in each axis. A renderer
 * that sizes and centres the ground from that reading draws the board
 * off-centre with its own boundary walls hanging over the void.
 */
export function arenaBounds(arena: Arena): { width: number; height: number } {
  return { width: arena.cols * arena.cellSize, height: arena.rows * arena.cellSize };
}

// `controlledBy` is trailing and optional so positional `makeTank(id, kind, pos, angle)`
// calls (PASS 1a, and fixtures across the tree) need not pass it. It is only stamped when
// passed, so a one-player load's tanks carry none (pinned in arena.test.ts) -- which is
// what full-object `toEqual` fixtures rely on.
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

/**
 * Which of the 2 alternating teams a player slot belongs to by default.
 * `teamOf(0) = 0` (P1), `teamOf(1) = 1`, `teamOf(2) = 0`, `teamOf(3) = 1` -- 2 teams,
 * alternating by slot. A configured split (uneven, or more than two teams) arrives through
 * loadArena's per-slot `teams` override instead (issue #281). Pure so a future netcode peer
 * can recompute it locally, same reasoning as findCoPlayerSpawnCell's own doc comment.
 */
export function teamOf(slot: number): number {
  return slot % 2;
}

// The 8 ring-search directions, cardinal before diagonal, E first: P2 conventionally
// spawns "to the right" of P1. (Δcol, Δrow).
const RING_DIRECTIONS: [number, number][] = [
  [1, 0], [0, 1], [-1, 0], [0, -1], // E, S, W, N
  [1, 1], [-1, 1], [1, -1], [-1, -1], // SE, SW, NE, NW
];

/**
 * Finds a spawn cell for co-player `index` (1-based additional player, P1 is index 0
 * and already placed), deterministic and pure so a future netcode peer can recompute
 * it locally without transmitting positions.
 *
 * `cellsNeeded` is the smallest integer cell-count whose center-to-center distance
 * clears two tank hulls without overlap: `ceil(2 * TANK_RADIUS / cellSize)`. Searches
 * rings at radius `cellsNeeded, 2x, 3x, 4x` (bounded, generous, not exhaustive), trying
 * the 8 RING_DIRECTIONS in order at each ring. A candidate is valid iff in-bounds,
 * `grid[row][col] === '.'` (open floor -- excludes solid, destructible and every other
 * spawn letter in one check), and not already claimed by an earlier co-player this call.
 *
 * Falls back to co-locating at P1's own cell if every ring exhausts: `separateTanks`
 * (world.ts) already runs every tick and already handles worse overlaps, so this is the
 * total, no-throw path -- a cramped custom/sandbox arena degrades instead of crashing.
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
 * Campaign-coop co-player placement: rings around P1 via findCoPlayerSpawnCell.
 *
 * A separate function rather than a shared body after the versus branch, because the
 * caller's `mode === 'ffa' || mode === 'teams'` check narrows `mode` to `'campaign-coop'`
 * there, and the `mode === 'teams'` line below would then fail to compile (TS2367). A
 * parameter is not narrowed by the caller's control flow -- the same reason world.ts keeps
 * resolveStatusFfa/resolveStatusTeams/resolveStatusCoop separate.
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
  // Default 'campaign-coop' is the shipped rule and the trace argument -- see
  // WorldRules.mode's own doc comment.
  mode: GameMode = 'campaign-coop',
  // Only meaningful with mode 'ffa'/'teams' (see below), where it picks a map variant.
  // campaign-coop never builds one, so neither it nor BASELINE_HASH (which only ever
  // drives campaign-coop) depends on this; a versus caller that omits it gets the
  // authored board unchanged, the same total-degradation posture pickVersusSpawnCell's
  // own zero-candidate fallback already takes.
  seed?: number,
  // Only stamped onto player tanks in 'ffa'/'teams' mode (both stamping sites below);
  // campaign-coop tanks never carry stockRemaining regardless of this value.
  stock: number = VERSUS_STOCK,
  // Per-slot team choice (issue #281). Indexed by slot, and sparse on purpose:
  // `undefined` at a slot means "no configured choice, derive it" by `teamOf(slot)`,
  // which is what lets a partially-configured setup and an unconfigured one take the
  // same path. Only read in `'teams'` mode; an `'ffa'` load never stamps `Tank.team` at
  // all (see its own doc comment in types.ts).
  teams?: readonly (number | undefined)[],
  // False (the default) stamps no `shellCap`/`mineCap`, so every tank resolves its roster
  // caps (issue #358).
  //
  // A boolean, not a table. The arm's values live in `config/pp1-roles.ts` so that changing
  // them is a one-line edit in one place; threading the table instead would give a caller a
  // way to invent an unapproved roster, which is exactly what the issue's "not permission to
  // retune every tank" note forbids.
  pp1Roles: boolean = false,
  // Indexed by slot in the same sparse way as `teams` (issue #891): `undefined` at a slot
  // is a human, a value is a computer opponent at that difficulty. Absent, no tank gains a
  // `botDifficulty` and `stepAi` skips every player-kind tank.
  //
  // Only stamped in 'ffa'/'teams'. A campaign-coop board has no bot-filled player slots: its
  // computer opponents are enemy-kind tanks, which already run committed targeting (#359).
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

  // Validation runs against the authored grid, always -- a variant only ever turns an
  // already-recognized destructible character into '.', so re-validating it would check
  // nothing new, and a bad authored grid should fail with a message naming the real
  // grid, not a derived one.
  //
  // Versus map variants (guard-first): campaign-coop, and any versus call that omits
  // `seed`, take the authored grid straight through. Only mode 'ffa'/'teams' with a seed
  // ever calls into versus-variants.ts. See
  // docs/superpowers/plans/2026-08-17-versus-map-variants.md for the design ruling and
  // the measured sweep DESTRUCTIBLE_REMOVAL_FRACTION was chosen from.
  let grid = arena.grid;
  if ((mode === 'ffa' || mode === 'teams') && seed !== undefined) {
    grid = pickVersusVariantGrid(grid, cols, rows, cellSize, legend, playerCount, seed);
  }

  const walls: Wall[] = [];
  const tanks: Tank[] = [];
  const spawns: Spawn[] = [];

  // PASS 1a — spawns. Tank ids must be a function of the spawn order alone: tank.id seeds
  // the per-tank RNG streams in ai/ (wanderMove, aimJitter and others), so an id that also
  // counted wall cells -- as a counter shared with walls would -- lets re-slicing the grid
  // silently reroll every enemy's behaviour for the whole game. At playerCount 1 this loop
  // is the entire function body relevant to spawns, and no controlledBy is stamped
  // (pinned by arena.test.ts).
  let id = 1;
  let p1Row = -1;
  let p1Col = -1;
  // Which `spawns` entry is P1's. Versus placement relocates it (PASS 1b) and must move
  // the SPAWN as well as the tank, since world.ts respawns from `spawns`.
  let p1SpawnIndex = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const kind = SPAWN_LETTERS[grid[r][c]];
      if (!kind) continue;
      // Versus modes strip every non-player spawn letter rather than repurposing it --
      // enemy letters are typed (brown/grey/teal/... each with its own weapon/behavior
      // via resolveTankConfig), so reusing one as a bonus player slot would silently
      // couple a versus session's player count to whatever roster each level's campaign
      // design happened to author.
      if (kind !== 'player' && mode !== 'campaign-coop') continue;
      const pos = { x: (c + 0.5) * cellSize, y: (r + 0.5) * cellSize };
      spawns.push({ kind, pos: { ...pos }, angle: 0 });
      const tank = makeTank(id++, kind, pos, 0);
      // Team is a player-only concept, stamped only in 'teams' mode -- see Tank.team's
      // own doc comment. P1 is always slot 0.
      if (kind === 'player' && mode === 'teams') tank.team = teams?.[0] ?? teamOf(0);
      // Stock is a player-only, versus-only concept -- see Tank.stockRemaining's own
      // doc comment. P1 is stamped here; PASS 1b's ffa/teams branch stamps every
      // co-player the same way.
      if (kind === 'player' && (mode === 'ffa' || mode === 'teams')) tank.stockRemaining = stock;
      // Bot-drivenness is a player-only, versus-only concept -- see Tank.botDifficulty's own
      // doc comment. P1 is slot 0 and is stamped here rather than in PASS 1b for the same
      // reason team is: that branch reaches P1 only to move its spawn position and never
      // rebuilds its tank, so a stamp placed only there would silently skip slot 0.
      if (kind === 'player' && (mode === 'ffa' || mode === 'teams')) {
        const bot = bots?.[0];
        if (bot !== undefined) tank.botDifficulty = bot;
      }
      tanks.push(tank);
      if (kind === 'player' && p1Row < 0) { p1Row = r; p1Col = c; p1SpawnIndex = spawns.length - 1; }
    }
  }

  // PASS 1b — additional players, only when playerCount > 1. Runs strictly after PASS 1a,
  // so every enemy's id (and therefore its seeded RNG stream) is identical between
  // playerCount 1 and >1 -- appending at the end, rather than interleaving at the P
  // cell, is what makes that true. Only wall ids (PASS 2, already after all tanks)
  // shift, which is harmless.
  if (playerCount > 1 && p1Row >= 0) {
    const p1Tank = tanks.find((t) => t.kind === 'player')!;
    p1Tank.controlledBy = 0;

    // Versus modes (ffa/teams) branch off before the ring search -- a guard-first split,
    // the same shape resolveStatus uses for its own mode dispatch (world.ts);
    // campaign-coop takes the else below. See versus-spawns.ts's module doc comment for
    // why a bounded ring around P1 is exactly wrong for FFA/teams: every player lands in
    // one small ring, in mutual point-blank line of sight.
    if (mode === 'ffa' || mode === 'teams') {
      // The whole set is chosen at once, P1 included -- a design ruling: versus is
      // symmetric, so no player may inherit the campaign author's `P` cell as a
      // privileged start. See pickVersusSpawnSet's own doc comment for the measured
      // case.
      //
      // P1's tank and spawn already exist, stamped at the authored `P` in PASS 1a, and
      // are relocated here rather than created here. That ordering is load-bearing:
      // ids are handed out in PASS 1a before this branch can run, so a versus load
      // numbers its tanks exactly as a one-player load does, and every per-tank RNG
      // stream keyed on `tank.id` (ai/targeting.ts) is unmoved. Moving P1's creation
      // into this branch would renumber them.
      const cells = pickVersusSpawnSet(grid, cols, rows, cellSize, legend, playerCount);
      for (let i = 0; i < playerCount; i++) {
        const pos = { x: (cells[i].col + 0.5) * cellSize, y: (cells[i].row + 0.5) * cellSize };
        if (i === 0) {
          // Both records move, not just the tank: `spawns` is what world.ts respawns
          // from, so leaving it on the `P` cell would put P1 back on the campaign start
          // after its first death while every other player respawned symmetrically.
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

  // The PP1 role-first ordnance arm (issue #358), stamped in one pass over every tank
  // rather than at each `makeTank`. There are three spawn sites in this file -- PASS 1a's
  // grid loop, the campaign co-op placer, and PASS 1b's versus branch -- and stamping at
  // each is how one gets missed: a co-player spawned by a site that forgot would carry the
  // roster's cap of 5 while P1 carried the arm's 4, which is an experiment measuring two
  // different rosters at once. Walking the finished list cannot miss one.
  //
  // A kind with no entry keeps its authored value even with the arm on, and the two tables
  // are consulted independently because their memberships differ. Yellow is in neither: it
  // is outside PP1, so a kind joining the campaign later is not silently opted into an
  // experiment nobody ran for it. Grey is in the shell table only -- its approved mine
  // direction is a placement policy rather than a capacity, so it takes the shell arm and
  // keeps its authored mine capacity.
  if (pp1Roles) {
    for (const tank of tanks) {
      const shells = PP1_ROLE_SHELL_CAPS[tank.kind];
      if (shells !== undefined) tank.shellCap = shells;
      const mines = PP1_ROLE_MINE_CAPS[tank.kind];
      if (mines !== undefined) tank.mineCap = mines;
    }
  }

  // Not `arena` itself: `Arena`'s shape happens to match `ArenaGeometry` field-for-field
  // today, but building the World-facing copy explicitly here means a future field added
  // to `Arena` for some other reason does not silently leak onto every World.
  return { walls, tanks, spawns, arenaGeometry: { cols, rows, cellSize, grid, legend } };
}

/**
 * Where a single-arena consumer should point. The gl harness sizes its board from
 * this; the game layer proper walks ARENAS. Kept as ARENAS[0] so "the first level"
 * and "the arena tools assume" cannot drift apart.
 */
export const CURRENT_ARENA: Arena = ARENAS[0];

/**
 * Everything a caller may say about the world beyond which arena and which seed
 * (issue #493). Every key optional; an absent key means the shipped default, chosen in
 * `loadArena` or `resolveWorldRules` and nowhere else.
 *
 * An object rather than a run of positionals, so a caller names only what it sets instead
 * of passing `undefined`s to reach a later argument, and a rule added to `WorldRules` grows
 * `WorldRulesInit` and nothing else.
 *
 * The rules nest rather than flattening into this object. `WorldRules` is a closed,
 * frozen set with one resolver, and `rules.ts` owns which keys are in it --
 * `WORLD_RULE_KEYS`'s `satisfies` is what makes a new rule a compile error at the one place
 * it is being added. Flattening would put `lives` and `mode` in one bag and lose that
 * boundary; nesting keeps `init.rules` assignable to `WorldRulesInit` and nothing else.
 *
 * `seed` stays positional. It is the one value nearly every caller passes, it reaches both
 * `loadArena` (it picks a versus variant) and `createWorld`, and `createWorldFor(arena, 7)`
 * is the shape most of the suite is written in.
 */
export interface WorldForInit {
  /** Starting lives. Defaults to `LIVES`; how a cleared level's remaining lives carry in. */
  lives?: number;
  /** How many player tanks the board is loaded for. Defaults to 1. */
  playerCount?: number;
  /** Versus stock per player. Defaults to `loadArena`'s `VERSUS_STOCK`; ignored outside 'ffa'/'teams'. */
  stock?: number;
  /** Per-slot team override. Defaults to `loadArena`'s `teamOf(slot)`; only meaningful under 'teams'. */
  teams?: readonly (number | undefined)[];
  /** Stamp the approved PP1 per-role ordnance caps. Absent leaves the roster's own in force. */
  pp1Roles?: boolean;
  /**
   * Per-slot bot difficulty (issue #891). A slot carrying a value is filled by a computer
   * opponent at that difficulty; `undefined` is a human. Sparse and indexed by slot, exactly
   * like `teams`. Ignored outside 'ffa'/'teams'.
   */
  bots?: readonly (BotDifficulty | undefined)[];
  /** Everything `World.rules` carries. See `WorldRulesInit` in rules.ts. */
  rules?: WorldRulesInit;
}

/**
 * Build a playable world from any arena. The progression's per-level constructor;
 * `init.lives` is how a cleared level's remaining lives carry into the next one.
 */
export function createWorldFor(arena: Arena, seed?: number, init: WorldForInit = {}): World {
  const { lives = LIVES, playerCount = 1, stock, teams, pp1Roles, bots, rules = {} } = init;
  // `arenaGeometry` is a `WorldRulesInit` key and also the one rule `loadArena` derives, so
  // it is taken off `rules` here rather than left to the spread below. A caller passing
  // `rules: { ...world.rules }` -- which is the documented way to derive a variant, and
  // exactly what a versus rematch would reach for -- otherwise overwrites the geometry of the
  // board just loaded with the geometry of the board it came from.
  const worldRules: WorldRulesInit = { ...rules };
  delete worldRules.arenaGeometry;
  // `seed` reaches loadArena too, not just createWorld below -- it is what picks a
  // versus variant (guard-first on mode 'ffa'/'teams' inside loadArena itself; every
  // campaign-coop call, which is every call that does not set a mode, is unaffected).
  // Reusing the same seed a versus session already carries (rather than a second
  // variant-only seed) is what makes a recorded replay's own stamped seed
  // (replayMetaFor, game/replay.ts) enough to reproduce the exact board it was played
  // on, with no extra field.
  //
  // `rules.mode` is read out for loadArena (so versus modes strip enemies and stamp
  // team) and also reaches createWorld through the spread (so `World.rules.mode` matches
  // what was actually built).
  return createWorld({
    ...loadArena(arena, playerCount, rules.mode, seed, stock, teams, pp1Roles, bots),
    ...worldRules,
    lives,
    seed,
  });
}

/**
 * `seed` drives every random draw in the sim (AI wander headings, aim jitter).
 * It is a parameter rather than a constant because a fixed seed made every
 * playthrough byte-identical, with the enemies walking the same paths and missing
 * by the same angles forever. The game layer passes a fresh one per session; tests
 * omit it and get the reproducible default.
 *
 * Kept at its old one-arena signature: dozens of tests (and the pacifist suite's
 * headline metric) mean "level 1" when they say createArenaWorld.
 */
export function createArenaWorld(seed?: number, unarmedTrigger?: UnarmedTrigger): World {
  return createWorldFor(ARENAS[0], seed, { rules: { unarmedTrigger } });
}
