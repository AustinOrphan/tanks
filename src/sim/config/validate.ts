import type { TankKind, WallKind } from '../types';
import {
  AIBehavior,
  AIProfile,
  FireRate,
  MovementSpeed,
  ProjectileType,
  RotationSpeed,
  TankAbility,
} from './enums';
import type { AIProfileBalance, TankDefinition } from './types';
import type { ArenaClaim, ArenaDefinition, ArenaShape } from './arena-types';
import { SPAWN_LETTERS } from './arena-types';
import type { CampaignDefinition, CampaignLevel } from './campaign-types';
import type { VersusCatalogEntry } from './versus-catalog-types';
import { VERSUS_MODES, VERSUS_PLAYER_COUNTS, VERSUS_SPAWN_POLICIES, VERSUS_VARIANT_KINDS } from './versus-catalog-types';

// ---------------------------------------------------------------------------
// Runtime validation for the JSON entity data (data/tank-defs.json,
// data/ai-profiles.json).
//
// JSON enters through `as`-free `unknown` and leaves fully typed, or the module
// throws AT LOAD -- a bad edit is a boot failure naming the exact path, never a
// silently-undefined stat downstream. This is the trade for moving the tables
// out of TypeScript: the compiler checked enum membership and key completeness
// for free; this module re-checks them at runtime, and its own tests carry the
// negative controls that prove each check can actually fail
// (validate.test.ts -- a guard is worth what its own tests prove).
// ---------------------------------------------------------------------------

/**
 * The canonical runtime list of tank kinds. `satisfies` keeps every entry a
 * real TankKind; the MissingKind check below makes ADDING a TankKind member
 * without listing it here a COMPILE error that names the missing kind -- this
 * is where the old "a 5th TankKind must be a compile error in the roster"
 * guard lives now that the roster is JSON.
 */
export const TANK_KINDS = ['player', 'brown', 'grey', 'teal', 'olive', 'green', 'yellow'] as const satisfies readonly TankKind[];
type MissingKind = Exclude<TankKind, (typeof TANK_KINDS)[number]>;
const _tankKindsExhaustive: MissingKind extends never ? true : MissingKind = true;
void _tankKindsExhaustive;

function fail(file: string, path: string, message: string): never {
  throw new Error(`${file}: ${path} ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(file: string, path: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(file, path, `must be a finite number, got ${JSON.stringify(v)}`);
  return v;
}

/** Counts (caps, bounce budgets, mission numbers): whole and non-negative. */
function nonNegInt(file: string, path: string, v: unknown): number {
  const n = num(file, path, v);
  if (!Number.isInteger(n) || n < 0) fail(file, path, `must be a non-negative integer, got ${n}`);
  return n;
}

/** Durations in seconds: finite and never negative, but genuinely unbounded above. */
function nonNegative(file: string, path: string, v: unknown): number {
  const n = num(file, path, v);
  if (n < 0) fail(file, path, `must be non-negative, got ${n}`);
  return n;
}

/** Chances, accuracies and weights: the sim reasons about these as [0, 1]. */
function unitInterval(file: string, path: string, v: unknown): number {
  const n = num(file, path, v);
  if (n < 0 || n > 1) fail(file, path, `must be within [0, 1], got ${n}`);
  return n;
}

/** As unitInterval but excluding 0 -- for values the sim divides by. */
function positiveUnitInterval(file: string, path: string, v: unknown): number {
  const n = unitInterval(file, path, v);
  if (n === 0) fail(file, path, `must be strictly positive (the sim divides by it)`);
  return n;
}

function str(file: string, path: string, v: unknown): string {
  if (typeof v !== 'string') fail(file, path, `must be a string, got ${JSON.stringify(v)}`);
  return v;
}

function bool(file: string, path: string, v: unknown): boolean {
  if (typeof v !== 'boolean') fail(file, path, `must be a boolean, got ${JSON.stringify(v)}`);
  return v;
}

function oneOf<E extends string>(file: string, path: string, v: unknown, values: readonly E[], label: string): E {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    fail(file, path, `${JSON.stringify(v)} is not a ${label} (expected one of ${values.join(', ')})`);
  }
  return v as E;
}

/** #RRGGBB only: the renderer parses exactly this shape (entities.ts cssHex). */
function cssHexColor(file: string, path: string, v: unknown): string {
  const s = str(file, path, v);
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) fail(file, path, `${JSON.stringify(s)} is not a #RRGGBB colour`);
  return s;
}

/** The exact key set: every expected key present, no unknown keys. */
function exactKeys(file: string, path: string, obj: Record<string, unknown>, expected: readonly string[]): void {
  for (const k of expected) {
    if (!(k in obj)) fail(file, path, `is missing required entry "${k}"`);
  }
  for (const k of Object.keys(obj)) {
    if (!expected.includes(k)) fail(file, path, `has unknown entry "${k}"`);
  }
}

const DEFINITION_FIELDS = [
  'displayName', 'color', 'firstMission', 'singlePlayerOnly', 'movementSpeed',
  'rotationSpeed', 'aiProfile', 'weapon', 'mineCapacity', 'abilities',
] as const;
const WEAPON_FIELDS = ['projectileType', 'fireRate', 'maxActiveProjectiles', 'ricochetCount'] as const;

export function validateTankDefinitions(raw: unknown, file = 'tank-defs.json'): Record<TankKind, TankDefinition> {
  if (!isRecord(raw)) fail(file, 'root', 'must be an object keyed by tank kind');
  exactKeys(file, 'root', raw, TANK_KINDS);

  const out = {} as Record<TankKind, TankDefinition>;
  for (const kind of TANK_KINDS) {
    const d = raw[kind];
    if (!isRecord(d)) fail(file, kind, 'must be an object');
    exactKeys(file, kind, d, DEFINITION_FIELDS);
    const w = d.weapon;
    if (!isRecord(w)) fail(file, `${kind}.weapon`, 'must be an object');
    exactKeys(file, `${kind}.weapon`, w, WEAPON_FIELDS);
    if (!Array.isArray(d.abilities)) fail(file, `${kind}.abilities`, 'must be an array');

    out[kind] = {
      displayName: str(file, `${kind}.displayName`, d.displayName),
      color: cssHexColor(file, `${kind}.color`, d.color),
      firstMission: nonNegInt(file, `${kind}.firstMission`, d.firstMission),
      singlePlayerOnly: bool(file, `${kind}.singlePlayerOnly`, d.singlePlayerOnly),
      movementSpeed: oneOf(file, `${kind}.movementSpeed`, d.movementSpeed, Object.values(MovementSpeed), 'MovementSpeed'),
      rotationSpeed: oneOf(file, `${kind}.rotationSpeed`, d.rotationSpeed, Object.values(RotationSpeed), 'RotationSpeed'),
      aiProfile: oneOf(file, `${kind}.aiProfile`, d.aiProfile, Object.values(AIProfile), 'AIProfile'),
      weapon: {
        projectileType: oneOf(file, `${kind}.weapon.projectileType`, w.projectileType, Object.values(ProjectileType), 'ProjectileType'),
        fireRate: oneOf(file, `${kind}.weapon.fireRate`, w.fireRate, Object.values(FireRate), 'FireRate'),
        maxActiveProjectiles: nonNegInt(file, `${kind}.weapon.maxActiveProjectiles`, w.maxActiveProjectiles),
        ricochetCount: nonNegInt(file, `${kind}.weapon.ricochetCount`, w.ricochetCount),
      },
      mineCapacity: nonNegInt(file, `${kind}.mineCapacity`, d.mineCapacity),
      abilities: d.abilities.map((a, i) =>
        oneOf(file, `${kind}.abilities[${i}]`, a, Object.values(TankAbility), 'TankAbility'),
      ),
    };
  }
  return out;
}

const PROFILE_FIELDS = [
  'behavior', 'aimAccuracy', 'estimationAccuracy', 'reactionTime', 'commitmentTime', 'aimHoldTime', 'shotCommitmentTime', 'aggression', 'preferredDistance',
  'minimumDistance', 'retreatChance', 'directShotWeight', 'bankShotWeight',
] as const;
const PROFILE_OPTIONAL_FIELDS = ['minePlacementChance'] as const;

export function validateAiProfiles(raw: unknown, file = 'ai-profiles.json'): Record<AIProfile, AIProfileBalance> {
  if (!isRecord(raw)) fail(file, 'root', 'must be an object keyed by AIProfile');
  exactKeys(file, 'root', raw, Object.values(AIProfile));

  const out = {} as Record<AIProfile, AIProfileBalance>;
  for (const profile of Object.values(AIProfile)) {
    const p = raw[profile];
    if (!isRecord(p)) fail(file, profile, 'must be an object');
    for (const k of PROFILE_FIELDS) {
      if (!(k in p)) fail(file, profile, `is missing required entry "${k}"`);
    }
    for (const k of Object.keys(p)) {
      if (!(PROFILE_FIELDS as readonly string[]).includes(k) && !(PROFILE_OPTIONAL_FIELDS as readonly string[]).includes(k)) {
        fail(file, profile, `has unknown entry "${k}"`);
      }
    }
    // Accuracies, chances and weights are [0, 1] by meaning -- grey's patience
    // formula (1 - aggression) * TICK_HZ goes NEGATIVE for aggression > 1, so
    // the range check is load-bearing, not pedantry. reactionTime (seconds) and
    // the two distances (world units) are genuinely unbounded above.
    const resolved: AIProfileBalance = {
      behavior: oneOf(file, `${profile}.behavior`, p.behavior, Object.values(AIBehavior), 'AIBehavior'),
      // Strictly positive: profileAimSpread divides by this, and 0 -- which the
      // plain [0,1] check admits -- would make the spread Infinity. Contained
      // downstream (slewAngle's non-finite sink freezes the turret) but a
      // degenerate config should die at load, not limp (review, PR #57).
      aimAccuracy: positiveUnitInterval(file, `${profile}.aimAccuracy`, p.aimAccuracy),
      // Strictly positive for the same reason as aimAccuracy: profileHazardSpread divides
      // by it (targeting.ts), and 0 would make the spread Infinity.
      estimationAccuracy: positiveUnitInterval(file, `${profile}.estimationAccuracy`, p.estimationAccuracy),
      reactionTime: num(file, `${profile}.reactionTime`, p.reactionTime),
      // Non-negative, not merely numeric: commitMove re-arms its window to
      // Math.round(commitmentTime * TICK_HZ), and a negative value would re-arm to a
      // negative countdown -- which never satisfies `ticks > 0`, silently disabling the
      // commitment for that profile instead of failing loudly at load.
      commitmentTime: nonNegative(file, `${profile}.commitmentTime`, p.commitmentTime),
      // Same reason commitmentTime is guarded: holdAimFor re-arms to
      // Math.round(aimHoldTime * TICK_HZ), and a negative span would re-arm to a negative
      // countdown that never reaches zero -- an aim frozen for the rest of the round.
      aimHoldTime: nonNegative(file, `${profile}.aimHoldTime`, p.aimHoldTime),
      // Same reason again: tealDecision re-arms to Math.round(shotCommitmentTime * TICK_HZ),
      // and a negative span would re-arm to a negative countdown that is already lapsed.
      shotCommitmentTime: nonNegative(file, `${profile}.shotCommitmentTime`, p.shotCommitmentTime),
      aggression: unitInterval(file, `${profile}.aggression`, p.aggression),
      preferredDistance: num(file, `${profile}.preferredDistance`, p.preferredDistance),
      minimumDistance: num(file, `${profile}.minimumDistance`, p.minimumDistance),
      retreatChance: unitInterval(file, `${profile}.retreatChance`, p.retreatChance),
      directShotWeight: unitInterval(file, `${profile}.directShotWeight`, p.directShotWeight),
      bankShotWeight: unitInterval(file, `${profile}.bankShotWeight`, p.bankShotWeight),
    };
    if ('minePlacementChance' in p) {
      resolved.minePlacementChance = unitInterval(file, `${profile}.minePlacementChance`, p.minePlacementChance);
    }
    out[profile] = resolved;
  }
  return out;
}

const SHAPE_FIELDS = ['cols', 'rows', 'cellSize', 'legend', 'grid'] as const;
const DEFINITION_ARENA_FIELDS = [...SHAPE_FIELDS, 'id', 'notes', 'claims'] as const;
const WALL_KINDS = ['solid', 'destructible'] as const;

function posInt(file: string, path: string, v: unknown): number {
  const n = nonNegInt(file, path, v);
  if (n === 0) fail(file, path, 'must be greater than zero');
  return n;
}

/**
 * The geometry half: dimensions, legend, grid, spawn counts. Split out from
 * validateArenas so the SANDBOX -- which generates a bare Arena programmatically
 * and has no id/notes/claims -- can be held to the same structural bar.
 */
export function validateArenaShape(raw: unknown, file: string, path: string): ArenaShape {
  if (!isRecord(raw)) fail(file, path, 'must be an object');
  const cols = posInt(file, `${path}.cols`, raw.cols);
  const rows = posInt(file, `${path}.rows`, raw.rows);
  const cellSize = num(file, `${path}.cellSize`, raw.cellSize);
  if (cellSize <= 0) fail(file, `${path}.cellSize`, 'must be greater than zero');

  if (!isRecord(raw.legend)) fail(file, `${path}.legend`, 'must be an object');
  const legend: Record<string, WallKind> = {};
  for (const [ch, kind] of Object.entries(raw.legend)) {
    if (ch.length !== 1) fail(file, `${path}.legend["${ch}"]`, 'key must be a single character');
    if (ch === '.' || ch in SPAWN_LETTERS) {
      fail(file, `${path}.legend["${ch}"]`, 'collides with floor or a spawn letter');
    }
    legend[ch] = oneOf(file, `${path}.legend["${ch}"]`, kind, WALL_KINDS, 'WallKind');
  }

  if (!Array.isArray(raw.grid)) fail(file, `${path}.grid`, 'must be an array of strings');
  if (raw.grid.length !== rows) {
    fail(file, `${path}.grid`, `has ${raw.grid.length} rows but the arena declares ${rows}`);
  }
  let players = 0;
  let enemies = 0;
  const grid = raw.grid.map((row, r) => {
    const line = str(file, `${path}.grid[${r}]`, row);
    if (line.length !== cols) {
      fail(file, `${path}.grid[${r}]`, `has length ${line.length} but the arena declares ${cols}`);
    }
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '.') continue;
      if (ch in legend) continue;
      const kind = SPAWN_LETTERS[ch];
      if (!kind) {
        fail(file, `${path}.grid[${r}][${c}]`,
          `${JSON.stringify(ch)} is neither floor, a legend character, nor a spawn letter`);
      }
      if (kind === 'player') players++;
      else enemies++;
    }
    return line;
  });
  if (players !== 1) fail(file, path, `must have exactly one player spawn, found ${players}`);
  if (enemies < 1) fail(file, path, 'must have at least one enemy spawn');

  return { cols, rows, cellSize, legend, grid };
}

const CLAIM_FIELDS: Record<ArenaClaim['type'], readonly string[]> = {
  sightlineAfterBreach: ['type', 'from', 'sees', 'why'],
  lane: ['type', 'from', 'to', 'intact', 'breached', 'why'],
  spawnBlockRobust: ['type', 'nudge', 'why'],
};
const BLOCK_STATES = ['blocked', 'open'] as const;

function cell(file: string, path: string, v: unknown, shape: ArenaShape): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) fail(file, path, 'must be a [col, row] pair');
  const c = nonNegInt(file, `${path}[0]`, v[0]);
  const r = nonNegInt(file, `${path}[1]`, v[1]);
  if (c >= shape.cols || r >= shape.rows) {
    fail(file, path, `[${c}, ${r}] is outside the grid (${shape.cols}x${shape.rows})`);
  }
  return [c, r];
}

function enemySpawnCell(file: string, path: string, v: unknown, shape: ArenaShape): [number, number] {
  const [c, r] = cell(file, path, v, shape);
  const kind = SPAWN_LETTERS[shape.grid[r][c]];
  if (!kind || kind === 'player') {
    fail(file, path, `[${c}, ${r}] must hold an enemy spawn, found ${JSON.stringify(shape.grid[r][c])}`);
  }
  return [c, r];
}

function validateClaim(file: string, path: string, v: unknown, shape: ArenaShape): ArenaClaim {
  if (!isRecord(v)) fail(file, path, 'must be an object');
  const type = oneOf(file, `${path}.type`, v.type,
    Object.keys(CLAIM_FIELDS) as ArenaClaim['type'][], 'claim type');
  exactKeys(file, path, v, CLAIM_FIELDS[type]);
  const why = str(file, `${path}.why`, v.why);
  if (why.trim() === '') fail(file, `${path}.why`, 'must not be empty');
  switch (type) {
    case 'sightlineAfterBreach':
      return { type, from: enemySpawnCell(file, `${path}.from`, v.from, shape),
        sees: bool(file, `${path}.sees`, v.sees), why };
    case 'lane': {
      const from = cell(file, `${path}.from`, v.from, shape);
      const to = cell(file, `${path}.to`, v.to, shape);
      // A vacuous lane (from === to) reads "open" in both phases forever: the same
      // cell is always in line of sight of itself, whatever the walls do. Reject it
      // at load rather than ship a claim that can never fail (CLAUDE.md: every
      // assertion must be able to fail).
      if (from[0] === to[0] && from[1] === to[1]) {
        fail(file, path, `has identical "from" and "to" [${from}] -- a lane like that is always "open" and can never fail`);
      }
      return { type, from, to,
        intact: oneOf(file, `${path}.intact`, v.intact, BLOCK_STATES, 'block state'),
        breached: oneOf(file, `${path}.breached`, v.breached, BLOCK_STATES, 'block state'), why };
    }
    case 'spawnBlockRobust': {
      const nudge = num(file, `${path}.nudge`, v.nudge);
      if (nudge <= 0) fail(file, `${path}.nudge`, 'must be greater than zero');
      return { type, nudge, why };
    }
  }
}

export function validateArenas(raw: unknown, file = 'arenas.json'): ArenaDefinition[] {
  if (!isRecord(raw)) fail(file, 'root', 'must be an object with an "arenas" array');
  if (!Array.isArray(raw.arenas)) fail(file, 'root.arenas', 'must be an array');
  if (raw.arenas.length === 0) fail(file, 'root.arenas', 'must hold at least one arena');

  const seen = new Set<string>();
  return raw.arenas.map((entry, i) => {
    const path = `arenas[${i}]`;
    if (!isRecord(entry)) fail(file, path, 'must be an object');
    exactKeys(file, path, entry, DEFINITION_ARENA_FIELDS);
    const shape = validateArenaShape(entry, file, path);
    const id = str(file, `${path}.id`, entry.id);
    if (seen.has(id)) fail(file, path, `duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
    if (!Array.isArray(entry.notes)) fail(file, `${path}.notes`, 'must be an array of strings');
    const notes = entry.notes.map((n, j) => str(file, `${path}.notes[${j}]`, n));
    if (!Array.isArray(entry.claims)) fail(file, `${path}.claims`, 'must be an array');
    const claims = entry.claims.map((c, j) => validateClaim(file, `${path}.claims[${j}]`, c, shape));
    return { id, ...shape, notes, claims };
  });
}

const CAMPAIGN_FIELDS = ['id', 'levels'] as const;
const CAMPAIGN_LEVEL_FIELDS = ['id', 'arenaId'] as const;

/** Reserved for a legacy numeric-string persisted value (progress.ts's frozen ordinal
 *  table) -- a real level id must never collide with one, or a stale save could
 *  misresolve against a level nobody authored. */
const BARE_DIGITS = /^\d+$/;

export function validateCampaign(
  raw: unknown,
  knownArenaIds: ReadonlySet<string>,
  file = 'campaign.json',
): CampaignDefinition {
  if (!isRecord(raw)) fail(file, 'root', 'must be an object');
  exactKeys(file, 'root', raw, CAMPAIGN_FIELDS);
  const id = str(file, 'root.id', raw.id);
  if (id.trim() === '') fail(file, 'root.id', 'must not be empty');
  if (!Array.isArray(raw.levels)) fail(file, 'root.levels', 'must be an array');
  if (raw.levels.length === 0) fail(file, 'root.levels', 'must hold at least one level');

  const seen = new Set<string>();
  const levels: CampaignLevel[] = raw.levels.map((entry, i) => {
    const path = `levels[${i}]`;
    if (!isRecord(entry)) fail(file, path, 'must be an object');
    exactKeys(file, path, entry, CAMPAIGN_LEVEL_FIELDS);
    const levelId = str(file, `${path}.id`, entry.id);
    if (levelId.trim() === '') fail(file, `${path}.id`, 'must not be empty');
    if (BARE_DIGITS.test(levelId)) {
      fail(file, `${path}.id`, `must not be a bare digit string ${JSON.stringify(levelId)} -- reserved for a legacy persisted ordinal`);
    }
    if (seen.has(levelId)) fail(file, path, `duplicate id ${JSON.stringify(levelId)}`);
    seen.add(levelId);
    const arenaId = str(file, `${path}.arenaId`, entry.arenaId);
    if (!knownArenaIds.has(arenaId)) {
      fail(file, `${path}.arenaId`, `${JSON.stringify(arenaId)} does not name a known arena`);
    }
    return { id: levelId, arenaId };
  });

  return { id, levels };
}

const VERSUS_CATALOG_FIELDS = [
  'id', 'arenaId', 'displayName', 'intent', 'preview',
  'players', 'modes', 'spawnPolicy', 'variants',
] as const;

/**
 * The dedicated VS arena catalog (issue #270) -- see versus-catalog-types.ts for
 * the contract's semantics. Schema-only here, the same posture as every other
 * family: geometry promises (declared support, connectivity, variants) are proven
 * separately by `versus-catalog-rules.ts`, because they need `loadArena` and this
 * module deliberately imports no sim machinery.
 *
 * `id: 'random'` is rejected because the setup pane uses the literal string
 * `'random'` as its draw-for-me sentinel (`VersusConfig.arenaId`,
 * game/versus-config.ts) -- an entry with that id would be unselectable and would
 * shadow the sentinel's meaning in every diagnostic.
 */
export function validateVersusCatalog(
  raw: unknown,
  knownArenaIds: ReadonlySet<string>,
  file = 'versus-catalog.json',
): VersusCatalogEntry[] {
  if (!isRecord(raw)) fail(file, 'root', 'must be an object');
  exactKeys(file, 'root', raw, ['entries']);
  if (!Array.isArray(raw.entries)) fail(file, 'root.entries', 'must be an array');
  if (raw.entries.length === 0) fail(file, 'root.entries', 'must hold at least one entry');

  const seen = new Set<string>();
  return raw.entries.map((entry, i) => {
    const path = `entries[${i}]`;
    if (!isRecord(entry)) fail(file, path, 'must be an object');
    exactKeys(file, path, entry, VERSUS_CATALOG_FIELDS);

    const id = str(file, `${path}.id`, entry.id);
    if (id.trim() === '') fail(file, `${path}.id`, 'must not be empty');
    if (id === 'random') fail(file, `${path}.id`, `'random' is reserved for the menu sentinel`);
    if (seen.has(id)) fail(file, path, `duplicate id ${JSON.stringify(id)}`);
    seen.add(id);

    const arenaId = str(file, `${path}.arenaId`, entry.arenaId);
    if (!knownArenaIds.has(arenaId)) {
      fail(file, `${path}.arenaId`, `${JSON.stringify(arenaId)} does not name a known arena`);
    }

    const text: Record<'displayName' | 'intent' | 'preview', string> = {
      displayName: '', intent: '', preview: '',
    };
    for (const field of ['displayName', 'intent', 'preview'] as const) {
      const v = str(file, `${path}.${field}`, entry[field]);
      if (v.trim() === '') fail(file, `${path}.${field}`, 'must not be empty');
      text[field] = v;
    }

    if (!Array.isArray(entry.players)) fail(file, `${path}.players`, 'must be an array');
    if (entry.players.length === 0) fail(file, `${path}.players`, 'must hold at least one player count');
    const players = entry.players.map((p, j) => {
      const n = posInt(file, `${path}.players[${j}]`, p);
      if (!VERSUS_PLAYER_COUNTS.includes(n)) {
        fail(file, `${path}.players[${j}]`, `must be one of ${VERSUS_PLAYER_COUNTS.join(', ')}`);
      }
      return n;
    });
    for (let j = 1; j < players.length; j++) {
      if (players[j] <= players[j - 1]) fail(file, `${path}.players`, 'must be strictly increasing');
    }

    if (!Array.isArray(entry.modes)) fail(file, `${path}.modes`, 'must be an array');
    if (entry.modes.length === 0) fail(file, `${path}.modes`, 'must hold at least one mode');
    const modes = entry.modes.map((m, j) => oneOf(file, `${path}.modes[${j}]`, m, VERSUS_MODES, 'mode'));
    if (new Set(modes).size !== modes.length) fail(file, `${path}.modes`, 'must not hold duplicate modes');

    const spawnPolicy = oneOf(file, `${path}.spawnPolicy`, entry.spawnPolicy, VERSUS_SPAWN_POLICIES, 'spawn policy');

    if (!Array.isArray(entry.variants)) fail(file, `${path}.variants`, 'must be an array');
    const variants = entry.variants.map((v, j) => oneOf(file, `${path}.variants[${j}]`, v, VERSUS_VARIANT_KINDS, 'variant kind'));
    if (new Set(variants).size !== variants.length) fail(file, `${path}.variants`, 'must not hold duplicate variant kinds');

    return {
      id, arenaId,
      displayName: text.displayName, intent: text.intent, preview: text.preview,
      players, modes, spawnPolicy, variants,
    };
  });
}
