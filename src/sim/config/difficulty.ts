import type { TankKind } from '../types';
import { AIBehavior } from './enums';
import { configFor } from './roster';
import { SPAWN_LETTERS } from './arena-types';
import type { ArenaShape } from './arena-types';
import type { ResolvedTankConfig } from './types';

// ---------------------------------------------------------------------------
// A difficulty model, not a measurement (issue #89), and not validated against play: a
// higher score means only that this model, with these weights, computes a higher number.
// The owner expects it to be retuned, by hand and by a scripted-player harness.
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function invert(value: number, min: number, max: number): number {
  return 1 - normalize(value, min, max);
}

// ---------------------------------------------------------------------------
// Per-tank model
// ---------------------------------------------------------------------------

// The bounds are fixed, not derived from the roster's own min/max, so a kind's score does not
// depend on which other kinds exist. They contain every value authored in
// config/data/ai-profiles.json (all 8 profiles, not just the 5 the roster uses) and every
// shipped weapon value.
export const REACTION_TIME_BOUNDS = { min: 0.2, max: 1.0 } as const; // seconds; authored range 0.25-0.8 -- headroom both ends
export const PREFERRED_DISTANCE_BOUNDS = { min: 2, max: 12 } as const; // world units; authored range 2.5-12 -- flush at max (green)
export const MINIMUM_DISTANCE_BOUNDS = { min: 0, max: 7.5 } as const; // world units; authored range 0-7 -- flush at min
export const WEAPON_SPEED_BOUNDS = { min: 4, max: 12 } as const; // world units/s; the 3 bulletConfig speeds (ricochet=4 .. fast=12) -- flush both ends
export const RICOCHET_COUNT_BOUNDS = { min: 0, max: 2 } as const; // wall bounces; the 3 bulletConfig bounce counts -- flush both ends
export const SHELL_CAP_BOUNDS = { min: 1, max: 5 } as const; // maxActiveProjectiles; shipped values are 1 or 5 -- flush both ends
export const FIRE_COOLDOWN_BOUNDS = { min: 12, max: 40 } as const; // whole ticks; shipped values are 14/24/38 -- headroom both ends

// The weights sum to 100, so a tank's total is a 0-100 score. Chosen by inspection of the
// shipped roster's spread, not by measurement or playtest. A retune fails the pinned tables
// in difficulty.test.ts; this prints the recomputed numbers to update them from:
//   npx vitest run src/sim/config/difficulty.test.ts -t "reports the full table"
export const AIM_ACCURACY_WEIGHT = 20;
export const REACTION_WEIGHT = 12;
export const AGGRESSION_WEIGHT = 8;
export const BANK_SHOT_WEIGHT = 6;
export const MINE_THREAT_WEIGHT = 8;
export const CLOSE_RANGE_WEIGHT = 6;
export const RANGE_TOLERANCE_WEIGHT = 4;
export const EVASION_WEIGHT = 6;
export const WEAPON_SPEED_WEIGHT = 12;
export const RICOCHET_WEIGHT = 6;
export const SHELL_CAP_WEIGHT = 6;
export const FIRE_RATE_WEIGHT = 6;

export interface TankDifficultyBreakdown {
  total: number;
  aimAccuracy: number;
  reaction: number;
  aggression: number;
  bankShot: number;
  mineThreat: number;
  closeRange: number;
  rangeTolerance: number;
  evasion: number;
  weaponSpeed: number;
  ricochet: number;
  shellCap: number;
  fireRate: number;
}

/**
 * A term is scored only for the behaviours whose AI implementation reads its field, so
 * authored-but-inert data never counts as threat. decideAi (ai/index.ts) routes STATIONARY
 * to brownDecision, DEFENSIVE to greyDecision and the rest to tealDecision; each gate is
 * pinned in difficulty.test.ts.
 * - The movement band: STATIONARY ignores it (docs/agent/architecture.md).
 * - `aggression`: only grey.ts reads it, so DEFENSIVE only.
 * - `bankShotWeight`: only brown.ts and teal.ts bank with it, so not DEFENSIVE; every read
 *   is a sign check, so the term is a fixed presence bonus, and scoring the magnitude would
 *   move the number with no gameplay effect.
 */
export function tankDifficultyBreakdown(cfg: ResolvedTankConfig): TankDifficultyBreakdown {
  const ai = cfg.ai;
  const mobile = cfg.behavior !== AIBehavior.STATIONARY;
  const aggressionReads = cfg.behavior === AIBehavior.DEFENSIVE;
  const bankShotReads = cfg.behavior !== AIBehavior.DEFENSIVE;

  const aimAccuracy = AIM_ACCURACY_WEIGHT * clamp01(ai.aimAccuracy);
  const reaction = REACTION_WEIGHT * invert(ai.reactionTime, REACTION_TIME_BOUNDS.min, REACTION_TIME_BOUNDS.max);
  const aggression = aggressionReads ? AGGRESSION_WEIGHT * clamp01(ai.aggression) : 0;
  const bankShot = bankShotReads && ai.bankShotWeight > 0 ? BANK_SHOT_WEIGHT : 0;
  // Gated on `mobile` too: brown.ts hardcodes `mine: false`, so a STATIONARY tank never
  // lays one however high its `minePlacementChance`.
  const mineThreat = mobile ? MINE_THREAT_WEIGHT * clamp01(ai.minePlacementChance ?? 0) : 0;
  const closeRange = mobile
    ? CLOSE_RANGE_WEIGHT * invert(ai.preferredDistance, PREFERRED_DISTANCE_BOUNDS.min, PREFERRED_DISTANCE_BOUNDS.max)
    : 0;
  const rangeTolerance = mobile
    ? RANGE_TOLERANCE_WEIGHT * invert(ai.minimumDistance, MINIMUM_DISTANCE_BOUNDS.min, MINIMUM_DISTANCE_BOUNDS.max)
    : 0;
  const evasion = mobile ? EVASION_WEIGHT * clamp01(ai.retreatChance) : 0;
  const weaponSpeed = WEAPON_SPEED_WEIGHT * normalize(cfg.weapon.speed, WEAPON_SPEED_BOUNDS.min, WEAPON_SPEED_BOUNDS.max);
  const ricochet = RICOCHET_WEIGHT * normalize(
    cfg.weapon.ricochetCount, RICOCHET_COUNT_BOUNDS.min, RICOCHET_COUNT_BOUNDS.max,
  );
  const shellCap = SHELL_CAP_WEIGHT * normalize(
    cfg.weapon.maxActiveProjectiles, SHELL_CAP_BOUNDS.min, SHELL_CAP_BOUNDS.max,
  );
  const fireRate = FIRE_RATE_WEIGHT * invert(cfg.weapon.fireCooldown, FIRE_COOLDOWN_BOUNDS.min, FIRE_COOLDOWN_BOUNDS.max);

  const total = aimAccuracy + reaction + aggression + bankShot + mineThreat
    + closeRange + rangeTolerance + evasion + weaponSpeed + ricochet + shellCap + fireRate;

  return {
    total, aimAccuracy, reaction, aggression, bankShot, mineThreat,
    closeRange, rangeTolerance, evasion, weaponSpeed, ricochet, shellCap, fireRate,
  };
}

export function tankDifficulty(kind: TankKind): number {
  return tankDifficultyBreakdown(configFor(kind)).total;
}

// ---------------------------------------------------------------------------
// Per-level model
// ---------------------------------------------------------------------------
//
// No sightline or cover-ratio term, though the issue brief asks to reuse them: they are
// built on `lineOfSight` (ai/targeting.ts), and config/ stays free of the AI layer
// (docs/agent/architecture.md). The one geometry term is enemy density, which needs only
// the grid and legend.

export const ENEMY_DENSITY_WEIGHT = 30; // same scale as a strong per-tank term
// Enemies per open cell. Bounds sit with headroom past both ends of the campaign
// arenas' measured range (arena-01's 0.00129 to arena-03's 0.00631; the test checks
// every campaign arena falls strictly inside) -- fixed, not the arenas' own min/max,
// for the same reason the per-tank bounds are fixed: a new arena must not rescale
// the others.
//
// `min` was 0.002 until issue #1010 left level 1 one enemy over 774 open cells, which
// put arena-01 below it and clamped its term to 0. The new `min` gives the bottom the
// same ratio of headroom the top already had (0.008 / 0.00631 = 1.27): 0.00129 / 1.27
// is 0.00102, rounded down to one significant figure. Moving it rescaled every
// campaign level's density term; only difficulty.test.ts reads these totals.
export const ENEMY_DENSITY_BOUNDS = { min: 0.001, max: 0.008 } as const;

function openCellCount(arena: ArenaShape): number {
  let open = 0;
  for (const row of arena.grid) {
    for (const ch of row) {
      if (arena.legend[ch] === undefined) open++;
    }
  }
  return open;
}

function enemyKinds(arena: ArenaShape): TankKind[] {
  const kinds: TankKind[] = [];
  for (const row of arena.grid) {
    for (const ch of row) {
      const kind = SPAWN_LETTERS[ch];
      if (kind && kind !== 'player') kinds.push(kind);
    }
  }
  return kinds;
}

export interface LevelDifficultyBreakdown {
  total: number;
  rosterSum: number;
  enemyCount: number;
  openCells: number;
  density: number;
  densityTerm: number;
  enemies: TankKind[];
}

/**
 * No enemy-count term, though the issue brief names one: `rosterSum` already adds one
 * tankDifficulty per enemy, so weighting by count would double count it. Density adds what
 * the sum cannot express: the same roster on a bigger board.
 */
export function levelDifficultyBreakdown(arena: ArenaShape): LevelDifficultyBreakdown {
  const enemies = enemyKinds(arena);
  const rosterSum = enemies.reduce((sum, kind) => sum + tankDifficulty(kind), 0);
  const openCells = openCellCount(arena);
  const density = openCells > 0 ? enemies.length / openCells : 0;
  const densityTerm = ENEMY_DENSITY_WEIGHT * normalize(density, ENEMY_DENSITY_BOUNDS.min, ENEMY_DENSITY_BOUNDS.max);
  return {
    total: rosterSum + densityTerm,
    rosterSum,
    enemyCount: enemies.length,
    openCells,
    density,
    densityTerm,
    enemies,
  };
}

export function levelDifficulty(arena: ArenaShape): number {
  return levelDifficultyBreakdown(arena).total;
}
