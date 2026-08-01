import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter, bankShot, profileAimSpread, shotHitsOwnSide } from './targeting';
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
  //
  // Both shot types are PROFILE-GATED on their weight, exactly as teal.ts gates its two.
  // That gate is also the regression argument for this file: the shipped STATIC_BASIC
  // carries bankShotWeight 0, so `bankAngle` is null on every tick and brown's aim, its
  // solution and its state machine reduce EXACTLY to what they were before banking
  // existed. `aimJitter` is a pure hash of (seed, tank.id, tick bucket) rather than
  // threaded PRNG state, so the extra call a banking profile makes cannot desync any
  // other draw either. RICOCHET_SNIPER (0.45/0.55) is what actually turns this on.
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

  // A stationary gunner prefers the DIRECT shot whenever it has one and falls back to the
  // bank, rather than alternating the way teal does. Teal alternates so a mobile tank
  // visibly performs both; a turret that can already see you has no reason to take the
  // longer, more easily dodged path, and "shoots you round the corner when it cannot see
  // you" is the sniper's whole read on screen. The weights are therefore inclinations
  // (attempted at all), not a mix ratio -- the same reading teal.ts documents.
  const aimAngle = directAngle ?? bankAngle;
  const turretAngle = aimAngle ?? tank.turretAngle;
  // The reaction clock's input: a solution EXISTS, whether direct or banked. Was `los`,
  // which is still exactly what it evaluates to for a non-banking profile.
  const hasSolution = aimAngle !== null;

  // lineOfSight only tests WALLS. resolveBulletHits kills any non-owner tank the shell
  // touches, so a clear wall-line with Grey or Teal standing on it is a teammate kill, not
  // a shot. Evaluated against the jittered angle actually being aimed, not the ideal one.
  // Deliberately NOT folded into the aim above (teal returns null instead): brown holds
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
      // Hold in 'aim' (not 'idle') while a teammate is on the line: a stationary gunner
      // never moves, so the block clears when the TEAMMATE walks off, and dropping back
      // to 'idle' would cost an extra tick re-walking the state machine every time that
      // happens.
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

  return { desiredMove: { x: 0, y: 0 }, turretAngle, fire, hasSolution, fireType: weapon.bulletType, mine: false, nextState, nextTimer: 0 };
}
