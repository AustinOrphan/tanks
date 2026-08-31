import type { World } from '../world';
import type { Tank } from '../types';
import { isTargetable, selectPerceived, rangeCost } from './targeting';
import { configFor } from '../config';
import { AI_TARGET_SWITCH_MARGIN } from '../constants';
import { TICK_HZ } from '../constants';

/**
 * Sticky, perception-bounded opponent selection (issue #359, binding policy 2026-08-31).
 *
 * Before this, brown, grey, teal and the shared `seekMove` each independently took the
 * FIRST alive player-kind tank in array order. With more than one human that permanently
 * privileges the lowest player slot, and the later slots are invisible until every earlier
 * one dies.
 *
 * THE COMMITTED ID LIVES ON THE TANK, and `commitTarget` is the only writer. That is what
 * makes the issue's "movement and firing decisions use the same committed opponent" true
 * rather than merely likely: `resolveOpponent` is now a lookup of `tank.aiTargetId`, so the
 * four call sites cannot disagree even in principle. A pure re-selection at each call site
 * would give the same answer today and stop doing so the moment selection depends on
 * anything a decision mutates.
 *
 * Written back by `stepAi` BEFORE the decision runs, for the same reason.
 */

/** The retarget reasons, deliberately a closed set: every change of target records one. */
export type RetargetReason = 'acquired' | 'target-lost' | 'switched-on-expiry';

/** The tank this AI is committed to, if that commitment is still valid. */
function heldTarget(world: World, tank: Tank): Tank | undefined {
  if (tank.aiTargetId === undefined) return undefined;
  const held = world.tanks.find((t) => t.id === tank.aiTargetId);
  return held && isTargetable(world, tank, held) ? held : undefined;
}

/**
 * Advance and, where the policy says so, replace this tank's committed opponent.
 *
 * The ONE writer of `aiTargetId`/`aiTargetTicks`. Returns the reason when the target
 * changed, and null when it did not -- so a caller can record every retarget without having
 * to diff the ids itself.
 */
export function commitTarget(world: World, tank: Tank): RetargetReason | null {
  const cfg = configFor(tank.kind);
  const preferred = cfg.ai.preferredDistance;
  const span = Math.round(cfg.ai.targetCommitmentTime * TICK_HZ);
  const held = heldTarget(world, tank);

  // Rule 5: an invalid target is dropped at once, whatever the span says.
  if (!held) {
    const fresh = selectPerceived(world, tank, cfg);
    const hadOne = tank.aiTargetId !== undefined;
    tank.aiTargetId = fresh?.id;
    tank.aiTargetTicks = fresh ? span : 0;
    if (!fresh) return hadOne ? 'target-lost' : null;
    return hadOne ? 'target-lost' : 'acquired';
  }

  const ticks = tank.aiTargetTicks ?? 0;
  if (ticks > 0) {
    tank.aiTargetTicks = ticks - 1;
    return null;
  }

  // Rule 6: the span has run out, but expiry is not a reason to move. Switch only for a
  // MATERIALLY better perceived candidate; anything less re-commits to the current one.
  const challenger = selectPerceived(world, tank, cfg);
  if (
    challenger &&
    challenger.id !== held.id &&
    rangeCost(tank, held, preferred) - rangeCost(tank, challenger, preferred) >
      AI_TARGET_SWITCH_MARGIN
  ) {
    tank.aiTargetId = challenger.id;
    tank.aiTargetTicks = span;
    return 'switched-on-expiry';
  }
  tank.aiTargetTicks = span;
  return null;
}

export { isTargetable };
