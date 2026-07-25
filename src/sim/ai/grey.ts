import type { World } from '../world';
import type { Tank, Vec2, AiState } from '../types';
import { lineOfSight, aimLead, dangerAvoidMove, wanderMove } from './targeting';
import { driveVelocity } from '../collision';
import { bulletConfig } from '../constants';
import type { AiDecision } from './decision';

export function greyDecision(world: World, tank: Tank): AiDecision {
  let move: Vec2 = wanderMove(world, tank);

  const avoid = dangerAvoidMove(world, tank);
  // dangerAvoidMove is wall-blind and arena-blind (see targeting.ts): because moveTank
  // pushes the tank back out of overlapping walls, a dodge aimed straight into a wall
  // resolves to zero net displacement, pinning the tank inside the danger corridor.
  // Known accepted limitation for this slice, to be validated in playtest — not fixed
  // here; a naive "use the opposite direction" fallback is wrong for the mine branch
  // (the opposite heads straight into the mine), so it needs real design thought.
  if (avoid) move = avoid;

  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  let turretAngle = tank.turretAngle;
  let fire = false;
  let nextState: AiState = tank.aiState;

  if (player) {
    if (lineOfSight(tank.pos, player.pos, world.walls)) {
      const targetVel = driveVelocity(player);
      turretAngle = aimLead(tank.pos, player.pos, targetVel, bulletConfig.normal.speed);
      fire = true;
      nextState = 'fire';
    } else {
      nextState = 'reposition';
    }
  }

  // nextState/nextTimer are vestigial for Grey: unlike Brown, greyDecision never
  // branches on tank.aiState (nextState here is just a passthrough/label, not a
  // driver of behaviour), and nextTimer is always 0. Once Task 22 writes decisions
  // back onto the tank, that 0 will zero tank.aiTimer every tick — don't mistake
  // this for Grey having a dwell timer; it doesn't.
  return { desiredMove: move, turretAngle, fire, fireType: 'normal', mine: false, nextState, nextTimer: 0 };
}
