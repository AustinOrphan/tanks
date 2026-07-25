import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, bankShot, dangerAvoidMove, wanderMove } from './targeting';
import { driveVelocity } from '../collision';
import { bulletConfig, RICOCHET_BOUNCES } from '../constants';
import type { AiDecision } from './decision';

export function tealDecision(world: World, tank: Tank): AiDecision {
  // Dodging overrides everything, including a clear shot (spec: dodge beats shoot).
  const avoid = dangerAvoidMove(world, tank);
  if (avoid) {
    return { desiredMove: avoid, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'reposition', nextTimer: 0 };
  }

  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'idle', nextTimer: 0 };
  }

  const speed = bulletConfig.ricochet.speed;

  // 1) Direct ricochet shot when visible.
  if (lineOfSight(tank.pos, player.pos, world.walls)) {
    const targetVel = driveVelocity(player);
    const turretAngle = aimLead(tank.pos, player.pos, targetVel, speed);
    return { desiredMove: { x: 0, y: 0 }, turretAngle, fire: true, fireType: 'ricochet', mine: false, nextState: 'fire', nextTimer: 0 };
  }

  // 2) Bank shot around cover. bankShot is single-bounce-only (see targeting.ts JSDoc);
  // RICOCHET_BOUNCES is passed only to satisfy the >= 1 precondition, not as a
  // multi-bounce search budget.
  const bank = bankShot(tank.pos, player.pos, world.walls, RICOCHET_BOUNCES);
  if (bank !== null) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: bank, fire: true, fireType: 'ricochet', mine: false, nextState: 'fire', nextTimer: 0 };
  }

  // 3) Neither exists: reposition. Teal never falls back to a direct/rocket shot (spec §7).
  const move = wanderMove(world, tank);
  return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'reposition', nextTimer: 0 };
}
