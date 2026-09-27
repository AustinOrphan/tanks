import type { World } from '../world';
import type { Tank } from '../types';
import { vdist } from '../types';
import { isOpponent, lineOfSight } from './targeting';
import { applyCommitment, type RetargetReason } from './target-selection';
import { BOT_TARGET_COMMITMENT_SECONDS } from './bot-difficulty';
import { TICK_HZ } from '../constants';

/**
 * Sticky opponent selection for a bot filling a versus player slot (issue #891).
 *
 * #359 gives the campaign AI a committed opponent held for a deterministic window, but
 * versus bots occupy player slots, so `tank.kind === 'player'` and the campaign path
 * (`commitTarget`, run by `stepAi` for non-player tanks) never reaches them. This file gives
 * them the same kind of commitment.
 *
 * The split between write and read, and why it is not an accident. `commitBotTarget` is called
 * by `stepAi`, inside `step`, which is the only place entitled to write simulation state.
 * `committedOpponent` is called by `decidePlayerInput`, which `game/loop.ts` runs to build the
 * input before `step` -- and which is forbidden from writing to the world at all. So the bot
 * reads, one tick later, what `stepAi` wrote. The alternative shapes are both closed: keeping
 * the commitment in `PlayerAiState` puts it outside the world, where seeded replay and the
 * contact overlay cannot see it, and returning a commitment from `decidePlayerInput` for
 * `loop.ts` to hand back into the sim is presentation feeding the simulation.
 */

/**
 * The opponent this bot would pick if it had to choose right now: nearest visible, or nearest
 * outright when none is visible.
 *
 * Deliberately the same rule `assessThreats` uses for `engaged` (`nearestVisible ?? nearest`,
 * player-profile.ts, issue #893). The commitment must not be a third opinion sitting beside
 * the threat pass -- that is how movement and firing came to disagree in the first place. It
 * is expressed here rather than shared as code because `assessThreats` also computes the
 * whole-map retreat centroid, which a commitment has no use for, and because this file may
 * not import `player-profile.ts` without closing a cycle.
 */
function bestCandidate(world: World, tank: Tank): Tank | undefined {
  let nearest: Tank | undefined;
  let nearestDist = Infinity;
  let nearestVisible: Tank | undefined;
  let nearestVisibleDist = Infinity;
  for (const other of world.tanks) {
    if (!isOpponent(world, tank, other)) continue;
    const d = vdist(tank.pos, other.pos);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = other;
    }
    if (d < nearestVisibleDist && lineOfSight(tank.pos, other.pos, world.walls)) {
      nearestVisibleDist = d;
      nearestVisible = other;
    }
  }
  return nearestVisible ?? nearest;
}

/** Is this tank a computer-driven versus slot -- the only kind of player tank that commits? */
export function isBotDriven(tank: Tank): boolean {
  return tank.kind === 'player' && tank.botDifficulty !== undefined;
}

/**
 * Advance this bot's commitment. Called by `stepAi`, the one writer of simulation state.
 *
 * The span comes from `BOT_TARGET_COMMITMENT_SECONDS`, which is bot configuration keyed by
 * difficulty -- not from `configFor('player').ai.targetCommitmentTime`, which `roster.ts`
 * records as an unread value the schema demands and nobody chose (issue #891, point 1).
 *
 * Distance to the opponent is the cost, where the campaign policy uses distance to the
 * profile's preferred range band. A versus bot has no preferred band that anyone picked --
 * the player profile's band goes unread too -- so ranking by raw distance is the
 * honest reading of "materially better", and it agrees with `bestCandidate`'s own
 * nearest-first rule rather than ranking by one measure and selecting by another.
 */
export function commitBotTarget(world: World, tank: Tank): RetargetReason | null {
  const difficulty = tank.botDifficulty;
  if (difficulty === undefined) return null;
  const span = Math.round(BOT_TARGET_COMMITMENT_SECONDS[difficulty] * TICK_HZ);
  return applyCommitment(world, tank, {
    span,
    valid: (candidate) => isOpponent(world, tank, candidate),
    select: () => bestCandidate(world, tank),
    cost: (target) => vdist(tank.pos, target.pos),
  });
}

/**
 * The opponent a bot is committed to, for the decision that runs a tick after the write.
 *
 * Re-validated here, not trusted. Between `stepAi` writing the commitment and
 * `decidePlayerInput` reading it, a whole `step` has run: the committed tank may have died,
 * or -- on a stock respawn -- come back. Returning it unchecked is exactly the "stuck on a
 * stale opponent" failure #359's rule 5 forbids, and the write-side check cannot cover a gap
 * that opens after the write.
 *
 * Falls back to this tick's best candidate rather than to nothing. A bot on its first tick has
 * no commitment yet, and a bot that idled until `stepAi` caught up would visibly stall at
 * every round start.
 */
export function committedOpponent(world: World, tank: Tank): Tank | null {
  if (tank.botDifficulty === undefined) return null;
  if (tank.aiTargetId !== undefined) {
    const held = world.tanks.find((t) => t.id === tank.aiTargetId);
    if (held && isOpponent(world, tank, held)) return held;
  }
  return bestCandidate(world, tank) ?? null;
}
