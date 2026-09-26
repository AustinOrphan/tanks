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
// The game's balance table, in the sim's native units (world units/second,
// radians/second, whole ticks) -- deliberately not the Wii reference numbers in
// config/reference/balance-constants.json (those are a different, un-tuned scale).
//
// The numbers come from constants.ts, which derives them from config/data/balance.json
// (every value pinned in constants.test.ts), so this table reads from it rather than
// restating it, and retuning the constant retunes the resolved config with it. This
// module supplies the structure (which class means which number).
//
// Which classes are live is data (data/tank-defs.json), pinned per kind in
// config/roster.test.ts. The SLOW and FAST points of the ordered scale below (0.6x /
// 1.4x / 1.8x anchored on the MEDIUM value) are real tuning (2026-07-31 balance pass,
// #52), so retuning a multiplier here is a gameplay change gated by the roster pins.
// No kind selects STATIONARY, FAST or VERY_FAST movement, or FAST or VERY_FAST rotation.
// ---------------------------------------------------------------------------

export const GAME_BALANCE: BalanceConstants = {
  // World units/second. MEDIUM = TANK_SPEED. FAST/VERY_FAST remain unselected vocabulary.
  movementSpeeds: {
    [MovementSpeed.STATIONARY]: 0,
    [MovementSpeed.SLOW]: TANK_SPEED * 0.6,
    [MovementSpeed.MEDIUM]: TANK_SPEED,
    [MovementSpeed.FAST]: TANK_SPEED * 1.4,
    [MovementSpeed.VERY_FAST]: TANK_SPEED * 1.8,
  },
  // Radians/second (hull slew). MEDIUM = TANK_TURN_RATE.
  rotationSpeeds: {
    [RotationSpeed.SLOW]: TANK_TURN_RATE * 0.6,
    [RotationSpeed.MEDIUM]: TANK_TURN_RATE,
    [RotationSpeed.FAST]: TANK_TURN_RATE * 1.4,
    [RotationSpeed.VERY_FAST]: TANK_TURN_RATE * 1.8,
  },
  // Whole ticks between shots. MEDIUM = FIRE_COOLDOWN_TICKS.
  fireCooldowns: {
    [FireRate.SLOW]: Math.round(FIRE_COOLDOWN_TICKS * 1.6),
    [FireRate.MEDIUM]: FIRE_COOLDOWN_TICKS,
    [FireRate.FAST]: Math.round(FIRE_COOLDOWN_TICKS * 0.6),
  },
  // These are live and genuinely varied: the sim's three bullet kinds. Bounce
  // counts are carried on each tank's weapon.ricochetCount (see roster.ts) to
  // match the sim's per-BulletType bounce table; speeds live here.
  // `lifetime`/`explosionRadius`/`damage` are carried for the schema but the
  // shipped sim shells never expire on time and never explode -- they die on
  // bounce-count or wall-bury, and kill on contact.
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
  // AI profiles. The per-profile numbers live in data/ai-profiles.json, validated at
  // load (validate.ts). Every profile field is consumed by the implementations it
  // applies to (docs/agent/architecture.md, "Entity configs are data"). The two shot
  // weights are read only as signs (brown.ts and teal.ts each gate a shot type on its
  // weight being positive), so RICOCHET_SNIPER's bank weight (0.55) switches banking on
  // but its magnitude is never read.
  //
  // Fields the Wii reference carries hold the Wii reference figures; fields it lacks
  // are authored for this project. "Wii reference figure" here means the
  // value in config/reference/balance-constants.json, which is a ChatGPT starting point
  // written for this project, "not verified Wii Play values" in its own words, and not a
  // measurement of the original game (issue #783; CONTENT-LICENSE.md).
  // One authored deviation from the Wii reference (1 of 76 reference-field slots),
  // recorded here since the JSON cannot carry comments:
  // DEFENSIVE_BASIC's minePlacementChance (0.3) exists because the game's grey
  // does lay mines. Its aggression (0.25) is the Wii figure but is load-bearing
  // here -- (1 - 0.25) * TICK_HZ is the tuned 45-tick dodge patience pinned in
  // config/roster.test.ts.
  aiProfiles: validateAiProfiles(aiProfilesJson),
  // Mines are a global system in the sim (not per-tank), so this section is carried
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
