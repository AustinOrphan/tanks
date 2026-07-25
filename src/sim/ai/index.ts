import type { World } from '../world';
import type { Tank } from '../types';
import type { SimEvent } from '../events';
import type { AiDecision } from './decision';
import { brownDecision } from './brown';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { spawnBullet } from '../bullets';
import { dropMine } from '../mines';
import { FIRE_COOLDOWN, MINE_COOLDOWN, DT } from '../constants';

export function decideAi(world: World, tank: Tank): AiDecision {
  switch (tank.kind) {
    case 'brown': return brownDecision(world, tank);
    case 'grey': return greyDecision(world, tank);
    case 'teal': return tealDecision(world, tank);
    default:
      return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'normal', mine: false, nextState: 'idle', nextTimer: 0 };
  }
}

export function stepAi(world: World, events: SimEvent[]): void {
  for (const tank of world.tanks) {
    if (!tank.alive || tank.kind === 'player') continue;

    // Enemy cooldowns tick here (applyPlayerInput only handles the player).
    if (tank.fireCooldown > 0) tank.fireCooldown -= DT;
    if (tank.mineCooldown > 0) tank.mineCooldown -= DT;

    const decision = decideAi(world, tank);
    tank.desiredMove = decision.desiredMove;
    tank.turretAngle = decision.turretAngle;
    tank.aiState = decision.nextState;
    tank.aiTimer = decision.nextTimer;

    if (decision.fire && tank.fireCooldown <= 0) {
      if (spawnBullet(world, tank.id, decision.turretAngle, decision.fireType, events)) {
        tank.fireCooldown = FIRE_COOLDOWN;
      }
    }
    if (decision.mine && tank.mineCooldown <= 0) {
      if (dropMine(world, tank.id, events)) {
        tank.mineCooldown = MINE_COOLDOWN;
      }
    }
  }
}
