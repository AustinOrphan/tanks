import type { World } from '../world';
import type { Tank } from '../types';
import { isTargetable, selectPerceived, rangeCost } from './targeting';
import { configFor } from '../config';
import { AI_TARGET_SWITCH_MARGIN } from '../constants';
import { TICK_HZ } from '../constants';

/**
 * Sticky, perception-bounded opponent selection (issue #359, binding policy 2026-08-31).
 *
 * Not the first alive player-kind tank in array order: with more than one human that
 * permanently privileges the lowest player slot, and the later slots are invisible until
 * every earlier one dies.
 *
 * The committed id lives on the tank, and `applyCommitment` is the only writer. That is what
 * makes the issue's "movement and firing decisions use the same committed opponent" true
 * rather than merely likely: `resolveOpponent` reads `tank.aiTargetId` first, so its call
 * sites cannot disagree even in principle. A pure re-selection at each call site would give
 * the same answer today and stop doing so the moment selection depends on anything a
 * decision mutates.
 *
 * The two AIs read their commitment at different times (issue #891). A campaign enemy's
 * decision runs inside `stepAi`, immediately after its commitment, so it reads a commitment
 * written this tick. A bot filling a versus PLAYER slot does not: its decision is
 * `decidePlayerInput`, which `game/loop.ts` calls to build the input that is then handed to
 * `step`, and `stepAi` runs inside that same `step` -- so the bot reads the commitment
 * `stepAi` wrote one tick earlier. Two consequences, both handled in `bot-commitment.ts`:
 * on the first tick there is no commitment yet, so the read falls back to this tick's best
 * candidate instead of idling; and a target that died during the last `step` is
 * re-validated at read time, because "cannot leave AI stuck on a stale opponent" has to
 * hold across the gap, not only at the write.
 */

/** The retarget reasons, deliberately a closed set: every change of target records one. */
export type RetargetReason = 'acquired' | 'target-lost' | 'switched-on-expiry';

/**
 * What a commitment path supplies: how long a fresh commitment lasts, what still counts as a
 * legal target, which target is best right now, and how to rank two of them.
 *
 * The policy below is written once and run by both AIs (issue #891). Campaign enemies fill
 * this in from their AI profile and the perception-bounded selector; a bot in a versus player
 * slot fills it in from its difficulty and the versus opponent predicate. Sharing the seam
 * rather than the file is what keeps "the same policy extended to a second AI" true: a copied
 * rule 5 and rule 6 would be two policies the day either is edited.
 */
export interface CommitmentPolicy {
  /** Ticks a fresh commitment is held for. */
  readonly span: number;
  /** Is this tank still a legal target for the subject right now? */
  valid(candidate: Tank): boolean;
  /** The best target available this tick, or undefined when there is none. */
  select(): Tank | undefined;
  /** Lower is better. Compared between the held target and a challenger at expiry. */
  cost(target: Tank): number;
}

/** The tank this AI is committed to, if that commitment is still valid under `policy`. */
function heldTarget(world: World, tank: Tank, policy: CommitmentPolicy): Tank | undefined {
  if (tank.aiTargetId === undefined) return undefined;
  const held = world.tanks.find((t) => t.id === tank.aiTargetId);
  return held && policy.valid(held) ? held : undefined;
}

/**
 * Advance and, where the policy says so, replace this tank's committed opponent.
 *
 * The one writer of `aiTargetId`/`aiTargetTicks`/`aiRetargetReason`/`aiRetargetAgeTicks`,
 * for every AI. Returns the reason when the target changed, and null when it did not -- so a
 * caller can record every retarget without having to diff the ids itself.
 */
export function applyCommitment(
  world: World,
  tank: Tank,
  policy: CommitmentPolicy,
): RetargetReason | null {
  const reason = decideCommitment(world, tank, policy);
  // Recorded at the one writer (issue #359), so a thrashing AI can be asked why it switched.
  // Writing it here rather than at the call site keeps the guarantee the rest of this module
  // rests on: there is exactly one place `aiTargetId` changes and exactly one place the cause
  // of that change is recorded, so the two cannot disagree.
  if (reason !== null) {
    tank.aiRetargetReason = reason;
    tank.aiRetargetAgeTicks = 0;
  } else if (tank.aiRetargetReason !== undefined) {
    // Ages only once a reason exists, so a tank that has never chosen a target carries no
    // age at all rather than a growing count against nothing.
    tank.aiRetargetAgeTicks = (tank.aiRetargetAgeTicks ?? 0) + 1;
  }
  return reason;
}

/**
 * The campaign AI's commitment: enemy-kind tanks, driven by `stepAi` before the decision.
 */
export function commitTarget(world: World, tank: Tank): RetargetReason | null {
  const cfg = configFor(tank.kind);
  const preferred = cfg.ai.preferredDistance;
  return applyCommitment(world, tank, {
    span: Math.round(cfg.ai.targetCommitmentTime * TICK_HZ),
    valid: (candidate) => isTargetable(world, tank, candidate),
    select: () => selectPerceived(world, tank, cfg),
    cost: (target) => rangeCost(tank, target, preferred),
  });
}

/** The policy itself: rules 5 and 6 of issue #359's binding target policy. */
function decideCommitment(
  world: World,
  tank: Tank,
  policy: CommitmentPolicy,
): RetargetReason | null {
  const held = heldTarget(world, tank, policy);

  // Rule 5: an invalid target is dropped at once, whatever the span says.
  if (!held) {
    const fresh = policy.select();
    const hadOne = tank.aiTargetId !== undefined;
    tank.aiTargetId = fresh?.id;
    tank.aiTargetTicks = fresh ? policy.span : 0;
    if (!fresh) return hadOne ? 'target-lost' : null;
    return hadOne ? 'target-lost' : 'acquired';
  }

  const ticks = tank.aiTargetTicks ?? 0;
  if (ticks > 0) {
    tank.aiTargetTicks = ticks - 1;
    return null;
  }

  // Rule 6: the span has run out, but expiry is not a reason to move. Switch only for a
  // materially better candidate; anything less re-commits to the current one.
  const challenger = policy.select();
  if (
    challenger &&
    challenger.id !== held.id &&
    policy.cost(held) - policy.cost(challenger) > AI_TARGET_SWITCH_MARGIN
  ) {
    tank.aiTargetId = challenger.id;
    tank.aiTargetTicks = policy.span;
    return 'switched-on-expiry';
  }
  tank.aiTargetTicks = policy.span;
  return null;
}

export { isTargetable };
