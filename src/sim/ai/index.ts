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

  // THE AIM-HOLD LAYER (issue #344), applied centrally beside the commitment layer and
  // for the same reasons. It replaces only `turretAngle` and its write-back pair.
  //
  // `hasSolution` and `fire` are deliberately left reading the FRESH solution: this holds
  // where the tank has decided to point, not whether it believes it has a shot, and the
  // dispatcher below re-vets friendly fire against the ACTUAL post-slew angle anyway. A
  // held aim that has drifted off target simply misses, which is the cost the profile's
  // aimHoldTime is tuned against -- it is not allowed to become a stealth accuracy buff.
  //
  // IDLE SEARCH (issue #371) feeds this layer rather than sitting beside it: a search
  // heading is just another aim solution, so routing it through holdAimFor gives it the
  // same hold span, the same break test and the same slew as a real firing solution, and
  // there is only ever one place that decides where the barrel is going.
  //
  // `hasSolution` is the switch because it is already the dispatcher's answer to "does
  // this tank have something to point at" -- it is what feeds tank.aimTicks, and it is
  // false on exactly the branches where every personality passes `tank.turretAngle`
  // straight through. A tank that CAN see a target but is holding fire keeps tracking it,
  // because its solution exists; only a tank with nothing to aim at searches.
  // THREE WAYS THE BARREL GETS A TARGET, in the order the issues hand off to each other:
  // a live firing solution (the personality's), then #372's remembered contact, then #371's
  // search. Each is strictly less informed than the one before it, which is the whole shape
  // of the perception model -- a tank that has just lost sight looks where its target WAS,
  // and only starts sweeping once that memory expires.
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

    // The committed opponent is resolved BEFORE the decision, so every call `decideAi`
    // makes to resolveOpponent this tick reads one answer (issue #359). Running it after
    // would leave the decision on last tick's target and write the new one for the next,
    // which is a one-tick lag that only shows up when a target dies.
    commitTarget(world, tank);
    // Immediately after the commitment and before the decision, so the memory always
    // concerns the opponent this tank is committed to RIGHT NOW (issue #372's dependency
    // note) and the decision below reads a memory that is current for this tick.
    updateTargetMemory(world, tank, resolveOpponent(world, tank, configFor(tank.kind)));
    const decision = decideAi(world, tank);
    // The reaction clock: consecutive ticks a firing solution has been HELD
    // (see AiDecision.hasSolution) IN LIVE PLAY. Accumulated here, where the
    // per-tick truth arrives; losing the solution resets it, so cover breaks
    // the clock.
    //
    // It used to accumulate through the countdown as well, deliberately -- the
    // argument being that an enemy which can see (or bank on) the player during
    // the announced, fire-free phase has been aiming that whole time and has
    // earned the shot at the bell. Issue #367 reverses that: the countdown is a
    // phase in which the PLAYER cannot act either, so time spent in it satisfying
    // a reaction requirement is time the player was given no chance to answer.
    // Measured before the reversal, on arena 1: teal held all 180 countdown ticks
    // and fired 1 tick into live, which is the same first-shot timing the profile
    // reaction gate exists to prevent.
    //
    // The phase, not `canAct`. The two agree only while GRACE_TICKS is 0
    // (constants.ts); re-enabling grace would make `canAct` false for a phase in
    // which tanks move and hunt, and the rule this implements is "start at LIVE
    // acquisition", not "start when firing is allowed".
    //
    // Reset to 0 rather than frozen: nothing else reads `aimTicks` -- the only
    // other consumer is the fire gate below -- so the two are observationally
    // identical, and resetting is what "starts from live acquisition" means
    // literally rather than by argument. `resetArena` zeroes it too (world.ts),
    // so a post-death countdown gets the same rule as the opening one.
    //
    // What this does NOT change: the turret still tracks through the countdown
    // (that happens inside `decideAi` above), so the shot at the bell stays
    // telegraphed. Only the clock is held.
    tank.aimTicks = phase === 'live' && decision.hasSolution ? (tank.aimTicks ?? 0) + 1 : 0;
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
    // The held aim angle and its countdown, written back beside the movement pair above
    // and for the same reason: decisions stay pure and the dispatcher owns the write
    // (issue #344). Cleared to undefined rather than left stale when nothing is held, so
    // "no held aim" is genuinely absent rather than an angle of 0 that reads as due east.
    tank.aiAimHeld = decision.nextAimHeld ?? undefined;
    tank.aiAimHeldTicks = decision.nextAimHeldTicks;
    // The held shot plan (issue #332). Written only when the decision carried one, so a
    // behaviour that never evaluates a shot plan leaves whatever it held untouched rather
    // than clearing it -- see AiDecision.nextShotPlan for why absence means "no opinion"
    // here and `null` means "clear" for the intent and aim-hold pairs above.
    //
    // The corollary is a trap, and teal.ts's no-target return is where it was found: a
    // decision path that FORGETS the pair silently freezes the countdown instead of
    // erroring, so the window runs longer than the profile authorises.
    if (decision.nextShotPlan !== undefined) {
      tank.aiShotPlan = decision.nextShotPlan;
      tank.aiShotPlanTicks = decision.nextShotPlanTicks;
    }

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
    // Measured on the 60-seed engagement harness when the gate SHIPPED, reference spans
    // as-is (brown 48 / grey 42 / olive 39 / teal 36 ticks). These are the gate's own
    // before/after and predate issue #367; they are not a current reading of the tree:
    //   without the gate: a1 losses 58/60, freeWins 2/60, medianTicks 1496
    //   with the gate:    a1 losses 57/60, freeWins 3/60, medianTicks 1671
    //   (arena 3: 60/60 both rows; 1750 -> 1852; pacifist suite passes)
    //
    // ISSUE #367's own cost, re-measured on pacifist.test.ts's 60 seeds by running that
    // shipped harness with and without the phase term above and changing nothing else:
    //   before #367: freeWins 0/60, losses 60/60, 35.18 shots/round, 2.62 mines/round,
    //                median kill 1510 ticks
    //   after  #367: freeWins 2/60, losses 58/60, 31.67 shots/round, 2.77 mines/round,
    //                median kill 1534 ticks
    // Two rounds in sixty are now winnable by a player who never fires, against that
    // suite's MAX_FREE_WIN_RATE of 0.05 (3/60) -- inside the bar, and the direction is
    // the point rather than a surprise: the enemies gave up a free opening shot, so a
    // passive player survives a little more often. Kills land ~1.6% later.
    //
    // That delta is THIS clock's, not the branch's: `playPacifist` drives its player from
    // its own `mulberry` wander and never calls `decidePlayerInput`, so the scripted
    // player's matching gate (player-profile.ts) cannot move these numbers.
    // Kills arrive ~6-12% later and every cover-break punish is telegraphed by
    // the profile's span. 3/60 sits ON the pacifist boundary (as the pre-series
    // baseline did): an earlier draft measured 0/60, but that draft's teal
    // clock was resetting on teammate crossings against hasSolution's own
    // semantics -- review caught it, and the correct clock gives teal back its
    // instant shot when a mate clears the lane. Correct semantics kept over
    // the nicer number.
    const reactionTicks = Math.round(configFor(tank.kind).ai.reactionTime * TICK_HZ);
    // THE BARREL MUST HAVE ARRIVED (issue #371). `aimTicks` measures how long a solution
    // has EXISTED, never whether the gun got there, so before this a tank could fire with
    // a matured reaction clock while the barrel still pointed somewhere else entirely --
    // and the shot goes where the barrel points, deliberately (see the comment below).
    //
    // Latent until idle search shipped, because a tracking turret was already near its
    // solution: the barrel only ever sat far from it after the tank had been pointing
    // somewhere unrelated. Measured over pacifist.test.ts's 60 seeds, search WITHOUT this
    // gate took AI-on-AI shell kills from 38 to 51 on an unchanged shot count (1992 ->
    // 1987) -- not more shooting, just wider shooting, ricocheting back into its own side
    // in a boxed arena.
    //
    // AI_AIM_BREAK is reused rather than a new tolerance invented: it is already this
    // codebase's answer to "are these two angles the same aim", used by the aim-hold layer
    // to decide a held solution is still current. Firing exactly when the barrel is inside
    // that same tolerance keeps one definition of "on target" instead of two.
    const onTarget = Math.abs(angleDelta(tank.turretAngle, decision.turretAngle)) <= AI_AIM_BREAK;
    if (canAct && !tank.disarmed && decision.fire && onTarget && tank.fireCooldown <= 0 && (tank.aimTicks ?? 0) >= reactionTicks && !shotHitsOwnSide(world, tank, tank.turretAngle, decision.fireType)) {
      // Fire along the tank's ACTUAL (post-slew) turret angle, not the decision's desired
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
    // the same `perceiveHazards` house recipe grey.ts/teal.ts use for their own dodge gates.
    // Independently recomputed (a pure hash of world.seed/tank.id/refresh bucket, not
    // threaded state), so it lands on the identical belief those decision functions already
    // drew this tick without anything being passed between them.
    //
    // The REAL world, not the perceived one: `friendlyInMineBlast` scans TANKS, and issue
    // #223's awareness delay is a hazard axis -- a bot that also mislaid its teammates would
    // be a targeting change wearing this issue's label. Only the radius is perceived here.
    //
    // AND THE BACK-DATED WORLD `perceiveHazards` BUILDS IS DISCARDED HERE, deliberately, on
    // review (PR #522). It reads as waste, so it is worth knowing how much: MEASURED over
    // the golden-trace population (8 arenas x 6 seeds x 2500 ticks), this gate is reached
    // 2419 times against 234978 AI tank-ticks -- 1.03%, one tick in 97 -- because every
    // cheap term short-circuits ahead of it, `decision.mine` most of all (itself gated on
    // `mineInclination`'s ~0.3 per-window draw, `!avoid`, the cap and `mineThreatensPlayer`).
    // Those 2419 calls are 1.70% of the 141926 `perceiveHazards` calls in the same run, and
    // about 2217 of them allocate: two arrays plus a mean of 3.23 shell copies each.
    //
    // A radii-only helper would save exactly that, at the price of a SECOND path computing
    // the perceived radii that must stay bit-identical to this one or the baseline hash moves
    // silently. This module exists so one place forms the belief; buying back ~2200 tiny
    // allocations per 48 full games is not worth a second definition of what a tank believes.
    // If this gate ever stops short-circuiting, re-measure before revisiting.
    if (canAct && !tank.disarmed && hasAbility(tank.kind, TankAbility.MINE_LAYER) && decision.mine && tank.mineCooldown <= 0
      && !friendlyInMineBlast(world, tank, perceiveHazards(world, tank, configFor(tank.kind)).fleeRadius)) {
      if (dropMine(world, tank.id, events)) {
        tank.mineCooldown = MINE_COOLDOWN_TICKS;
      }
    }
  }
}
