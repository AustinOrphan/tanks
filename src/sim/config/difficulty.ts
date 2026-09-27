import type { TankKind } from '../types';
import { AIBehavior } from './enums';
import { configFor } from './roster';
import { SPAWN_LETTERS } from './arena-types';
import type { ArenaShape } from './arena-types';
import type { ResolvedTankConfig } from './types';

// ---------------------------------------------------------------------------
// A difficulty model, not a measurement. Issue #89: several consumers (musical
// intensity, level ordering, roster design) want a "how hard is this" number.
// The repo owner's brief is explicit that this is expected to be adjusted
// later, both by hand and by a scripted-player harness being built
// separately -- so this file optimises for tunable and legible, not for being
// right first time. Every weight and bound below is a named constant,
// gathered in one place, so retuning is "change a number here and re-run
// difficulty.test.ts's table test" rather than a hunt through the file.
//
// Nothing here is validated against play. Do not read a higher score as a
// verified claim that a tank or level is harder -- only that this model,
// with these starting weights, computes a higher number for it.
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Linear map [min, max] -> [0, 1], clamped. Higher input -> higher output. */
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

/** normalize, then flip: for fields where a lower value is harder (reactionTime, fireCooldown). */
function invert(value: number, min: number, max: number): number {
  return 1 - normalize(value, min, max);
}

// ---------------------------------------------------------------------------
// Per-tank model
// ---------------------------------------------------------------------------
//
// Inputs: aimAccuracy, reactionTime, aggression, bankShotWeight,
// minePlacementChance, the movement band (preferredDistance/minimumDistance/
// retreatChance), and the resolved weapon's speed/ricochetCount/
// maxActiveProjectiles/fireCooldown -- each a field `resolveTankConfig` produces
// and the AI or weapon systems read (docs/agent/architecture.md, "Entity configs
// are data").

// ---- Fixed reference bounds ----
// Fixed, not derived from the shipped roster's own min/max. Normalizing
// against the roster's range would make every kind's score depend on which
// other kinds exist -- adding a ninth AI profile would silently rescale the
// other eight. These bounds contain every value authored in
// config/data/ai-profiles.json (8 profiles, not just the 5 the shipped roster
// uses) and every shipped weapon value. Starting points -- retune by editing
// the constant. Headroom varies per bound (see each line): only
// REACTION_TIME_BOUNDS and FIRE_COOLDOWN_BOUNDS have headroom at both ends.
export const REACTION_TIME_BOUNDS = { min: 0.2, max: 1.0 } as const; // seconds; authored range 0.25-0.8 -- headroom both ends
export const PREFERRED_DISTANCE_BOUNDS = { min: 2, max: 12 } as const; // world units; authored range 2.5-12 -- flush at max (green)
export const MINIMUM_DISTANCE_BOUNDS = { min: 0, max: 7.5 } as const; // world units; authored range 0-7 -- flush at min
export const WEAPON_SPEED_BOUNDS = { min: 4, max: 12 } as const; // world units/s; the 3 bulletConfig speeds (ricochet=4 .. fast=12) -- flush both ends
export const RICOCHET_COUNT_BOUNDS = { min: 0, max: 2 } as const; // wall bounces; the 3 bulletConfig bounce counts -- flush both ends
export const SHELL_CAP_BOUNDS = { min: 1, max: 5 } as const; // maxActiveProjectiles; shipped values are 1 or 5 -- flush both ends
export const FIRE_COOLDOWN_BOUNDS = { min: 12, max: 40 } as const; // whole ticks; shipped values are 14/24/38 -- headroom both ends

// ---- Per-tank weights ----
// Each is the max contribution of that feature -- reached when the underlying
// stat sits at the harder end of its bound above. They sum to 100 and every
// term is clamped to [0, weight], so a tank's total is a 0-100 score.
// Chosen by inspection of the shipped roster's spread, not by measurement or
// playtest. To retune: change one constant below and re-run
//   npx vitest run src/sim/config/difficulty.test.ts -t "reports the full table"
// to read the recomputed numbers back off stdout. Editing a weight touches
// only this file -- but the pinned tables in difficulty.test.ts (tankDifficulty's
// EXPECTED map, levelDifficulty's EXPECTED map, and the sum-to-100 checks)
// encode today's weights and will fail after a retune; update them from the
// failure output.
export const AIM_ACCURACY_WEIGHT = 20; // lethality once a shot is lined up
export const REACTION_WEIGHT = 12; // how little warning the player gets before a held solution fires
export const AGGRESSION_WEIGHT = 8; // gated to DEFENSIVE only -- see the gate below
export const BANK_SHOT_WEIGHT = 6; // willingness to take an angle with no direct line; a fixed presence bonus, gated -- see the gate below
export const MINE_THREAT_WEIGHT = 8;
export const CLOSE_RANGE_WEIGHT = 6; // preferredDistance, inverted: a closer band is more threatening
export const RANGE_TOLERANCE_WEIGHT = 4; // minimumDistance, inverted: tolerates the player closer before retreating
export const EVASION_WEIGHT = 6; // retreatChance: harder to keep a bead on
export const WEAPON_SPEED_WEIGHT = 12; // harder to dodge a fast shell
export const RICOCHET_WEIGHT = 6; // more bounces reach more of the board
export const SHELL_CAP_WEIGHT = 6; // more shells in flight at once
export const FIRE_RATE_WEIGHT = 6; // fireCooldown, inverted: fires more often

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
 * The per-tank difficulty model, broken into named terms so a caller (or the
 * table test) can see why a kind scored what it did, not just the total.
 *
 * Pure function of a resolved config -- takes ResolvedTankConfig rather than a
 * TankKind so it is directly testable against synthetic fixtures, the same
 * split resolveTankConfig/configFor already uses elsewhere in config/.
 *
 * The movement band (preferredDistance/minimumDistance/retreatChance) is
 * gated on behavior !== STATIONARY: docs/agent/architecture.md records that
 * STATIONARY ignores the band and always will, and crediting a stationary kind
 * for a stat the sim never reads would score authored-but-inert data as if it
 * were a real threat. Both STATIONARY profiles shipped today (STATIC_BASIC,
 * RICOCHET_SNIPER) already carry retreatChance 0, so the gate is a no-op for
 * retreatChance on real data; it is not a no-op for preferredDistance (10 and
 * 12 respectively) or minimumDistance, so the gate matters and is exercised by
 * a dedicated test.
 *
 * Two more terms are gated the same way, derived from decideAi's actual
 * routing (src/sim/ai/index.ts): STATIONARY -> brownDecision, DEFENSIVE ->
 * greyDecision, {TACTICAL, OFFENSIVE, BERSERKER} -> tealDecision.
 *
 * `aggression` is read by exactly one implementation: grey.ts's
 * `Math.round((1 - cfg.ai.aggression) * TICK_HZ)` for its dodge-patience.
 * brown.ts and teal.ts never reference `ai.aggression`. Only DEFENSIVE routes
 * to greyDecision, so the term is gated to `behavior === AIBehavior.DEFENSIVE`.
 *
 * `bankShotWeight` is read by brown.ts (`cfg.ai.bankShotWeight > 0`) and
 * teal.ts (`if (cfg.ai.bankShotWeight <= 0) return null`) -- both as a sign
 * check only, never by magnitude; teal.ts's own comment says
 * "Both weights are read as inclinations -- attempted at all or not."
 * grey.ts never reads it. So the term is a fixed presence bonus (BANK_SHOT_WEIGHT
 * when `bankShotWeight > 0`, else 0), not a magnitude scale -- scoring by
 * magnitude would let retuning a JSON value the sim only sign-checks move the
 * difficulty number with zero gameplay effect. Gated to the same behaviours
 * that route to brownDecision or tealDecision, i.e. `behavior !==
 * AIBehavior.DEFENSIVE` (the one implementation, greyDecision, that never
 * reads it).
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
  // Gated on `mobile` for the same reason as the movement band: `brown.ts` -- which
  // `decideAi` routes every STATIONARY tank to -- hardcodes `mine: false` in both of its
  // return paths and never imports `mineInclination`, so a stationary tank is structurally
  // incapable of laying one however high its `minePlacementChance`. Both shipped STATIONARY
  // profiles omit the optional field, so the gate moves no pinned number; it keeps a term
  // that pays out for a field the sim cannot read from misleading whoever tunes this next.
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

/** Convenience wrapper: the scalar for a shipped kind, via configFor. */
export function tankDifficulty(kind: TankKind): number {
  return tankDifficultyBreakdown(configFor(kind)).total;
}

// ---------------------------------------------------------------------------
// Per-level model
// ---------------------------------------------------------------------------
//
// Composes the tank difficulties present in an arena with a geometry term.
//
// What was not reused, and why: the issue brief calls out "open sightlines
// and cover ratio" as already computed elsewhere and asks to reuse rather
// than reimplement. They are computed -- inline, in the `it` body of "the
// cover ratio each arena quotes in its notes" in arena-validation.test.ts --
// but that computation is built on `lineOfSight` (src/sim/ai/targeting.ts),
// the AI layer, and config/ stays free of AI dependencies: that is why
// arena-claims.ts, which wraps lineOfSight for arena checks, lives in src/sim/
// and must never be imported by config/ (docs/agent/architecture.md). This
// module lives in config/, so it cannot pull in lineOfSight-based cover ratio
// without breaking that boundary -- and there is no exported, non-test
// function computing it that a differently-located module could call instead.
//
// What is reused: enemy identity and count come from `SPAWN_LETTERS`, the
// single source of truth the validator and loadArena also use. The geometry
// available without the AI layer is just the grid and legend -- open-cell
// count needs no visibility check, only "is this character a wall". That is
// the one geometry term this model adds: enemy density (enemies per open
// cell), which needs nothing arena-claims.ts or targeting.ts provide.

export const ENEMY_DENSITY_WEIGHT = 30; // max contribution, same scale as a strong per-tank term
// Enemies per open cell. Bounds sit with headroom past both ends of the campaign
// arenas' measured range (arena-01's 0.00388 to arena-03's 0.00631; the test checks
// every campaign arena falls strictly inside) -- fixed, not the arenas' own min/max,
// for the same reason the per-tank bounds are fixed: a new arena must not rescale
// the others.
export const ENEMY_DENSITY_BOUNDS = { min: 0.002, max: 0.008 } as const;

function openCellCount(arena: ArenaShape): number {
  let open = 0;
  for (const row of arena.grid) {
    for (const ch of row) {
      if (arena.legend[ch] === undefined) open++;
    }
  }
  return open;
}

/** Every enemy (non-player) spawn's kind, in grid scan order. May repeat a kind. */
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
  /** Sum of tankDifficulty over every enemy spawn. Already scales with enemy count -- see note below. */
  rosterSum: number;
  enemyCount: number;
  openCells: number;
  /** enemyCount / openCells. */
  density: number;
  densityTerm: number;
  enemies: TankKind[];
}

/**
 * The per-level difficulty model.
 *
 * `enemyCount` is the "obvious" geometry term the issue brief names, but it
 * is not added again as a separate multiplier here: `rosterSum` already sums
 * one `tankDifficulty` per enemy spawn, so a level with more enemies already
 * scores higher through that sum. Also weighting by raw count would double
 * count it. The one additional geometry term is enemy density (enemies per
 * open cell) -- two levels with the same roster read differently if one
 * board is much bigger, which the sum alone cannot express (arena-04 has 6
 * enemies but a lower density than arena-02's 4 or arena-03's 5, because its
 * board is far larger -- see the EXPECTED table in difficulty.test.ts).
 *
 * Takes ArenaShape (not the full ArenaDefinition) so synthetic fixtures don't
 * need an id/notes/claims to exercise this.
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
