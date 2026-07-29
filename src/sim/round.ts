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
  // `roundStartTick` is the tick number the round's FIRST simulated tick will
  // carry, not the tick the reset happened on. step() increments `tick` before
  // running the pipeline, so anchoring on the pre-step value meant a simulated
  // tick never observed elapsed === 0 and the countdown ran 179 ticks against a
  // COUNTDOWN_TICKS of 180. See resetArena and createWorld, which both anchor
  // to tick + 1.
  const elapsed = world.tick - world.roundStartTick;
  if (elapsed < COUNTDOWN_TICKS) return 'countdown';
  if (elapsed < COUNTDOWN_TICKS + GRACE_TICKS) return 'grace';
  return 'live';
}

/**
 * Ticks left in the CURRENT phase; 0 once live.
 *
 * The HUD counts this down. Phase-relative rather than counting to `live`, so
 * the number restarts at each boundary -- 3,2,1 through countdown, then 2,1
 * through grace -- which is what makes the two phases legible as two things.
 */
export function roundPhaseTicksLeft(world: World): number {
  const elapsed = world.tick - world.roundStartTick;
  if (elapsed < COUNTDOWN_TICKS) return COUNTDOWN_TICKS - elapsed;
  if (elapsed < COUNTDOWN_TICKS + GRACE_TICKS) return COUNTDOWN_TICKS + GRACE_TICKS - elapsed;
  return 0;
}
