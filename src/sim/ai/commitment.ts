import type { Tank, Vec2 } from '../types';
import { vdot } from '../types';
import type { World } from '../world';
import type { ResolvedTankConfig } from '../config';
import { wallBlocksStep } from './targeting';
import {
  AI_COMMIT_HYSTERESIS_DOT, AI_COMMIT_EMERGENCY_DOT, AI_COMMIT_DODGE_ALIGN_DOT, TICK_HZ, VEC_EPS,
} from '../constants';
import { detHypot } from '../math/hypot';

/**
 * The commitment layer (issue #222): an AI tank perceives and decides on its own cadence,
 * then COMMITS, instead of re-deciding its heading every tick.
 *
 * Measured before this existed, over 60 seeds x 2 arenas x 2 player policies
 * (commitment.measure.test.ts): against a shooting player, grey's movement intent reversed
 * by more than 90 degrees on 13.93% of adjacent live ticks (8712/62529 pairs, arena 3) and
 * its 95th-percentile turn was 180.0 degrees, while its MEDIAN turn was 0.0 -- a bimodal
 * hold/flip shape rather than a tank steering. The three mechanisms behind it, and what
 * each needs, from that harness's transition rollup (arena1/shooter, n=8797):
 *
 *   bullet->bullet  40.6%  dangerAvoidMove's dodge perpendicular swapping sides as the
 *                          tank crosses the shell's axis -- two equally good dodges, so
 *                          this wants HYSTERESIS
 *   seek<->bullet   36.5%  a dodge starting or ending -- wants a HOLD
 *   seek->seek      12.5%  the distance band's approach/retreat blends are near-opposite,
 *                          and the wander heading re-rolls -- also a HOLD
 *
 * Applied CENTRALLY by `decideAi` over whatever the behaviour function returned, rather
 * than inside brown/grey/teal (one implementation, one set of tests, and a new behaviour
 * class gets it for free) and emphatically not inside `dangerAvoidMove`, whose own doc
 * comment requires it to stay stateless shared geometry -- `decidePlayerInput` reuses that
 * function and must never touch `world.seed`.
 *
 * Deterministic and draw-free: the window is a plain countdown, not a seeded roll, so this
 * adds no RNG stream and cannot desync any existing one.
 */
export function commitMove(
  world: World,
  tank: Tank,
  cfg: ResolvedTankConfig,
  candidate: Vec2,
  avoid: Vec2 | null,
  avoidKind: 'bullet' | 'mine' | null = null,
): { move: Vec2; nextIntent: Vec2 | null; nextIntentTicks: number } {
  return commitHeading(
    world, tank, tank.aiIntent ?? null, tank.aiIntentTicks ?? 0,
    Math.round(cfg.ai.commitmentTime * TICK_HZ), candidate, avoid, avoidKind,
  );
}

/**
 * `commitMove`'s logic with the held state passed in explicitly rather than read off the
 * `Tank`, so the bot that drives a PLAYER slot can share it (`decidePlayerInput`,
 * player-profile.ts). That path keeps its commitment in its caller-owned `PlayerAiState`
 * instead: it is forbidden from writing to the world at all -- there is a dedicated test
 * asserting it never does, on any reachable branch -- so it cannot use `tank.aiIntent` the
 * way `stepAi` does. One implementation, two owners of the state.
 */
export function commitHeading(
  world: World,
  tank: Tank,
  held: Vec2 | null,
  ticks: number,
  commitTicks: number,
  candidate: Vec2,
  avoid: Vec2 | null,
  avoidKind: 'bullet' | 'mine' | null = null,
): { move: Vec2; nextIntent: Vec2 | null; nextIntentTicks: number } {

  // A tank with no movement intent at all and nothing already held: brown hardcodes a zero
  // desiredMove on every path, and an intent it can never act on is state that only
  // misleads a reader. Returning here also keeps every stationary tank from paying
  // emergencyBreaks' wall probe once per tick for a heading it will never take.
  if (held === null && detHypot(candidate.x, candidate.y) < VEC_EPS) {
    return { move: candidate, nextIntent: null, nextIntentTicks: 0 };
  }

  if (held !== null && ticks > 0 && !emergencyBreaks(world, tank, held, avoid, avoidKind)) {
    return { move: held, nextIntent: held, nextIntentTicks: ticks - 1 };
  }

  // Hysteresis at the adoption moment: a candidate inside the cone IS the decision already
  // being executed, so keep the held vector rather than nudging it every window.
  //
  // For a BULLET dodge the comparison is sign-blind, for the same reason the emergency
  // test below is: the candidate perpendicular and its exact opposite are the SAME
  // decision ("dodge sideways out of this corridor"), and which one dangerAvoidMove names
  // flips the instant the tank crosses the shell's axis. Without this, every commitment
  // expiry during a sustained dodge was free to adopt the flipped perpendicular -- the
  // second of the two paths by which the measured 180-degree reversals survived the hold.
  const alignment = held === null ? 0 : vdot(held, candidate);
  const keep = held !== null
    && (avoidKind === 'bullet' ? Math.abs(alignment) : alignment) >= AI_COMMIT_HYSTERESIS_DOT;
  const move = keep ? held : candidate;
  return { move, nextIntent: move, nextIntentTicks: commitTicks };
}

/**
 * An emergency is a committed heading that has stopped being SAFE -- not merely a tick on
 * which some threat exists. Two causes, both read through the same helpers the dodge itself
 * uses so the two can never disagree about what counts as blocked:
 *
 * 1. The held heading now walks into a wall. moveTank resolves a hull-vs-wall overlap by
 *    pushing the tank straight back out, so holding here nets exactly zero displacement and
 *    pins the tank in place -- strictly worse than re-deciding.
 * 2. An escape is required and the held heading points more than AI_COMMIT_EMERGENCY_DOT
 *    away from it. A heading that still carries the tank broadly clear rides out its
 *    window, which is the half of issue #222's ruling that keeps every shell from
 *    triggering an immediate full reversal.
 */
function emergencyBreaks(
  world: World,
  tank: Tank,
  held: Vec2,
  avoid: Vec2 | null,
  avoidKind: 'bullet' | 'mine' | null,
): boolean {
  if (wallBlocksStep(world, tank, held)) return true;
  if (avoid === null) return false;
  // A BULLET dodge is sign-blind: dangerAvoidMove returns one of two exact opposite
  // perpendiculars and both leave the corridor, so a held heading is still dodging as long
  // as it keeps enough of a SIDEWAYS component -- |dot|, not dot. Comparing the signed
  // value here is what let the measured `bullet->bullet` flip survive the hold entirely
  // (see AI_COMMIT_DODGE_ALIGN_DOT). A mine escape keeps the signed test: the opposite
  // direction there is into the blast, not an equally good way out.
  if (avoidKind === 'bullet') return Math.abs(vdot(held, avoid)) < AI_COMMIT_DODGE_ALIGN_DOT;
  return vdot(held, avoid) < AI_COMMIT_EMERGENCY_DOT;
}
