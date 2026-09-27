import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter, bankShot, profileAimSpread, shotHitsOwnSide, resolveOpponent } from './targeting';
import { driveVelocity } from '../collision';
import { configFor, type ResolvedTankConfig } from '../config';
import type { AiDecision } from './decision';

// decideAi routes every STATIONARY-behaviour profile here -- brown and green. `cfg` is
// injectable so tests can probe profile consumption.
export function brownDecision(world: World, tank: Tank, cfg: ResolvedTankConfig = configFor(tank.kind)): AiDecision {
  const weapon = cfg.weapon;
  const player = resolveOpponent(world, tank, cfg);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, hasSolution: false, fireType: weapon.bulletType, mine: false, nextState: 'idle', nextTimer: 0, avoid: null, avoidKind: null, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0 };
  }

  const speed = weapon.speed;
  const los = lineOfSight(tank.pos, player.pos, world.walls);
  const targetVel = driveVelocity(player);
  // Jitter is applied only to a genuine firing solution, never to the held/passthrough
  // angle: jittering a held angle would make it visibly drift every tick with nothing to
  // aim at, which is a bug, not difficulty.
  //
  // STATIC_BASIC (brown) has bankShotWeight 0 and never banks; RICOCHET_SNIPER (green)
  // does. `aimJitter` is a pure hash of (seed, tank.id, tick bucket) rather than threaded
  // PRNG state, so the extra call a banking profile makes cannot desync any other draw.
  const directAngle = los && cfg.ai.directShotWeight > 0
    ? aimLead(tank.pos, player.pos, targetVel, speed) + aimJitter(world, tank, profileAimSpread(cfg))
    : null;
  // bankShot is O(walls^2), so it is skipped entirely for a profile that never banks.
  const bankRaw = cfg.ai.bankShotWeight > 0
    ? bankShot(tank.pos, player.pos, world.walls, weapon.ricochetCount)
    : null;
  const bankAngle = bankRaw === null
    ? null
    : bankRaw + aimJitter(world, tank, profileAimSpread(cfg));

  // Prefers the direct shot and falls back to the bank, rather than alternating the way
  // teal does: a turret that can already see you has no reason to take the longer, more
  // easily dodged path, and "shoots you round the corner when it cannot see you" is the
  // sniper's whole read on screen. The weights are therefore inclinations (attempted at
  // all), not a mix ratio.
  const aimAngle = directAngle ?? bankAngle;
  const turretAngle = aimAngle ?? tank.turretAngle;
  const hasSolution = aimAngle !== null;

  // Deliberately not folded into the aim above (teal returns null instead): brown holds
  // its aim on the player while a teammate crosses the lane, so it fires the instant the
  // lane clears. Dropping the aim would cost a re-acquire every time that happens.
  const clearOfFriendlies = hasSolution && !shotHitsOwnSide(world, tank, turretAngle, weapon.bulletType);

  let fire = false;
  let nextState = tank.aiState;
  switch (tank.aiState) {
    case 'idle':
      nextState = hasSolution ? 'aim' : 'idle';
      break;
    case 'aim':
      // Hold in 'aim' (not 'idle') while a teammate is on the line: dropping back to
      // 'idle' would cost an extra tick re-walking the state machine when the lane clears.
      if (clearOfFriendlies) { fire = true; nextState = 'fire'; }
      else if (!hasSolution) nextState = 'idle';
      break;
    case 'fire':
      nextState = 'reposition';
      break;
    case 'reposition':
      nextState = 'idle';
      break;
  }

  return { desiredMove: { x: 0, y: 0 }, turretAngle, fire, hasSolution, fireType: weapon.bulletType, mine: false, nextState, nextTimer: 0, avoid: null, avoidKind: null, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0 };
}
