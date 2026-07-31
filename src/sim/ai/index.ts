import type { World } from '../world';
import type { Tank } from '../types';
import { slewAngle } from '../types';
import type { SimEvent } from '../events';
import type { AiDecision } from './decision';
import { brownDecision } from './brown';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { spawnBullet } from '../bullets';
import { dropMine } from '../mines';
import { shotHitsOwnSide, friendlyInMineBlast } from './targeting';
import { MINE_COOLDOWN_TICKS, DT, AI_TURRET_TURN_RATE } from '../constants';
import { configFor, hasAbility, TankAbility } from '../config';
import { roundPhase } from '../round';

/** An inert decision: hold position, hold aim, do nothing. */
function idleDecision(tank: Tank): AiDecision {
  return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'normal', mine: false, nextState: 'idle', nextTimer: 0 };
}

export function decideAi(world: World, tank: Tank): AiDecision {
  switch (tank.kind) {
    case 'brown': return brownDecision(world, tank);
    case 'grey': return greyDecision(world, tank);
    case 'teal': return tealDecision(world, tank);
    // stepAi already skips the player; handled explicitly so the exhaustiveness
    // check below is reachable.
    case 'player': return idleDecision(tank);
    default: {
      // A 5th TankKind must be a COMPILE error here, not a silently inert enemy
      // that ships looking like a bug in its own decision function. Requires
      // `tsc --noEmit` to run -- see the `test` script in package.json.
      const unreachable: never = tank.kind;
      void unreachable;
      return idleDecision(tank);
    }
  }
}

export function stepAi(world: World, events: SimEvent[]): void {
  // Same phase gate as applyPlayerInput, via the SAME helper (round.ts's roundPhase),
  // so the player path and the AI path cannot drift apart: countdown blocks movement
  // entirely (turret tracking still happens inside decideAi below); grace allows
  // movement but blocks fire/mines; live is unrestricted.
  const phase = roundPhase(world);
  const canAct = phase === 'live';

  for (const tank of world.tanks) {
    if (!tank.alive || tank.kind === 'player') continue;

    // Enemy cooldowns tick here (applyPlayerInput only handles the player).
    if (tank.fireCooldown > 0) tank.fireCooldown -= 1;
    if (tank.mineCooldown > 0) tank.mineCooldown -= 1;

    const decision = decideAi(world, tank);
    tank.desiredMove = phase === 'countdown' ? { x: 0, y: 0 } : decision.desiredMove;
    // Turret turns at a finite rate rather than snapping instantly (slewAngle, types.ts)
    // -- see AI_TURRET_TURN_RATE's comment in constants.ts (a primary difficulty knob).
    tank.turretAngle = slewAngle(tank.turretAngle, decision.turretAngle, AI_TURRET_TURN_RATE * DT);
    tank.aiState = decision.nextState;
    tank.aiTimer = decision.nextTimer;

    // Friendly fire is vetted TWICE, and it has to be. The decision functions check their
    // own firing solution, but the shot below leaves along the post-slew turret angle,
    // which mid-swing can be most of a half turn away from what the decision reasoned about
    // (see the "fires with the ACTUAL (post-slew) turret angle" test in dispatch.test.ts).
    // A decision-time-only gate therefore sprays teammates on every turret swing. This is
    // the check against the angle the barrel is really pointing.
    // `disarmed` gates the TRIGGERS only, here at the act site rather than in the
    // decision functions: the tank still drives, dodges and aims (the sandbox uses it
    // as moving scenery), and the decision layer stays ignorant of a flag that is not
    // its business.
    if (canAct && !tank.disarmed && decision.fire && tank.fireCooldown <= 0 && !shotHitsOwnSide(world, tank, tank.turretAngle, decision.fireType)) {
      // Fire along the tank's ACTUAL (post-slew) turret angle, not the decision's desired
      // angle -- a shot taken mid-swing must go where the barrel currently points, not
      // where the AI wishes it pointed. Using decision.turretAngle here would let the AI
      // fire with a perfect solution while the barrel visibly points elsewhere.
      if (spawnBullet(world, tank.id, tank.turretAngle, decision.fireType, events)) {
        tank.fireCooldown = configFor(tank.kind).weapon.fireCooldown;
      }
    }
    // Same idea for mines: the decision functions gate on cooldown/cap, but only here do
    // we know the tank's final position for this tick, and a mine laid on top of a
    // teammate kills it on a 3-second fuse (Brown, which never moves, cannot escape one).
    // MINE_LAYER gates the trigger from config: only kinds whose definition grants the
    // ability lay mines. Brown lacks it (and its decision never sets mine anyway), grey
    // and teal have it -- so this is behaviour-identical and removes the last implicit
    // "which kinds lay mines" knowledge from the dispatcher. See config/roster.ts.
    if (canAct && !tank.disarmed && hasAbility(tank.kind, TankAbility.MINE_LAYER) && decision.mine && tank.mineCooldown <= 0 && !friendlyInMineBlast(world, tank)) {
      if (dropMine(world, tank.id, events)) {
        tank.mineCooldown = MINE_COOLDOWN_TICKS;
      }
    }
  }
}
