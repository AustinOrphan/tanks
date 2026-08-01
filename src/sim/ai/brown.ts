import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter, profileAimSpread, shotHitsOwnSide } from './targeting';
import { driveVelocity } from '../collision';
import { configFor, type ResolvedTankConfig } from '../config';
import type { AiDecision } from './decision';

// The STATIONARY-behaviour implementation (decideAi routes here for any tank whose
// resolved profile behaviour is STATIONARY -- brown today). `cfg` is injectable so
// tests can probe profile consumption; the default is the tank's own resolved config.
export function brownDecision(world: World, tank: Tank, cfg: ResolvedTankConfig = configFor(tank.kind)): AiDecision {
  // The tank's weapon comes from its resolved config, not a hardcoded 'normal':
  // Brown fires the STANDARD_SHELL its definition names (config/roster.ts).
  const weapon = cfg.weapon;
  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, hasSolution: false, fireType: weapon.bulletType, mine: false, nextState: 'idle', nextTimer: 0 };
  }

  const speed = weapon.speed;
  const los = lineOfSight(tank.pos, player.pos, world.walls);
  const targetVel = driveVelocity(player);
  // Jitter is applied ONLY to a genuine firing solution, never to the held/passthrough
  // angle: jittering a held angle would make it visibly drift every tick with nothing to
  // aim at, which is a bug, not difficulty.
  const turretAngle = los
    ? aimLead(tank.pos, player.pos, targetVel, speed) + aimJitter(world, tank, profileAimSpread(cfg))
    : tank.turretAngle;

  // lineOfSight only tests WALLS. resolveBulletHits kills any non-owner tank the shell
  // touches, so a clear wall-line with Grey or Teal standing on it is a teammate kill, not
  // a shot. Evaluated against the jittered angle actually being aimed, not the ideal one.
  const clearOfFriendlies = los && !shotHitsOwnSide(world, tank, turretAngle, weapon.bulletType);

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

  return { desiredMove: { x: 0, y: 0 }, turretAngle, fire, hasSolution: los, fireType: weapon.bulletType, mine: false, nextState, nextTimer: 0 };
}
