import type { Vec2, BulletType, AiState } from '../types';

export interface AiDecision {
  desiredMove: Vec2;
  turretAngle: number;
  fire: boolean;
  /**
   * Does the tank have a firing solution this tick (line of sight / a bank
   * path), regardless of whether it wants to or may fire? The dispatcher
   * accumulates this into tank.aimTicks; its continuity is what the profile's
   * reactionTime is measured against.
   */
  hasSolution: boolean;
  fireType: BulletType;
  mine: boolean;
  nextState: AiState;
  nextTimer: number;
  /**
   * The dodge direction, or null when none was needed. Threaded rather than recomputed in
   * `decideAi`, which would re-walk dangerAvoidMove's 16-sample wheel every tick and assume
   * it can reconstruct the perceived radii the behaviour used -- false for brown, which
   * never calls dangerAvoidMove. The commitment layer (ai/commitment.ts) reads it to decide
   * whether a held heading is still safe.
   */
  avoid: Vec2 | null;
  /**
   * Which hazard `avoid` escapes, when there is one. The commitment layer needs it because
   * the two escape shapes have opposite symmetry: a bullet dodge is one of two exact
   * opposite perpendiculars and both are equally good, so its sign carries no information,
   * while a mine escape's sign is the whole point (the other way is into the blast). Read
   * `AI_COMMIT_DODGE_ALIGN_DOT`'s comment in constants.ts for what that distinction buys.
   */
  avoidKind: 'bullet' | 'mine' | null;
  /** The committed heading and its remaining ticks, written back by `stepAi`. */
  nextIntent: Vec2 | null;
  nextIntentTicks: number;
  /**
   * The aim solution being held and its remaining ticks (issue #344); null when nothing is
   * held. Written back by stepAi onto Tank.aiAimHeld/aiAimHeldTicks.
   */
  nextAimHeld: number | null;
  nextAimHeldTicks: number;
  /**
   * The bank-first/direct-first shot plan to hold, and the ticks left on its window
   * (issue #332). Mirrors Tank.aiShotPlan/aiShotPlanTicks.
   *
   * Optional, unlike the intent and aim-hold pairs above, because absent must mean "no
   * opinion". Those pairs use `null` to clear, since no behaviour needs to preserve a hold
   * it did not set. A shot plan does: only tealDecision evaluates one, and brown's and
   * grey's decisions must leave a teal tank's plan untouched rather than erase it.
   * `stepAi` writes the pair back only when it is present.
   */
  nextShotPlan?: 'bank' | 'direct';
  nextShotPlanTicks?: number;
}
