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
}
