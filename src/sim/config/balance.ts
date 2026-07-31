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
  FireRate,
  MovementSpeed,
  ProjectileType,
  RotationSpeed,
} from './enums';
import type { BalanceConstants } from './types';
import { validateAiProfiles } from './validate';
import aiProfilesJson from './data/ai-profiles.json';

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
  // AI profiles: the fields the AI actually CONSUMES today are `behavior` (decideAi
  // routes each tank to its behaviour implementation), `aggression` (grey's dodge
  // patience is (1 - aggression) seconds), `directShotWeight`/`bankShotWeight`
  // (whether teal attempts each shot type at all), and the SIGN of
  // `minePlacementChance` (whether a tank proposes mines). The rest (aimAccuracy,
  // reactionTime, preferredDistance, minimumDistance, retreatChance, and the
  // chance magnitudes) are still carried-but-unread -- honest residuals, listed in
  // the PR body. Values are the Wii reference figures except where noted: this is
  // the GAME's table, retuned to describe the game's actual tanks.
  // The per-profile numbers now live in data/ai-profiles.json, validated at
  // load (validate.ts). Two authored deviations from the Wii reference, since
  // the JSON cannot carry comments: DEFENSIVE_BASIC's minePlacementChance (0.3)
  // exists because the game's grey DOES lay mines, and its aggression (0.25) is
  // load-bearing -- (1 - 0.25) * TICK_HZ is the tuned 45-tick dodge patience
  // pinned in config/roster.test.ts. And a caveat: the STATIONARY behaviour
  // implementation reads neither shot weight, so RICOCHET_SNIPER's bank
  // preference (0.55) is authored intent awaiting an implementation (also
  // noted in CLAUDE.md).
  aiProfiles: validateAiProfiles(aiProfilesJson),
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
