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
/**
 * The phase formula itself, independent of the shipped tick counts.
 *
 * Split out because GRACE_TICKS is currently 0, which makes the grace phase unreachable
 * through roundPhase -- and a test for a phase that cannot occur is either deleted
 * coverage or a vacuous pass. This lets the BOUNDARY MATHS stay pinned at any spans,
 * including the positive-grace configuration the constant can be restored to, while a
 * separate test pins what the shipped constants actually produce.
 */
export function phaseAt(elapsed: number, countdownTicks: number, graceTicks: number): RoundPhase {
  if (elapsed < countdownTicks) return 'countdown';
  if (elapsed < countdownTicks + graceTicks) return 'grace';
  return 'live';
}

export function roundPhase(world: World): RoundPhase {
  // `roundStartTick` is the tick number the round's FIRST simulated tick will
  // carry, not the tick the reset happened on. step() increments `tick` before
  // running the pipeline, so anchoring on the pre-step value meant a simulated
  // tick never observed elapsed === 0 and the countdown ran 179 ticks against a
  // COUNTDOWN_TICKS of 180. See resetArena and createWorld, which both anchor
  // to tick + 1.
  const elapsed = world.tick - world.roundStartTick;
  return phaseAt(elapsed, COUNTDOWN_TICKS, GRACE_TICKS);
}

/**
 * Ticks left in the CURRENT phase; 0 once live.
 *
 * The HUD counts this down. Phase-relative rather than counting to `live`, so
 * the number restarts at each boundary -- 3,2,1 through countdown, then 2,1
 * through grace -- which is what makes the two phases legible as two things.
 */
/**
 * Ticks remaining in the current phase, at arbitrary spans.
 *
 * The counterpart to phaseAt, and split out for the same reason: with GRACE_TICKS at 0
 * the grace leg of this countdown is unreachable through roundPhaseTicksLeft, so a test
 * for it would be vacuous. Restoring the constant must not land on untested code.
 */
export function ticksLeftAt(elapsed: number, countdownTicks: number, graceTicks: number): number {
  if (elapsed < countdownTicks) return countdownTicks - elapsed;
  if (elapsed < countdownTicks + graceTicks) return countdownTicks + graceTicks - elapsed;
  return 0;
}

export function roundPhaseTicksLeft(world: World): number {
  const elapsed = world.tick - world.roundStartTick;
  return ticksLeftAt(elapsed, COUNTDOWN_TICKS, GRACE_TICKS);
}
