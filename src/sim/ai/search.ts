import type { World } from '../world';
import type { Tank } from '../types';
import { nextRng } from '../types';
import { AI_SEARCH_HOLD_TICKS, AI_SEARCH_SWEEP } from '../constants';

/**
 * Where an AI tank points its gun when it has nothing to aim at (issue #371).
 *
 * The defect this closes, measured over 3 seeds x 3 arenas before it existed: the turret
 * was PERFECTLY STILL on 99.50% of the 58,932 ticks on which the tank had no firing
 * solution, and those are 89.7% of every AI tank-tick in that sample. Every personality
 * ends its no-target branch with `turretAngle: tank.turretAngle` -- a pass-through that
 * leaves the gun wherever it last happened to point, for as long as nobody is visible.
 * That reads as a dormant scripted gun rather than a tank searching the arena.
 *
 * ANCHORED ON THE HULL, not on the current turret angle. Anchoring on `turretAngle` would
 * make the target chase the barrel: the aim-hold layer would see a solution that moved
 * every tick as the turret slewed toward it, break its hold, and re-solve -- reintroducing
 * exactly the per-tick chasing that issue #344 removed. `bodyAngle` does not move while
 * the turret does, so within one span the heading is a fixed point the barrel travels to.
 *
 * NO RNG STREAM. A pure hash of (world.seed, tank.id, span index), the same shape as
 * wanderMove and aimJitter, so this adds no draw to any existing sequence and cannot
 * desync a replay. The multiplier is distinct from both of theirs (1000 and 7919) for the
 * reason aimJitter's own comment gives: a tank whose search heading correlated with its
 * aim error, or with the direction it wanders, would read as a bug rather than a habit.
 *
 * BLIND BY CONSTRUCTION. Nothing here reads any other tank -- not position, not liveness,
 * not distance. That is issue #371's binding constraint ("must not infer an unseen enemy's
 * current state") discharged structurally rather than by test: there is no enemy state in
 * scope to consult, so no future edit can quietly start consulting it without adding a
 * parameter.
 */
export function searchAim(world: World, tank: Tank): number {
  const span = Math.floor(world.tick / AI_SEARCH_HOLD_TICKS);
  // 6091: a prime distinct from wanderMove's 1000 and aimJitter's 7919.
  const draw = nextRng(world.seed + tank.id * 6091 + span).value * 2 - 1;
  return tank.bodyAngle + draw * AI_SEARCH_SWEEP;
}
