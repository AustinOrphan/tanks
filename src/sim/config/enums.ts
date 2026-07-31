// Entity-definition vocabulary. Adopted verbatim from the supplied
// `tank-enums.ts` (the "wii-play-tanks-config" drop): the enums are unit-agnostic
// labels, so the SAME set describes both the 9-type reference taxonomy
// (config/reference/) and the game's shipped 4-kind roster (config/roster.ts).
// Numbers live in a BalanceConstants table, never here.
//
// This file is under src/sim/ and therefore pure: it names classes, it imports
// nothing. See src/sim/purity.test.ts.

export enum TankType {
  BROWN = 'BROWN',
  DARK_GREY = 'DARK_GREY',
  TEAL = 'TEAL',
  YELLOW = 'YELLOW',
  RED = 'RED',
  GREEN = 'GREEN',
  PURPLE = 'PURPLE',
  WHITE = 'WHITE',
  BLACK = 'BLACK',
}

export enum MovementSpeed {
  STATIONARY = 'STATIONARY',
  SLOW = 'SLOW',
  MEDIUM = 'MEDIUM',
  FAST = 'FAST',
  VERY_FAST = 'VERY_FAST',
}

export enum RotationSpeed {
  SLOW = 'SLOW',
  MEDIUM = 'MEDIUM',
  FAST = 'FAST',
  VERY_FAST = 'VERY_FAST',
}

export enum FireRate {
  SLOW = 'SLOW',
  MEDIUM = 'MEDIUM',
  FAST = 'FAST',
}

export enum ProjectileType {
  STANDARD_SHELL = 'STANDARD_SHELL',
  ROCKET = 'ROCKET',
  RICOCHET_ROCKET = 'RICOCHET_ROCKET',
}

export enum AIProfile {
  STATIC_BASIC = 'STATIC_BASIC',
  DEFENSIVE_BASIC = 'DEFENSIVE_BASIC',
  DEFENSIVE_ROCKET = 'DEFENSIVE_ROCKET',
  MOBILE_MINE_LAYER = 'MOBILE_MINE_LAYER',
  OFFENSIVE_ASSAULT = 'OFFENSIVE_ASSAULT',
  RICOCHET_SNIPER = 'RICOCHET_SNIPER',
  OFFENSIVE_ELITE = 'OFFENSIVE_ELITE',
  BERSERKER_ROCKET = 'BERSERKER_ROCKET',
}

export enum AIBehavior {
  STATIONARY = 'STATIONARY',
  DEFENSIVE = 'DEFENSIVE',
  TACTICAL = 'TACTICAL',
  OFFENSIVE = 'OFFENSIVE',
  BERSERKER = 'BERSERKER',
}

export enum TankAbility {
  MINE_LAYER = 'MINE_LAYER',
  PREDICTIVE_AIM = 'PREDICTIVE_AIM',
  BANK_SHOT_AIM = 'BANK_SHOT_AIM',
  INVISIBILITY = 'INVISIBILITY',
  VISIBLE_TRACKS = 'VISIBLE_TRACKS',
  RUSH_PLAYER = 'RUSH_PLAYER',
}
