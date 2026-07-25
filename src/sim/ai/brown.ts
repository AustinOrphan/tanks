import type { World } from '../world';
import type { Tank, Vec2, BulletType, AiState } from '../types';
import { vscale } from '../types';
import { lineOfSight, aimLead } from './targeting';
import { bulletConfig, TANK_SPEED } from '../constants';

export interface AiDecision {
  desiredMove: Vec2;
  turretAngle: number;
  fire: boolean;
  fireType: BulletType;
  mine: boolean;
  nextState: AiState;
}

export function brownDecision(world: World, tank: Tank): AiDecision {
  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'normal', mine: false, nextState: 'idle' };
  }

  const speed = bulletConfig.normal.speed;
  const los = lineOfSight(tank.pos, player.pos, world.walls);
  const targetVel = vscale(player.desiredMove, TANK_SPEED);
  const turretAngle = los ? aimLead(tank.pos, player.pos, targetVel, speed) : tank.turretAngle;

  let fire = false;
  let nextState: AiState = tank.aiState;
  switch (tank.aiState) {
    case 'idle':
      nextState = los ? 'aim' : 'idle';
      break;
    case 'aim':
      if (los) { fire = true; nextState = 'fire'; }
      else nextState = 'idle';
      break;
    case 'fire':
      nextState = 'reposition';
      break;
    case 'reposition':
      nextState = 'idle';
      break;
  }

  return { desiredMove: { x: 0, y: 0 }, turretAngle, fire, fireType: 'normal', mine: false, nextState };
}
