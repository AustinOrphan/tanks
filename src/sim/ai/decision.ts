import type { Vec2, BulletType, AiState } from '../types';

export interface AiDecision {
  desiredMove: Vec2;
  turretAngle: number;
  fire: boolean;
  /**
   * Does the tank HAVE a firing solution this tick (line of sight / a bank
   * path), regardless of whether it wants to or may fire? The dispatcher
   * accumulates this into tank.aimTicks; its CONTINUITY is what the profile's
   * reactionTime is measured against.
   */
  hasSolution: boolean;
  fireType: BulletType;
  mine: boolean;
  nextState: AiState;
  nextTimer: number;
  /**
   * The dodge direction this decision computed, or null when it needed none. THREADED
   * rather than recomputed by the dispatcher: grey and teal already hold this value in a
   * local, and re-deriving it in `decideAi` would both re-walk dangerAvoidMove's 16-sample
   * wheel every tick and rest on the assumption that the dispatcher reconstructs the same
   * PERCEIVED radii the behaviour used -- an assumption that is false for brown, which
   * never calls dangerAvoidMove at all. Consumed by the commitment layer to decide whether
   * a held heading is still safe (ai/commitment.ts).
   */
  avoid: Vec2 | null;
  /**
   * Which hazard `avoid` escapes, when there is one. The commitment layer needs it because
   * the two escape shapes have OPPOSITE symmetry: a bullet dodge is one of two exact
   * opposite perpendiculars and both are equally good, so its sign carries no information,
   * while a mine escape's sign is the whole point (the other way is into the blast). Read
   * `AI_COMMIT_DODGE_ALIGN_DOT`'s comment in constants.ts for what that distinction buys.
   */
  avoidKind: 'bullet' | 'mine' | null;
  /** The committed heading and its remaining ticks, written back by `stepAi`. */
  nextIntent: Vec2 | null;
  nextIntentTicks: number;
  /**
   * The aim solution this tank is holding, and how many ticks it has left to hold it
   * (issue #344). Null when nothing is held. Written back by stepAi onto
   * Tank.aiAimHeld/aiAimHeldTicks, the same shape nextIntent uses for movement.
   */
  nextAimHeld: number | null;
  nextAimHeldTicks: number;
  /** PROTOTYPE (issue #332): optional so only teal sets them while the design is measured. */
  nextShotPlan?: 'bank' | 'direct';
  nextShotPlanTicks?: number;
}
