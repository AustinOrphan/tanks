import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter } from './targeting';
import { driveVelocity } from '../collision';
import { bulletConfig, AI_AIM_SPREAD } from '../constants';
import type { AiDecision } from './decision';

export function brownDecision(world: World, tank: Tank): AiDecision {
  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'normal', mine: false, nextState: 'idle', nextTimer: 0 };
  }

  const speed = bulletConfig.normal.speed;
  const los = lineOfSight(tank.pos, player.pos, world.walls);
  const targetVel = driveVelocity(player);
  // Jitter is applied ONLY to a genuine firing solution, never to the held/passthrough
  // angle: jittering a held angle would make it visibly drift every tick with nothing to
  // aim at, which is a bug, not difficulty.
  const turretAngle = los
    ? aimLead(tank.pos, player.pos, targetVel, speed) + aimJitter(world, tank, AI_AIM_SPREAD)
    : tank.turretAngle;

  let fire = false;
  let nextState = tank.aiState;
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

  return { desiredMove: { x: 0, y: 0 }, turretAngle, fire, fireType: 'normal', mine: false, nextState, nextTimer: 0 };
}
