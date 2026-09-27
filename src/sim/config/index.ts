// Pipeline:  TankDefinition (roster.ts)  +  BalanceConstants (balance.ts)
//              --resolveTankConfig-->  ResolvedTankConfig  --configFor(kind)-->  gameplay
//
// Gameplay code reads the flat resolved config through `configFor` / `hasAbility`; it
// never branches on a tank-kind literal.
//
// Tanks, walls, arenas, campaign levels and the versus catalog all ride createCatalog
// (catalog.ts). New families -- power-ups, turrets, bosses, destructibles -- should ride
// it the same way rather than inventing parallel plumbing.
// The authoritative balance scalars live in data/balance.json; constants.ts
// derives from it (see the note at the top of that file).
export * from './enums';
export type * from './types';
export { resolveTankConfig } from './resolve';
export { GAME_BALANCE } from './balance';
export { GAME_TANK_DEFS, configFor, hasAbility } from './roster';
export { createCatalog, type EntityCatalog } from './catalog';
export { GAME_WALL_DEFS, wallConfigFor, type WallDefinition } from './walls';
export { TANK_KINDS, validateTankDefinitions, validateAiProfiles } from './validate';
export { ARENA_DEFS, arenaById } from './arenas';
export { SPAWN_LETTERS, type ArenaClaim, type ArenaDefinition, type ArenaShape } from './arena-types';
export { validateArenas, validateArenaShape } from './validate';
