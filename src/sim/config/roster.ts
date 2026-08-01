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
//  - The classes are NOT uniform since the 2026-07-31 balance pass (codified on
//    main by #52): brown turns and reloads SLOW; teal drives and turns SLOW but
//    reloads FAST; player and grey are MEDIUM across the board. Brown's
//    stillness is still an AI-decision property (STATIONARY behaviour), not a
//    chassis one -- its movementSpeed stays MEDIUM and simply goes unasked-for.
//  - `teal` is the ricochet/bank tank; no Wii entry matches it (their TEAL is a
//    plain rocket; their GREEN banks but is stationary), so it is authored to
//    preserve teal's real behaviour rather than relabelled.
//  - abilities carry MINE_LAYER for exactly the kinds that lay mines (grey,
//    teal, player -- NOT brown); the mine paths gate on it, so that entry is
//    behaviour. BANK_SHOT_AIM on teal is DESCRIPTIVE only: the bank logic gates
//    on the profile's bankShotWeight, not on this ability.
//  - weapon.maxActiveProjectiles and ricochetCount are JSON literals, but
//    config/roster.test.ts pins them equal to SHELL_CAP and the per-BulletType
//    bounce table, so drifting them apart from the balance scalars is a loud
//    two-file edit, same as every other tunable.
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
