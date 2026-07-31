import type { TankKind } from '../types';
import { MINE_CAP, NORMAL_BOUNCES, RICOCHET_BOUNCES, SHELL_CAP } from '../constants';
import {
  AIProfile,
  FireRate,
  MovementSpeed,
  ProjectileType,
  RotationSpeed,
  TankAbility,
} from './enums';
import type { ResolvedTankConfig, TankDefinition } from './types';
import { GAME_BALANCE } from './balance';
import { createCatalog } from './catalog';
import { resolveTankConfig } from './resolve';

// ---------------------------------------------------------------------------
// The SHIPPED roster: one TankDefinition per sim TankKind, authored to reproduce
// the game's CURRENT behaviour exactly (the user's "author the 4 shipped kinds"
// choice). The 9-type Wii taxonomy lives untouched in config/reference/ as
// forward-looking data; nothing here adopts its numbers.
//
// Deliberate fidelity notes:
//  - Every kind shares MEDIUM movement/rotation/fire because the game is uniform
//    on those today (one TANK_SPEED, one TANK_TURN_RATE, one fire cadence). Brown's
//    stillness is an AI-decision property (brownDecision returns {0,0}), not a
//    chassis one, so Brown keeps the mobile chassis values -- matching the code,
//    where TANK_SPEED is global and Brown simply never asks to move.
//  - `teal` is the ricochet/bank tank. No entry in the Wii table matches that
//    (their TEAL is a plain rocket; their GREEN banks but is green and stationary),
//    so it is authored here to preserve teal's real behaviour rather than relabelled.
//  - abilities carry MINE_LAYER for exactly the kinds that lay mines today (grey,
//    teal, player -- NOT brown). The mine-laying paths gate on this ability, so the
//    list is behaviour, not decoration. BANK_SHOT_AIM on teal is descriptive of its
//    bankShot logic (that logic is not gated on the flag, to avoid changing behaviour).
//  - weapon.ricochetCount mirrors the sim's per-BulletType bounce table
//    (bulletConfig): normal -> NORMAL_BOUNCES, ricochet -> RICOCHET_BOUNCES.
//    config/roster.test.ts pins that mirror so the two cannot drift.
//  - the player carries an (inert) aiProfile only because the schema requires one;
//    stepAi never runs it (the player is driven by input).
// ---------------------------------------------------------------------------

export const GAME_TANK_DEFS: Record<TankKind, TankDefinition> = {
  player: {
    displayName: 'Player',
    color: '#3d7bd6',
    firstMission: 0,
    singlePlayerOnly: false,
    movementSpeed: MovementSpeed.MEDIUM,
    rotationSpeed: RotationSpeed.MEDIUM,
    aiProfile: AIProfile.STATIC_BASIC, // inert: the player is input-driven, never stepped by the AI
    weapon: {
      projectileType: ProjectileType.STANDARD_SHELL,
      fireRate: FireRate.MEDIUM,
      maxActiveProjectiles: SHELL_CAP,
      ricochetCount: NORMAL_BOUNCES,
    },
    mineCapacity: MINE_CAP,
    abilities: [TankAbility.MINE_LAYER],
  },
  brown: {
    displayName: 'Brown',
    color: '#8a5a2b',
    firstMission: 1,
    singlePlayerOnly: false,
    movementSpeed: MovementSpeed.MEDIUM,
    rotationSpeed: RotationSpeed.MEDIUM,
    aiProfile: AIProfile.STATIC_BASIC,
    weapon: {
      projectileType: ProjectileType.STANDARD_SHELL,
      fireRate: FireRate.MEDIUM,
      maxActiveProjectiles: SHELL_CAP,
      ricochetCount: NORMAL_BOUNCES,
    },
    mineCapacity: MINE_CAP,
    abilities: [], // no MINE_LAYER: Brown never lays mines
  },
  grey: {
    displayName: 'Grey',
    color: '#8890a0',
    firstMission: 2,
    singlePlayerOnly: false,
    movementSpeed: MovementSpeed.MEDIUM,
    rotationSpeed: RotationSpeed.MEDIUM,
    aiProfile: AIProfile.DEFENSIVE_BASIC,
    weapon: {
      projectileType: ProjectileType.STANDARD_SHELL,
      fireRate: FireRate.MEDIUM,
      maxActiveProjectiles: SHELL_CAP,
      ricochetCount: NORMAL_BOUNCES,
    },
    mineCapacity: MINE_CAP,
    abilities: [TankAbility.MINE_LAYER],
  },
  teal: {
    displayName: 'Teal',
    color: '#2bb0a6',
    firstMission: 5,
    singlePlayerOnly: false,
    movementSpeed: MovementSpeed.MEDIUM,
    rotationSpeed: RotationSpeed.MEDIUM,
    aiProfile: AIProfile.MOBILE_MINE_LAYER,
    weapon: {
      projectileType: ProjectileType.RICOCHET_ROCKET,
      fireRate: FireRate.MEDIUM,
      maxActiveProjectiles: SHELL_CAP,
      ricochetCount: RICOCHET_BOUNCES,
    },
    mineCapacity: MINE_CAP,
    abilities: [TankAbility.MINE_LAYER, TankAbility.BANK_SHOT_AIM],
  },
};

// The tank family expressed on the generic catalog machinery (catalog.ts):
// resolved once at module load -- pure, deterministic, no per-tick cost. Every
// gameplay read goes through configFor(kind); no code branches on a kind literal.
const TANK_CATALOG = createCatalog<TankKind, TankDefinition, ResolvedTankConfig>(
  GAME_TANK_DEFS,
  (kind, defs) => resolveTankConfig(kind, defs, GAME_BALANCE),
);

/** The resolved runtime config for a tank kind. The one entry point gameplay uses. */
export function configFor(kind: TankKind): ResolvedTankConfig {
  return TANK_CATALOG.get(kind);
}

/** True when a kind has a given ability. Sugar over configFor(kind).abilities. */
export function hasAbility(kind: TankKind, ability: TankAbility): boolean {
  return TANK_CATALOG.get(kind).abilities.includes(ability);
}
