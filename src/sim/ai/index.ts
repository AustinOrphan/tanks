import type { World } from '../world';
import type { Tank } from '../types';
import type { SimEvent } from '../events';
import type { AiDecision } from './decision';
import { brownDecision } from './brown';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { spawnBullet } from '../bullets';
import { dropMine } from '../mines';
import { shotHitsOwnSide, friendlyInMineBlast, estimationError, profileHazardSpread } from './targeting';
import { commitMove } from './commitment';
import { accelSlew } from './turret-accel';
import { MINE_COOLDOWN_TICKS, DT, AI_TURRET_TURN_RATE, AI_TURRET_RAMP_TICKS, TICK_HZ, AI_MINE_FLEE_RADIUS } from '../constants';
import { AIBehavior, configFor, hasAbility, TankAbility } from '../config';
import { roundPhase } from '../round';

/** An inert decision: hold position, hold aim, do nothing. */
function idleDecision(tank: Tank): AiDecision {
  return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, hasSolution: false, fireType: 'normal', mine: false, nextState: 'idle', nextTimer: 0, avoid: null, avoidKind: null, nextIntent: null, nextIntentTicks: 0 };
}

export function decideAi(world: World, tank: Tank): AiDecision {
  // stepAi already skips the player; handled explicitly so tests can call this
  // directly with a player tank and get the documented inert decision. The player
  // never enters profile routing: its (schema-required) profile is inert data.
  if (tank.kind === 'player') return idleDecision(tank);

  // PROFILE-DRIVEN ROUTING: the decision implementation comes from the tank's
  // resolved AI profile behaviour, not from its kind -- no code here knows that
  // "teal banks shots"; the roster says so. A new tank type gets its AI by
  // naming a profile in data.
  //
  // The old "a 5th TankKind must be a COMPILE error" guard that lived in a
  // switch over tank.kind has MOVED, not vanished: GAME_TANK_DEFS is a
  // Record<TankKind, TankDefinition>, so a new kind without a roster entry
  // fails tsc in config/roster.ts -- earlier and with a better message than a
  // silently inert enemy. The exhaustiveness check below now covers AIBehavior:
  // a new behaviour class must be routed here or fail to compile.
  const cfg = configFor(tank.kind);
  const decision = ((): AiDecision => {
    switch (cfg.behavior) {
      case AIBehavior.STATIONARY: return brownDecision(world, tank, cfg);
      case AIBehavior.DEFENSIVE: return greyDecision(world, tank, cfg);
      // The three mobile-aggressive behaviours share the mobile implementation
      // today; OFFENSIVE/BERSERKER are vocabulary for future rosters, routed to
      // the nearest real implementation rather than left silently inert.
      case AIBehavior.TACTICAL:
      case AIBehavior.OFFENSIVE:
      case AIBehavior.BERSERKER:
        return tealDecision(world, tank, cfg);
      default: {
        const unreachable: never = cfg.behavior;
        void unreachable;
        return idleDecision(tank);
      }
    }
  })();

  // THE COMMITMENT LAYER (issue #222), applied centrally here rather than inside each
  // behaviour: one implementation, one set of tests, and a new behaviour class gets it
  // for free. See ai/commitment.ts for the measured defect it closes and for why it
  // cannot live inside dangerAvoidMove (that helper is shared with decidePlayerInput and
  // must stay stateless).
  //
  // Only `desiredMove` and the write-back pair are replaced. The turret, the firing
  // solution and `hasSolution` are deliberately untouched: aiming is not committed, only
  // MOVEMENT is, so an enemy that has committed to a heading still tracks and shoots you
  // the instant it can -- the reaction clock in stepAi below keeps its existing meaning.
  const committed = commitMove(world, tank, cfg, decision.desiredMove, decision.avoid, decision.avoidKind);
  return {
    ...decision,
    desiredMove: committed.move,
    nextIntent: committed.nextIntent,
    nextIntentTicks: committed.nextIntentTicks,
  };
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
    // The reaction clock: consecutive ticks a firing solution has been HELD
    // (see AiDecision.hasSolution). Accumulated here, where the per-tick truth
    // arrives; losing the solution resets it, so cover breaks the clock.
    //
    // DELIBERATELY accumulates through the countdown: an enemy that can see
    // (or bank on) the player during the announced, fire-free phase has been
    // aiming that whole time, and fires at the bell -- review measured teal
    // holding 180 countdown ticks on arena 1 and firing 1 tick into live,
    // exactly as it did before the gate existed. The telegraph guarantee is
    // therefore about COVER BREAKS in live play, not round openings.
    tank.aimTicks = decision.hasSolution ? (tank.aimTicks ?? 0) + 1 : 0;
    tank.desiredMove = phase === 'countdown' ? { x: 0, y: 0 } : decision.desiredMove;
    // Turret turns at a finite rate AND a finite acceleration (issue #347): accelSlew
    // carries the angular velocity on the tank, so the gun ramps up, tracks, and eases back
    // down instead of only ever being stopped or travelling at the cap. See
    // AI_TURRET_RAMP_TICKS's comment in constants.ts for the measurement, and turret-accel.ts
    // for why the deceleration term matters as much as the acceleration one.
    const spun = accelSlew(
      tank.turretAngle, tank.turretVel ?? 0, decision.turretAngle,
      AI_TURRET_TURN_RATE * DT, (AI_TURRET_TURN_RATE * DT) / AI_TURRET_RAMP_TICKS,
    );
    tank.turretAngle = spun.angle;
    tank.turretVel = spun.vel;
    tank.aiState = decision.nextState;
    tank.aiTimer = decision.nextTimer;
    // The committed movement heading and its countdown, written back beside the other two
    // pieces of per-tank AI state so decisions stay pure and the dispatcher owns the write
    // (issue #222). Cleared to undefined rather than left stale when nothing is held, so
    // "no commitment" is genuinely absent rather than a zero vector that reads as a real
    // heading of due-east.
    tank.aiIntent = decision.nextIntent ?? undefined;
    tank.aiIntentTicks = decision.nextIntentTicks;

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
    // The reaction gate: reactionTime consumed. An enemy may not fire until it
    // has held its solution for the profile's reactionTime -- the delay between
    // SEEING you and PUNISHING you, per kind. Sits with the other act-site
    // gates (cooldown, disarmed) so decision-level tests stay decision-level.
    //
    // Measured on the 60-seed harness before shipping, reference spans as-is
    // (brown 48 / grey 42 / olive 39 / teal 36 ticks):
    //   without the gate: a1 losses 58/60, freeWins 2/60, medianTicks 1496
    //   with the gate:    a1 losses 57/60, freeWins 3/60, medianTicks 1671
    //   (arena 3: 60/60 both rows; 1750 -> 1852; pacifist suite passes)
    // Kills arrive ~6-12% later and every cover-break punish is telegraphed by
    // the profile's span. 3/60 sits ON the pacifist boundary (as the pre-series
    // baseline did): an earlier draft measured 0/60, but that draft's teal
    // clock was resetting on teammate crossings against hasSolution's own
    // semantics -- review caught it, and the correct clock gives teal back its
    // instant shot when a mate clears the lane. Correct semantics kept over
    // the nicer number.
    const reactionTicks = Math.round(configFor(tank.kind).ai.reactionTime * TICK_HZ);
    if (canAct && !tank.disarmed && decision.fire && tank.fireCooldown <= 0 && (tank.aimTicks ?? 0) >= reactionTicks && !shotHitsOwnSide(world, tank, tank.turretAngle, decision.fireType)) {
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
    //
    // Directive B: this is the OFFENSE side of estimation error (targeting.ts's
    // friendlyInMineBlast doc comment) -- a PERCEIVED flee radius, drawn fresh here via
    // the same estimationError/profileHazardSpread house recipe grey.ts/teal.ts use for
    // their own dodge gates. Independently recomputed (a pure hash of world.seed/tank.id/
    // tick bucket, not threaded state), so it lands on the identical offset those decision
    // functions already drew this tick without anything being passed between them.
    if (canAct && !tank.disarmed && hasAbility(tank.kind, TankAbility.MINE_LAYER) && decision.mine && tank.mineCooldown <= 0
      && !friendlyInMineBlast(world, tank, AI_MINE_FLEE_RADIUS + estimationError(world, tank, profileHazardSpread(configFor(tank.kind))))) {
      if (dropMine(world, tank.id, events)) {
        tank.mineCooldown = MINE_COOLDOWN_TICKS;
      }
    }
  }
}
