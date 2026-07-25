import type { World } from './world';
import { COUNTDOWN_TICKS, GRACE_TICKS } from './constants';

export type RoundPhase = 'countdown' | 'grace' | 'live';

/**
 * Derives the round phase from `world.tick - world.roundStartTick`.
 *
 * This is the ONE place phase boundaries are computed. Both the player path
 * (applyPlayerInput in world.ts) and the AI path (stepAi in ai/index.ts) call this
 * same function to decide whether movement/fire/mines are allowed, so the two paths
 * cannot drift apart (that class of bug has bitten this project three times already).
 *
 * Lives in its own module (not world.ts) purely to avoid a circular import: world.ts
 * imports `stepAi` from ai/index.ts, and ai/index.ts needs this function too. Only a
 * type is imported from world.ts here, which is erased at compile time, so there is no
 * runtime circularity.
 */
export function roundPhase(world: World): RoundPhase {
  const elapsed = world.tick - world.roundStartTick;
  if (elapsed < COUNTDOWN_TICKS) return 'countdown';
  if (elapsed < COUNTDOWN_TICKS + GRACE_TICKS) return 'grace';
  return 'live';
}
