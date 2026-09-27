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
 * then commits, instead of re-deciding its heading every tick. Its two halves answer the
 * flip sources measured in commitment.measure.test.ts: a hold for dodges starting or ending,
 * the distance band's near-opposite approach/retreat blends and wander re-rolls, and
 * hysteresis for a dodge perpendicular that swaps sides as the tank crosses the shell's axis.
 *
 * Applied centrally by `decideAi` rather than inside each personality, and not inside
 * `dangerAvoidMove`, which must stay stateless because `decidePlayerInput` reuses it.
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
 * `commitMove` with the held state passed in rather than read off the `Tank`, so
 * `decidePlayerInput` (player-profile.ts), which must never write to the world, can keep its
 * commitment in its own `PlayerAiState`.
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

  // Brown's desiredMove is always zero: an intent it can never act on would only mislead,
  // and returning here spares every stationary tank emergencyBreaks' per-tick wall probe.
  if (held === null && detHypot(candidate.x, candidate.y) < VEC_EPS) {
    return { move: candidate, nextIntent: null, nextIntentTicks: 0 };
  }

  if (held !== null && ticks > 0 && !emergencyBreaks(world, tank, held, avoid, avoidKind)) {
    return { move: held, nextIntent: held, nextIntentTicks: ticks - 1 };
  }

  // Hysteresis at the adoption moment: a candidate inside the cone IS the decision already
  // being executed, so keep the held vector rather than nudging it every window.
  //
  // For a bullet dodge the comparison is sign-blind, for the reason given in
  // emergencyBreaks: without it every commitment expiry during a sustained dodge could adopt
  // the flipped perpendicular.
  const alignment = held === null ? 0 : vdot(held, candidate);
  const keep = held !== null
    && (avoidKind === 'bullet' ? Math.abs(alignment) : alignment) >= AI_COMMIT_HYSTERESIS_DOT;
  const move = keep ? held : candidate;
  return { move, nextIntent: move, nextIntentTicks: commitTicks };
}

/**
 * An emergency is a committed heading that has stopped being SAFE, not merely a tick on
 * which some threat exists. Walking into a wall pins the tank in place (moveTank pushes the
 * hull straight back out), which is strictly worse than re-deciding. A heading that still
 * carries the tank broadly clear of a threat rides out its window, so not every shell
 * triggers an immediate full reversal (issue #222's ruling).
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
  // A bullet dodge is sign-blind: dangerAvoidMove returns one of two exact opposite
  // perpendiculars, both leave the corridor, and which one it names flips the instant the
  // tank crosses the shell's axis. A signed test would break the hold on every flip. A mine
  // escape keeps the signed test: the opposite direction there is into the blast.
  if (avoidKind === 'bullet') return Math.abs(vdot(held, avoid)) < AI_COMMIT_DODGE_ALIGN_DOT;
  return vdot(held, avoid) < AI_COMMIT_EMERGENCY_DOT;
}
