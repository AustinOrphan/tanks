import type { TankKind } from '../types';
import { TankAbility } from './enums';
import type { ResolvedTankConfig, TankDefinition } from './types';
import { GAME_BALANCE } from './balance';
import { createCatalog } from './catalog';
import { resolveTankConfig } from './resolve';
import { TANK_KINDS, validateTankDefinitions } from './validate';
import tankDefsJson from './data/tank-defs.json';

// ---------------------------------------------------------------------------
// Fidelity notes on data/tank-defs.json (the JSON cannot carry comments, so they live here):
//  - The classes are not uniform since the 2026-07-31 balance pass (#52): brown
//    turns and reloads SLOW; teal drives and turns SLOW but reloads FAST; player
//    and grey are MEDIUM across the board. Brown's stillness is still an
//    AI-decision property (STATIONARY behaviour), not a chassis one -- its
//    movementSpeed stays MEDIUM and simply goes unasked-for.
//  - `teal` is the ricochet/bank tank; no Wii entry matches it (their TEAL is a
//    plain rocket; their GREEN banks but is stationary), so it is authored to
//    preserve teal's real behaviour rather than relabelled.
//  - abilities carry MINE_LAYER for exactly the kinds that lay mines (player,
//    grey, teal, yellow); the mine paths gate on it, so that entry is behaviour.
//    BANK_SHOT_AIM (teal, green) is descriptive only: the bank logic gates on the
//    profile's bankShotWeight, not on this ability.
//  - weapon.maxActiveProjectiles and ricochetCount are JSON literals, but
//    config/roster.test.ts pins them to SHELL_CAP (olive and yellow are its
//    listed exceptions) and the per-BulletType bounce table, so drifting them
//    apart from the balance scalars is a loud two-file edit, same as every other
//    tunable.
//  - stepAi never runs the player's aiProfile, but it is not inert:
//    decidePlayerInput (ai/player-profile.ts), which drives autoplay and versus
//    bots, reads its accuracy, reaction, hazard and commitmentTime fields. The
//    rest goes unread, targetCommitmentTime and the movement band included:
//    bot-commitment.ts and player-profile.ts supply their own.
// ---------------------------------------------------------------------------

export const GAME_TANK_DEFS: Record<TankKind, TankDefinition> = validateTankDefinitions(tankDefsJson);

const TANK_CATALOG = createCatalog<TankKind, TankDefinition, ResolvedTankConfig>(
  GAME_TANK_DEFS,
  (kind, defs) => resolveTankConfig(kind, defs, GAME_BALANCE),
);

/** The one entry point gameplay uses for tank stats: no code branches on a kind literal for them. */
export function configFor(kind: TankKind): ResolvedTankConfig {
  return TANK_CATALOG.get(kind);
}

export function hasAbility(kind: TankKind, ability: TankAbility): boolean {
  return TANK_CATALOG.get(kind).abilities.includes(ability);
}

export { TANK_KINDS };
