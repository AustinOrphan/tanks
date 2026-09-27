import type { World } from '../world';
import type { Tank } from '../types';
import { nextRng } from '../types';
import { AI_SEARCH_HOLD_TICKS, AI_SEARCH_SWEEP } from '../constants';

/**
 * Where an AI tank points its gun when it has nothing to aim at (issue #371). Without it
 * the gun stays wherever it last pointed.
 *
 * Anchored on the hull, not on the current turret angle. Anchoring on `turretAngle` would
 * make the target chase the barrel: the aim-hold layer would see a solution that moved
 * every tick as the turret slewed toward it, break its hold, and re-solve -- reintroducing
 * exactly the per-tick chasing that issue #344 removed. `bodyAngle` does not move while
 * the turret does, so within one span the heading is a fixed point the barrel travels to.
 *
 * No RNG stream: a pure hash of (world.seed, tank.id, span index), the same shape as
 * wanderMove and aimJitter, so this adds no draw to any existing sequence and cannot
 * desync a replay.
 *
 * Reads no other tank, by construction: issue #371 forbids inferring an unseen enemy's
 * current state, and with no enemy state in scope a future edit cannot start consulting it
 * without adding a parameter.
 */
export function searchAim(world: World, tank: Tank): number {
  const span = Math.floor(world.tick / AI_SEARCH_HOLD_TICKS);
  // 6091: a prime distinct from wanderMove's 1000 and aimJitter's 7919, so the search
  // heading does not correlate with the tank's aim error or wander direction.
  const draw = nextRng(world.seed + tank.id * 6091 + span).value * 2 - 1;
  return tank.bodyAngle + draw * AI_SEARCH_SWEEP;
}
