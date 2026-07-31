import type { TankKind } from '../types';
import { TankAbility } from './enums';
import type { ResolvedTankConfig, TankDefinition } from './types';
import { GAME_BALANCE } from './balance';
import { createCatalog } from './catalog';
import { resolveTankConfig } from './resolve';
import { TANK_KINDS, validateTankDefinitions } from './validate';
import tankDefsJson from './data/tank-defs.json';

// ---------------------------------------------------------------------------
// The SHIPPED roster now lives in data/tank-defs.json -- one TankDefinition per
// sim TankKind, validated at load (validate.ts): a bad edit is a boot failure
// naming the exact path, never a silent stat. The 9-type Wii taxonomy lives
// untouched in config/reference/ as forward-looking data.
//
// Fidelity notes that used to sit on the TS literals (the JSON cannot carry
// comments, so they live here):
//  - Every kind shares MEDIUM movement/rotation/fire because the game is
//    uniform on those today. Brown's stillness is an AI-decision property
//    (STATIONARY behaviour), not a chassis one.
//  - `teal` is the ricochet/bank tank; no Wii entry matches it, so it is
//    authored to preserve teal's real behaviour rather than relabelled.
//  - abilities carry MINE_LAYER for exactly the kinds that lay mines (grey,
//    teal, player -- NOT brown); the mine paths gate on it, so the list is
//    behaviour, not decoration.
//  - weapon.maxActiveProjectiles (5) and ricochetCount (1/3) are JSON literals
//    now, but config/roster.test.ts pins them equal to SHELL_CAP and the
//    per-BulletType bounce table, so drifting them apart from the balance
//    scalars is a loud two-file edit, same as every other tunable.
//  - the player carries an (inert) aiProfile only because the schema requires
//    one; stepAi never runs it.
// ---------------------------------------------------------------------------

export const GAME_TANK_DEFS: Record<TankKind, TankDefinition> = validateTankDefinitions(tankDefsJson);

// The tank family on the generic catalog machinery (catalog.ts): resolved once
// at module load -- pure, deterministic, no per-tick cost. Every gameplay read
// goes through configFor(kind); no code branches on a kind literal for stats.
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

export { TANK_KINDS };
