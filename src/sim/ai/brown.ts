import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter, shotHitsOwnSide } from './targeting';
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

  // lineOfSight only tests WALLS. resolveBulletHits kills any non-owner tank the shell
  // touches, so a clear wall-line with Grey or Teal standing on it is a teammate kill, not
  // a shot. Evaluated against the jittered angle actually being aimed, not the ideal one.
  const clearOfFriendlies = los && !shotHitsOwnSide(world, tank, turretAngle, 'normal');

  let fire = false;
  let nextState = tank.aiState;
  switch (tank.aiState) {
    case 'idle':
      nextState = los ? 'aim' : 'idle';
      break;
    case 'aim':
      // Hold in 'aim' (not 'idle') while a teammate is on the line: Brown never moves, so
      // the block clears when the TEAMMATE walks off, and dropping back to 'idle' would
      // cost an extra tick re-walking the state machine every time that happens.
      if (clearOfFriendlies) { fire = true; nextState = 'fire'; }
      else if (!los) nextState = 'idle';
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
