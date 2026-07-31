// Data-driven entity configuration. Public surface of the config module.
//
// Pipeline:  TankDefinition (roster.ts)  +  BalanceConstants (balance.ts)
//              --resolveTankConfig-->  ResolvedTankConfig  --configFor(kind)-->  gameplay
//
// Gameplay code imports `configFor` / `hasAbility` and reads a flat resolved
// config; it never branches on a tank-kind literal. The same resolver/schema
// also drives the 9-type Wii reference taxonomy in config/reference/, proving the
// pipeline generalises beyond the shipped roster.
export * from './enums';
export type * from './types';
export { resolveTankConfig } from './resolve';
export { GAME_BALANCE } from './balance';
export { GAME_TANK_DEFS, configFor, hasAbility } from './roster';
