import type { Vec2, BulletType, AiState } from '../types';

export interface AiDecision {
  desiredMove: Vec2;
  turretAngle: number;
  fire: boolean;
  fireType: BulletType;
  mine: boolean;
  nextState: AiState;
  nextTimer: number;
}
