import {
  BULLET_RADIUS,
  FAST_SPEED,
  FIRE_COOLDOWN_TICKS,
  MINE_BLAST_RADIUS,
  MINE_COOLDOWN_TICKS,
  MINE_TIMER,
  MINE_TRIGGER_RADIUS,
  NORMAL_SPEED,
  RICOCHET_SPEED,
  TANK_SPEED,
  TANK_TURN_RATE,
} from '../constants';
import {
  AIBehavior,
  AIProfile,
  FireRate,
  MovementSpeed,
  ProjectileType,
  RotationSpeed,
} from './enums';
import type { BalanceConstants } from './types';

// ---------------------------------------------------------------------------
// The GAME's balance table, in the sim's NATIVE units (world units/second,
// radians/second, whole ticks) -- deliberately NOT the Wii reference numbers in
// config/reference/balance-constants.json (those are a different, un-tuned scale).
//
// SOURCE OF TRUTH FOR THE NUMBERS IS STILL constants.ts. That file is the tuned,
// measurement-backed, pinned home for every scalar (constants.test.ts locks each
// to its spec literal), so this table READS FROM it rather than restating it --
// there is exactly one place a value lives, and retuning the constant retunes the
// resolved config with it. This module supplies the STRUCTURE (which class means
// which number); constants.ts supplies the numbers.
//
// Only the classes the shipped roster (config/roster.ts) actually selects are
// exercised by the running game today -- MEDIUM movement/rotation/fire. The other
// class slots are required by the Record<> shape and are filled with an ordered
// placeholder scale anchored on the live value; they are vocabulary for future
// entities, NOT measured game values, and nothing resolves to them yet.
// ---------------------------------------------------------------------------

export const GAME_BALANCE: BalanceConstants = {
  // World units/second. Only MEDIUM is live (= TANK_SPEED, the game's uniform hull
  // speed). The rest are a placeholder scale for future/variable-speed entities.
  movementSpeeds: {
    [MovementSpeed.STATIONARY]: 0,
    [MovementSpeed.SLOW]: TANK_SPEED * 0.6,
    [MovementSpeed.MEDIUM]: TANK_SPEED,
    [MovementSpeed.FAST]: TANK_SPEED * 1.4,
    [MovementSpeed.VERY_FAST]: TANK_SPEED * 1.8,
  },
  // Radians/second (hull slew). Only MEDIUM is live (= TANK_TURN_RATE).
  rotationSpeeds: {
    [RotationSpeed.SLOW]: TANK_TURN_RATE * 0.6,
    [RotationSpeed.MEDIUM]: TANK_TURN_RATE,
    [RotationSpeed.FAST]: TANK_TURN_RATE * 1.4,
    [RotationSpeed.VERY_FAST]: TANK_TURN_RATE * 1.8,
  },
  // Whole ticks between shots. Only MEDIUM is live (= FIRE_COOLDOWN_TICKS, the
  // game's single fire cadence shared by every tank). SLOW/FAST are placeholders.
  fireCooldowns: {
    [FireRate.SLOW]: Math.round(FIRE_COOLDOWN_TICKS * 1.6),
    [FireRate.MEDIUM]: FIRE_COOLDOWN_TICKS,
    [FireRate.FAST]: Math.round(FIRE_COOLDOWN_TICKS * 0.6),
  },
  // These ARE live and genuinely varied: the sim's three bullet kinds. Bounce
  // counts are carried on each tank's weapon.ricochetCount (see roster.ts) to
  // match the sim's per-BulletType bounce table; speeds live here.
  // `lifetime`/`explosionRadius`/`damage` are carried for the schema but the
  // shipped sim shells never expire on time and never explode -- they die on
  // bounce-count or wall-bury, and kill on contact. See residuals.
  projectiles: {
    [ProjectileType.STANDARD_SHELL]: {
      speed: NORMAL_SPEED,
      damage: 1,
      radius: BULLET_RADIUS,
      lifetime: 0,
      explosionRadius: 0,
    },
    [ProjectileType.ROCKET]: {
      speed: FAST_SPEED,
      damage: 1,
      radius: BULLET_RADIUS,
      lifetime: 0,
      explosionRadius: 0,
    },
    [ProjectileType.RICOCHET_ROCKET]: {
      speed: RICOCHET_SPEED,
      damage: 1,
      radius: BULLET_RADIUS,
      lifetime: 0,
      explosionRadius: 0,
    },
  },
  // AI profiles are CARRIED as data but NOT consumed by the current bespoke AI
  // (brown/grey/teal each have a hand-written decision function; none reads
  // aggression/reactionTime/aimAccuracy/etc.). Values are the Wii reference
  // figures, kept so a future profile-driven AI has a populated table to grow
  // into. Wiring them to behaviour is an explicit residual, not this refactor.
  aiProfiles: {
    [AIProfile.STATIC_BASIC]: {
      behavior: AIBehavior.STATIONARY, aimAccuracy: 0.55, reactionTime: 0.8,
      aggression: 0.35, preferredDistance: 10, minimumDistance: 0, retreatChance: 0,
      directShotWeight: 1, bankShotWeight: 0,
    },
    [AIProfile.DEFENSIVE_BASIC]: {
      behavior: AIBehavior.DEFENSIVE, aimAccuracy: 0.6, reactionTime: 0.7,
      aggression: 0.25, preferredDistance: 9, minimumDistance: 6, retreatChance: 0.75,
      directShotWeight: 0.9, bankShotWeight: 0.1,
    },
    [AIProfile.DEFENSIVE_ROCKET]: {
      behavior: AIBehavior.DEFENSIVE, aimAccuracy: 0.65, reactionTime: 0.65,
      aggression: 0.3, preferredDistance: 10, minimumDistance: 7, retreatChance: 0.8,
      directShotWeight: 1, bankShotWeight: 0,
    },
    [AIProfile.MOBILE_MINE_LAYER]: {
      behavior: AIBehavior.TACTICAL, aimAccuracy: 0.65, reactionTime: 0.6,
      aggression: 0.5, preferredDistance: 7.5, minimumDistance: 4, retreatChance: 0.4,
      directShotWeight: 0.85, bankShotWeight: 0.15, minePlacementChance: 0.3,
    },
    [AIProfile.OFFENSIVE_ASSAULT]: {
      behavior: AIBehavior.OFFENSIVE, aimAccuracy: 0.7, reactionTime: 0.5,
      aggression: 0.8, preferredDistance: 5.5, minimumDistance: 2.5, retreatChance: 0.15,
      directShotWeight: 0.8, bankShotWeight: 0.2,
    },
    [AIProfile.RICOCHET_SNIPER]: {
      behavior: AIBehavior.STATIONARY, aimAccuracy: 0.95, reactionTime: 0.35,
      aggression: 0.75, preferredDistance: 12, minimumDistance: 0, retreatChance: 0,
      directShotWeight: 0.45, bankShotWeight: 0.55,
    },
    [AIProfile.OFFENSIVE_ELITE]: {
      behavior: AIBehavior.OFFENSIVE, aimAccuracy: 0.78, reactionTime: 0.35,
      aggression: 0.9, preferredDistance: 5, minimumDistance: 2, retreatChance: 0.1,
      directShotWeight: 0.7, bankShotWeight: 0.3, minePlacementChance: 0.35,
    },
    [AIProfile.BERSERKER_ROCKET]: {
      behavior: AIBehavior.BERSERKER, aimAccuracy: 0.82, reactionTime: 0.25,
      aggression: 1, preferredDistance: 2.5, minimumDistance: 0.5, retreatChance: 0,
      directShotWeight: 1, bankShotWeight: 0, minePlacementChance: 0.4,
    },
  },
  // Mines are a GLOBAL system in the sim (not per-tank), so this section is carried
  // for schema completeness/reference and is not what the mine code reads -- that
  // stays in constants.ts. Values mirror the live mine constants where they map.
  mines: {
    deploymentCooldown: MINE_COOLDOWN_TICKS,
    armingDelay: 0,
    triggerRadius: MINE_TRIGGER_RADIUS,
    explosionRadius: MINE_BLAST_RADIUS,
    lifetime: MINE_TIMER,
    damage: 1,
  },
  // No invisible tank in the shipped roster; carried for the WHITE-tank reference
  // and future use (Wii reference figures, in seconds). Not consumed by the sim.
  invisibility: {
    opacity: 0,
    trackLifetime: 1.6,
    trackSpawnInterval: 0.18,
  },
};
