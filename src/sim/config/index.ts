// Data-driven entity configuration. Public surface of the config module.
//
// Pipeline:  TankDefinition (roster.ts)  +  BalanceConstants (balance.ts)
//              --resolveTankConfig-->  ResolvedTankConfig  --configFor(kind)-->  gameplay
//
// Gameplay code imports `configFor` / `hasAbility` and reads a flat resolved
// config; it never branches on a tank-kind literal. The same resolver/schema
// also drives the 9-type Wii reference taxonomy in config/reference/, proving the
// pipeline generalises beyond the shipped roster.
//
// Tanks are ONE FAMILY on the generic catalog machinery (catalog.ts); walls are
// the second (walls.ts, read via wallConfigFor). Arenas are already plain data
// (arena.ts grids). New families -- power-ups, turrets, bosses, destructibles --
// should ride createCatalog the same way rather than inventing parallel plumbing.
// The authoritative balance scalars live in data/balance.json; constants.ts
// derives from it (see the note at the top of that file).
export * from './enums';
export type * from './types';
export { resolveTankConfig } from './resolve';
export { GAME_BALANCE } from './balance';
export { GAME_TANK_DEFS, configFor, hasAbility } from './roster';
export { createCatalog, type EntityCatalog } from './catalog';
export { GAME_WALL_DEFS, wallConfigFor, type WallDefinition } from './walls';
