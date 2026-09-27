import type { World } from '../world';
import type { Tank } from '../types';
import { angleDelta } from '../types';
import type { SimEvent } from '../events';
import type { AiDecision } from './decision';
import { brownDecision } from './brown';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { spawnBullet, shellCapReached } from '../bullets';
import { dropMine } from '../mines';
import { shotHitsOwnSide, friendlyInMineBlast, resolveOpponent } from './targeting';
import { perceiveHazards } from './hazard-perception';
import { commitMove } from './commitment';
import { accelSlew } from './turret-accel';
import { holdAimFor } from './aim-hold';
import { searchAim } from './search';
import { commitTarget } from './target-selection';
import { commitBotTarget, isBotDriven } from './bot-commitment';
import { memoryAim, updateTargetMemory } from './target-memory';
import { MINE_COOLDOWN_TICKS, DT, AI_TURRET_TURN_RATE, AI_TURRET_RAMP_TICKS, TICK_HZ, AI_AIM_BREAK } from '../constants';
import { AIBehavior, configFor, hasAbility, TankAbility } from '../config';
import { roundPhase } from '../round';

/** An inert decision: hold position, hold aim, do nothing. */
function idleDecision(tank: Tank): AiDecision {
  return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, hasSolution: false, fireType: 'normal', mine: false, nextState: 'idle', nextTimer: 0, avoid: null, avoidKind: null, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0 };
}

export function decideAi(world: World, tank: Tank): AiDecision {
  // stepAi already skips the player; handled explicitly so tests can call this
  // directly with a player tank and get the documented inert decision. The player
  // never enters profile routing: its (schema-required) profile is inert data.
  if (tank.kind === 'player') return idleDecision(tank);

  // Profile-driven routing: the decision implementation comes from the tank's
  // resolved AI profile behaviour, not from its kind -- no code here knows that
  // "teal banks shots"; the roster says so. A new tank type gets its AI by
  // naming a profile in data.
  //
  // A new TankKind is a compile error until it is listed in TANK_KINDS
  // (config/validate.ts), and a load failure until tank-defs.json gives it a
  // roster entry -- either is louder than a silently inert enemy. The
  // exhaustiveness check below covers AIBehavior: a new behaviour class must be
  // routed here or fail to compile.
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

  // The commitment layer (issue #222), applied centrally here rather than inside each
  // behaviour: one implementation, one set of tests, and a new behaviour class gets it
  // for free. See ai/commitment.ts for the measured defect it closes and for why it
  // cannot live inside dangerAvoidMove (that helper is shared with decidePlayerInput and
  // must stay stateless).
  //
  // Only `desiredMove` and the write-back pair are replaced. The turret, the firing
  // solution and `hasSolution` are deliberately untouched: aiming is not committed, only
  // movement is, so an enemy that has committed to a heading still tracks and shoots you
  // the instant it can -- the reaction clock in stepAi below keeps its existing meaning.
  const committed = commitMove(world, tank, cfg, decision.desiredMove, decision.avoid, decision.avoidKind);

  // The aim-hold layer (issue #344), applied centrally beside the commitment layer and
  // for the same reasons. It replaces only `turretAngle` and its write-back pair.
  //
  // `hasSolution` and `fire` are deliberately left reading the fresh solution: this holds
  // where the tank has decided to point, not whether it believes it has a shot, and the
  // dispatcher below re-vets friendly fire against the actual post-slew angle anyway. A
  // held aim that has drifted off target simply misses, which is the cost the profile's
  // aimHoldTime is tuned against -- it is not allowed to become a stealth accuracy buff.
  //
  // The barrel gets its target one of three ways: a live firing solution (the
  // personality's), then the remembered contact (#372), then idle search (#371). Each is
  // strictly less informed than the one before it -- a tank that has just lost sight looks
  // where its target was, and only starts sweeping once that memory expires. All three go
  // through holdAimFor, so a search heading gets the same hold span, break test and slew as
  // a real firing solution, and only one place decides where the barrel is going.
  //
  // `hasSolution` is the switch because it is already the dispatcher's answer to "does
  // this tank have something to point at" -- it is what feeds tank.aimTicks, and it is
  // false on exactly the branches where every personality passes `tank.turretAngle`
  // straight through. A tank that can see a target but is holding fire keeps tracking it,
  // because its solution exists; only a tank with nothing to aim at searches.
  const remembered = decision.hasSolution ? null : memoryAim(tank);
  const solution = decision.hasSolution
    ? decision.turretAngle
    : (remembered ?? searchAim(world, tank));
  const aim = holdAimFor(tank, cfg, solution);

  return {
    ...decision,
    desiredMove: committed.move,
    nextIntent: committed.nextIntent,
    nextIntentTicks: committed.nextIntentTicks,
    turretAngle: aim.angle,
    nextAimHeld: aim.nextHeld,
    nextAimHeldTicks: aim.nextHeldTicks,
  };
}

export function stepAi(world: World, events: SimEvent[]): void {
  // Same phase gate as applyPlayerInput, via the same helper (round.ts's roundPhase),
  // so the player path and the AI path cannot drift apart: countdown blocks movement
  // entirely (turret tracking still happens inside decideAi below); grace allows
  // movement but blocks fire/mines; live is unrestricted.
  const phase = roundPhase(world);
  const canAct = phase === 'live';

  // Versus bots fill player slots, so the enemy loop below skips them by construction -- see
  // `Tank.botDifficulty`. Their committed opponent is still simulation state, and the sim is
  // the only thing entitled to write it, so it is written here in a pass of its own
  // (issue #891). They take nothing else from the enemy path: their cooldowns tick in
  // `applyPlayerInput`, and their decision is `decidePlayerInput`, which `game/loop.ts` ran to
  // build this step's input before this step began. A separate pass rather than a branch
  // inside the loop below, because a bot would take one step of that loop and skip the rest.
  for (const tank of world.tanks) {
    if (!tank.alive || !isBotDriven(tank)) continue;
    commitBotTarget(world, tank);
  }

  for (const tank of world.tanks) {
    if (!tank.alive || tank.kind === 'player') continue;

    // Enemy cooldowns tick here (applyPlayerInput only handles the player).
    if (tank.fireCooldown > 0) tank.fireCooldown -= 1;
    if (tank.mineCooldown > 0) tank.mineCooldown -= 1;

    // The committed opponent is resolved before the decision, so every call `decideAi`
    // makes to resolveOpponent this tick reads one answer (issue #359). Running it after
    // would leave the decision on last tick's target and write the new one for the next,
    // which is a one-tick lag that only shows up when a target dies.
    commitTarget(world, tank);
    // Immediately after the commitment and before the decision, so the memory always
    // concerns the opponent this tank is committed to right now (issue #372's dependency
    // note) and the decision below reads a memory that is current for this tick.
    updateTargetMemory(world, tank, resolveOpponent(world, tank, configFor(tank.kind)));
    const decision = decideAi(world, tank);
    // The reaction clock: consecutive ticks a firing solution has been held
    // (see AiDecision.hasSolution) in live play. Accumulated here, where the
    // per-tick truth arrives; losing the solution resets it, so cover breaks
    // the clock.
    //
    // Countdown ticks do not count (issue #367): the countdown is a phase in
    // which the player cannot act either, so time spent in it satisfying a
    // reaction requirement is time the player was given no chance to answer.
    //
    // Keyed on the phase rather than `canAct` because the rule is "start at live
    // acquisition", not "start when firing is allowed". The two are currently the
    // same expression (`canAct` is `phase === 'live'`, above), so they agree
    // whatever GRACE_TICKS is.
    //
    // Reset to 0 rather than frozen: nothing else reads `aimTicks` -- the only
    // other consumer is the fire gate below -- so the two are observationally
    // identical, and resetting is what "starts from live acquisition" means
    // literally rather than by argument. `resetArena` zeroes it too (world.ts),
    // so a post-death countdown gets the same rule as the opening one.
    //
    // The turret still tracks through the countdown (inside `decideAi` above), so
    // the shot at the bell stays telegraphed. Only the clock is held.
    tank.aimTicks = phase === 'live' && decision.hasSolution ? (tank.aimTicks ?? 0) + 1 : 0;
    tank.desiredMove = phase === 'countdown' ? { x: 0, y: 0 } : decision.desiredMove;
    // Turret turns at a finite rate and a finite acceleration (issue #347): accelSlew
    // carries the angular velocity on the tank, so the gun ramps up, tracks, and eases back
    // down instead of only ever being stopped or travelling at the cap. See
    // AI_TURRET_RAMP_TICKS's comment in constants.ts for the measurement.
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
    // The held aim angle and its countdown (issue #344), written back and cleared the same
    // way as the movement pair above: "no held aim" is absent, not an angle of 0.
    tank.aiAimHeld = decision.nextAimHeld ?? undefined;
    tank.aiAimHeldTicks = decision.nextAimHeldTicks;
    // The held shot plan (issue #332). Written only when the decision carried one, so a
    // behaviour that never evaluates a shot plan leaves whatever it held untouched rather
    // than clearing it -- see AiDecision.nextShotPlan for why absence means "no opinion"
    // here and `null` means "clear" for the intent and aim-hold pairs above.
    //
    // The corollary is a trap: a decision path that forgets the pair silently freezes
    // the countdown instead of erroring, so the window runs longer than the profile
    // authorises.
    if (decision.nextShotPlan !== undefined) {
      tank.aiShotPlan = decision.nextShotPlan;
      tank.aiShotPlanTicks = decision.nextShotPlanTicks;
    }

    // Friendly fire is vetted twice, and it has to be. The decision functions check their
    // own firing solution, but the shot below leaves along the post-slew turret angle,
    // which mid-swing can be most of a half turn away from what the decision reasoned about
    // (see the "fires with the ACTUAL (post-slew) turret angle" test in dispatch.test.ts).
    // A decision-time-only gate therefore sprays teammates on every turret swing. This is
    // the check against the angle the barrel is really pointing.
    // `disarmed` gates the triggers only, here at the act site rather than in the
    // decision functions: the tank still drives, dodges and aims (the sandbox uses it
    // as moving scenery), and the decision layer stays ignorant of a flag that is not
    // its business.
    // The reaction gate: reactionTime consumed. An enemy may not fire until it
    // has held its solution for the profile's reactionTime -- the delay between
    // seeing you and punishing you, per kind. Sits with the other act-site
    // gates (cooldown, disarmed) so decision-level tests stay decision-level.
    // Measured for issue #367: 2 of pacifist.test.ts's 60 seeds winnable by a player who
    // never fires, inside that suite's MAX_FREE_WIN_RATE of 0.05.
    const reactionTicks = Math.round(configFor(tank.kind).ai.reactionTime * TICK_HZ);
    // The barrel must have arrived (issue #371). `aimTicks` measures how long a solution
    // has existed, never whether the gun got there, and the shot goes where the barrel
    // points, deliberately (see the comment below) -- so without this gate a tank with a
    // matured reaction clock fires wherever its barrel happens to be. Idle search makes
    // that common: measured over pacifist.test.ts's 60 seeds, search without this gate
    // took AI-on-AI shell kills from 38 to 51 on an unchanged shot count.
    //
    // AI_AIM_BREAK is reused rather than a new tolerance invented: it is already this
    // codebase's answer to "are these two angles the same aim", used by the aim-hold layer
    // to decide a held solution is still current. Firing exactly when the barrel is inside
    // that same tolerance keeps one definition of "on target" instead of two.
    const onTarget = Math.abs(angleDelta(tank.turretAngle, decision.turretAngle)) <= AI_AIM_BREAK;
    if (canAct && !tank.disarmed && decision.fire && onTarget && tank.fireCooldown <= 0 && (tank.aimTicks ?? 0) >= reactionTicks && !shotHitsOwnSide(world, tank, tank.turretAngle, decision.fireType)) {
      // Fire along the tank's actual (post-slew) turret angle, not the decision's desired
      // angle -- a shot taken mid-swing must go where the barrel currently points, not
      // where the AI wishes it pointed. Using decision.turretAngle here would let the AI
      // fire with a perfect solution while the barrel visibly points elsewhere.
      // The same cap-refusal cost the player pays (issue #356), and applied here for the
      // reason the cap itself is: a rule each caller opts into is one the next caller
      // silently escapes. No branch on tank kind -- an enemy that spams at its cap pays the
      // same beat a player does, which is also what keeps `fire-blocked`'s rate bounded for
      // every owner rather than only the local one.
      const fired = spawnBullet(world, tank.id, tank.turretAngle, decision.fireType, events);
      if (fired || shellCapReached(world, tank.id)) {
        tank.fireCooldown = configFor(tank.kind).weapon.fireCooldown;
      }
    }
    // Same idea for mines: the decision functions gate on cooldown/cap but not on
    // teammates, and a mine laid on top of a teammate kills it on a 3-second fuse
    // (Brown, which never moves, cannot escape one).
    // MINE_LAYER gates the trigger from config: only kinds whose definition grants the
    // ability lay mines (config/data/tank-defs.json), so the dispatcher holds no
    // "which kinds lay mines" knowledge.
    //
    // Directive B: this is the offense side of estimation error (targeting.ts's
    // friendlyInMineBlast doc comment) -- a perceived flee radius, drawn fresh here via
    // the same `perceiveHazards` house recipe grey.ts/teal.ts use for their own dodge gates.
    // Independently recomputed (a pure hash of world.seed/tank.id/refresh bucket, not
    // threaded state), so it lands on the identical belief those decision functions already
    // drew this tick without anything being passed between them.
    //
    // The real world, not the perceived one: `friendlyInMineBlast` scans tanks, and issue
    // #223's awareness delay is a hazard axis, not a targeting one. Only the radius is
    // perceived here.
    //
    // The back-dated world `perceiveHazards` builds is discarded here, deliberately (review
    // on PR #522). It is cheap in practice: measured over the golden-trace population, this
    // gate is reached on about 1% of AI tank-ticks, because every cheaper term
    // short-circuits ahead of it (`decision.mine` most of all). A radii-only helper would
    // save that allocation at the price of a second path computing perceived radii that
    // must stay bit-identical to this one or the baseline hash moves silently; one place
    // forms the belief. If this gate ever stops short-circuiting, re-measure before
    // revisiting.
    if (canAct && !tank.disarmed && hasAbility(tank.kind, TankAbility.MINE_LAYER) && decision.mine && tank.mineCooldown <= 0
      && !friendlyInMineBlast(world, tank, perceiveHazards(world, tank, configFor(tank.kind)).fleeRadius)) {
      if (dropMine(world, tank.id, events)) {
        tank.mineCooldown = MINE_COOLDOWN_TICKS;
      }
    }
  }
}
