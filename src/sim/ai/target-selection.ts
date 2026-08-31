import type { World } from '../world';
import type { Tank } from '../types';
import { vdist, nextRng } from '../types';
import { lineOfSight } from './targeting';
import { configFor } from '../config';
import { AI_TARGET_TIE_BAND, AI_TARGET_SWITCH_MARGIN } from '../constants';
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

/**
 * Can `other` be targeted by the AI tank `subject`?
 *
 * The MIRROR of player-profile.ts's `isOpponent`, which answers the same question for a bot
 * driving a PLAYER slot -- there, in campaign-coop, the opponents are the enemies. Here the
 * subject IS an enemy, so its opponents are the player-kind tanks. Kept separate rather than
 * generalised: one predicate that tried to serve both directions would have to branch on the
 * subject's own kind, which is the "branch on tank kind" the simulation rules forbid.
 */
export function isTargetable(world: World, subject: Tank, other: Tank): boolean {
  if (!other.alive || other.kind !== 'player') return false;
  // Teams matter only once both tanks carry one; campaign-coop enemies carry none.
  if (world.mode === 'teams' && other.team !== undefined && other.team === subject.team) return false;
  return true;
}

/**
 * Is this opponent PERCEIVED right now?
 *
 * Line of sight only, which is the perception model the rest of the AI already uses. Rule 1
 * binds ACQUISITION, not retention: a committed target is kept through a sight break for the
 * rest of its span (rules 5 and 7 -- "losing direct sight does not... immediately pick a
 * different player"). Gating retention here instead would drop the target the instant a wall
 * intervened and send seekMove straight to `wander`, which is a different and much larger
 * behaviour change than the one this issue asks for.
 */
function perceives(world: World, tank: Tank, other: Tank): boolean {
  return lineOfSight(tank.pos, other.pos, world.walls);
}

/**
 * How badly does this candidate fit the profile's preferred range? Lower is better.
 *
 * Rule 2 asks for the perceived opponent whose observed distance is closest to the profile's
 * preferred band -- not the nearest one. A defensive kiter with preferredDistance 9 should
 * pick the opponent it can hold at range over the one already in its face.
 */
function rangeCost(tank: Tank, other: Tank, preferred: number): number {
  return Math.abs(vdist(tank.pos, other.pos) - preferred);
}

/**
 * The seeded per-AI tie-break (rule 3).
 *
 * A pure hash of (seed, subject id, candidate id) -- no RNG stream, same shape as
 * `wanderMove` and `aimJitter`, with a multiplier distinct from both. It depends on the
 * SUBJECT as well as the candidate, which is the part the rule is about: a tie-break keyed
 * only on the candidate would rank the players identically for every AI and swing the whole
 * enemy line onto one target at once, which is the symmetric result the rule forbids by name.
 *
 * Deliberately NOT tank-array or slot order, and deliberately not time-varying: a tie-break
 * that moved with `world.tick` would re-roll ties inside a commitment span.
 */
function tieBreak(world: World, subject: Tank, other: Tank): number {
  return nextRng(world.seed + subject.id * 2749 + other.id * 40529).value;
}

/**
 * Rank candidates by range cost, quantised into bands so near-equivalent candidates are
 * genuinely tied, then broken by the seeded per-AI draw.
 *
 * The band is what makes rule 3 reachable at all. Two opponents are almost never at exactly
 * equal distance in floating point, so an unquantised comparison would make the tie-break
 * dead code -- and a dead tie-break looks identical to a working one until a symmetric
 * fixture is written, which is the whole point of the rule.
 */
function better(world: World, subject: Tank, a: Tank, b: Tank, preferred: number): boolean {
  const ba = Math.round(rangeCost(subject, a, preferred) / AI_TARGET_TIE_BAND);
  const bb = Math.round(rangeCost(subject, b, preferred) / AI_TARGET_TIE_BAND);
  if (ba !== bb) return ba < bb;
  return tieBreak(world, subject, a) > tieBreak(world, subject, b);
}

/** The best currently-perceived candidate, or undefined when the AI sees nobody. */
function selectPerceived(world: World, tank: Tank, preferred: number): Tank | undefined {
  let best: Tank | undefined;
  for (const other of world.tanks) {
    if (!isTargetable(world, tank, other) || !perceives(world, tank, other)) continue;
    if (!best || better(world, tank, other, best, preferred)) best = other;
  }
  return best;
}

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
    const fresh = selectPerceived(world, tank, preferred);
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
  const challenger = selectPerceived(world, tank, preferred);
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
