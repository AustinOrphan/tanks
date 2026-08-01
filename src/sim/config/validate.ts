import type { TankKind } from '../types';
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
export const TANK_KINDS = ['player', 'brown', 'grey', 'teal', 'olive'] as const satisfies readonly TankKind[];
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

/** Chances, accuracies and weights: the sim reasons about these as [0, 1]. */
function unitInterval(file: string, path: string, v: unknown): number {
  const n = num(file, path, v);
  if (n < 0 || n > 1) fail(file, path, `must be within [0, 1], got ${n}`);
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
  'behavior', 'aimAccuracy', 'reactionTime', 'aggression', 'preferredDistance',
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
      aimAccuracy: unitInterval(file, `${profile}.aimAccuracy`, p.aimAccuracy),
      reactionTime: num(file, `${profile}.reactionTime`, p.reactionTime),
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
