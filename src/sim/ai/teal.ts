import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter, bankShot, dangerAvoidMove, incomingThreats, mineInclination, profileAimSpread, seekMove, shotHitsOwnSide, mineThreatensPlayer, resolveOpponent } from './targeting';
import { perceiveHazards } from './hazard-perception';
import { driveVelocity } from '../collision';
import { TICK_HZ } from '../constants';
import { configFor, type ResolvedTankConfig } from '../config';
import type { AiDecision } from './decision';

// The mobile/aggressive-behaviour implementation (decideAi routes TACTICAL --
// teal and yellow today -- plus the not-yet-shipped OFFENSIVE and BERSERKER behaviours here).
// `cfg` is injectable so tests can probe profile consumption.
export function tealDecision(world: World, tank: Tank, cfg: ResolvedTankConfig = configFor(tank.kind)): AiDecision {
  // Weapon (ricochet bullet, its muzzle speed, and its bounce budget) comes from
  // the resolved config -- Teal fires the RICOCHET_ROCKET its definition names.
  const weapon = cfg.weapon;
  // Directive B, widened to issue #223's whole hazard picture -- the same per-window
  // snapshot grey.ts takes (ai/hazard-perception.ts), reused below at both dangerAvoidMove
  // and the mine-threat gate. `hazard.world` carries teal's own back-dated shells and the
  // mines it has noticed; targeting and line of sight still read the real world.
  const hazard = perceiveHazards(world, tank, cfg);
  const seen = hazard.world;
  const fleeRadius = hazard.fleeRadius;
  const dangerCorridor = hazard.dangerCorridor;
  const avoid = dangerAvoidMove(seen, tank, fleeRadius, dangerCorridor);
  // Which hazard `avoid` escapes, for the commitment layer's sign rule (see AiDecision's
  // avoidKind). Unlike grey, teal has no `underFire` of its own to reuse, so this is a
  // second incomingThreats pass over the same perceived corridor -- bullets only, no wall
  // geometry, and skipped entirely when there is nothing to escape.
  const avoidKind = avoid === null
    ? null
    : incomingThreats(seen, tank, dangerCorridor).length > 0 ? 'bullet' as const : 'mine' as const;
  // Mobile (spec §7): the baseline move is the distance-band seek (targeting.ts seekMove) --
  // approach beyond ai.preferredDistance, retreat-by-draw inside ai.minimumDistance, wander
  // in the band -- so Teal keeps roaming (and repositions itself into new bank
  // opportunities) instead of standing still as a stationary turret while it has
  // line-of-sight or a bank path. Dodging overrides it entirely when a threat is present.
  const move = avoid ?? seekMove(world, tank, cfg);

  // Aggressive: the dodge above overrides only `move`. Unlike Grey, Teal does not hold fire
  // while dodging and has no patience counter -- it dodges and shoots in the same tick.
  // Nothing below consumes tank.aiTimer, so nextTimer is always 0 on every path.
  // Which shot type Teal prefers, held per tank for a window (issue #332). The preference
  // exists so Teal visibly performs both bank shots and direct shots rather than banking
  // only when the player happens to stand behind cover (user decision: "alternate/mix"), and
  // both orderings fall through to the other option when the preferred one is unavailable
  // -- a preference, not an exclusion; Teal never loses a shot it could have taken.
  //
  // The window may only turn the plan over on a tick where the held plan has no solution --
  // so the angle that tick is the fallback's either way, and the turnover adds nothing on
  // top of a takeover that was already happening. That is a property of the `switching`
  // line below, not an empirical claim, and it is why this is not merely a longer cycle: a
  // longer span reduces how often the gun swings, not how far (under a shared tick-based
  // cycle, teal's aim-target step at plan boundaries had a P95 of 52.83-64.91 degrees,
  // against 0.01-1.63 for every other kind). Solutions come and go as the player moves
  // relative to cover, and that is what keeps both plans in circulation.
  //
  // This does not make a plan change free to look at: losing a solution moves the gun to the
  // other plan's angle whether or not the stored preference follows (P95 23.97-58.93 degrees
  // on real turnover ticks). What the gating removes is the flips while both plans were
  // solvable: measured plan turnovers fell from 348 and 276 to 38 and 25 over 60 seeds x 2
  // arenas x 2 player policies.
  //
  // Read here, above the no-target return below, on purpose. `stepAi` writes the pair back
  // only when the decision carries one, so a return path that omits it freezes the
  // countdown -- and the window would then be longer than the profile says by however long
  // the arena spends without a live player (every countdown, every player death). Every
  // return in this function carries the pair for that reason.
  const heldPlan = tank.aiShotPlan ?? null;
  const planTicks = tank.aiShotPlanTicks ?? 0;
  // The held plan is evaluated first, so `tryBank`'s O(walls^2) search is still only paid
  // when the plan in force is the bank one or the direct one came back empty.
  const preferBank = heldPlan === null ? true : heldPlan === 'bank';
  const holdPlan: 'bank' | 'direct' = preferBank ? 'bank' : 'direct';
  // Re-armed from the profile in seconds, the same conversion commitMove and holdAimFor use.
  const lapsed = planTicks <= 1;
  const nextShotPlanTicks = lapsed ? Math.round(cfg.ai.shotCommitmentTime * TICK_HZ) : planTicks - 1;

  // Resolved centrally (issue #359): every behaviour asks the same question of the same
  // function, so the multi-player policy -- a per-AI commitment window, a seeded tie-break,
  // a perception bound (ai/target-selection.ts) -- lives in one place.
  const player = resolveOpponent(world, tank, cfg);
  if (!player) {
    // No target, but Teal is the mobile personality (spec §7): keep roaming, as Grey does
    // in the same situation, rather than freezing in place. `move` already folds in the
    // dodge when one is present.
    return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, hasSolution: false, fireType: weapon.bulletType, mine: false, nextState: 'idle', nextTimer: 0, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0, nextShotPlan: holdPlan, nextShotPlanTicks };
  }

  const speed = weapon.speed;
  // Raw solution existence, for the reaction clock (hasSolution): line of sight
  // or a bank path -- not the vetted, jittered firing angle. A teammate crossing
  // the lane holds the trigger (shotHitsOwnSide below), but must not reset the
  // clock. bankSeen is only known when tryBank actually runs; when it doesn't,
  // either the direct line exists (sees) or the profile never banks -- both give
  // the honest answer.
  const sees = lineOfSight(tank.pos, player.pos, world.walls);
  let bankSeen = false;

  // Jitter is applied to BOTH the direct and bank solutions, right where each is
  // computed, so it's present regardless of which path preferBank ends up taking (and
  // never touches the reposition fallback's held/passthrough angle below).
  // Both solutions are additionally vetted with shotHitsOwnSide: lineOfSight/bankShot only
  // test walls, but resolveBulletHits kills any non-owner tank the shell touches -- and,
  // once a ricochet turns around, the shooter too. Returning null (rather than gating
  // `fire` at the end) is what lets the OTHER shot type still be tried: Teal loses the
  // blocked shot, not the whole tick.
  function tryDirect(): number | null {
    // Profile-gated: a profile weighted entirely off direct shots never takes one.
    // (Both weights are read as inclinations -- attempted at all or not; the shipped
    // MOBILE_MINE_LAYER carries 0.85/0.15, so both paths stay active for teal.)
    if (cfg.ai.directShotWeight <= 0) return null;
    if (!sees) return null;
    const targetVel = driveVelocity(player!);
    const angle = aimLead(tank.pos, player!.pos, targetVel, speed) + aimJitter(world, tank, profileAimSpread(cfg));
    return shotHitsOwnSide(world, tank, angle, weapon.bulletType) ? null : angle;
  }
  // bankShot is O(walls^2): each surviving wall face runs two full losIgnoring scans.
  // Measured fine at ARENA_01's wall count (~480 ray tests/tick/Teal, microseconds); a
  // much denser arena would want throttling. Evaluated lazily below so the non-preferred
  // option only pays this cost when the preferred option actually fails.
  function tryBank(): number | null {
    // Profile-gated, mirror of tryDirect: no bank inclination, no bank attempt --
    // which also skips the O(walls^2) search below for profiles that never bank.
    if (cfg.ai.bankShotWeight <= 0) return null;
    const raw = bankShot(tank.pos, player!.pos, world.walls, weapon.ricochetCount);
    bankSeen = raw !== null;
    if (raw === null) return null;
    const angle = raw + aimJitter(world, tank, profileAimSpread(cfg));
    return shotHitsOwnSide(world, tank, angle, weapon.bulletType) ? null : angle;
  }

  const preferred = preferBank ? tryBank() : tryDirect();
  const fallback = preferred === null ? (preferBank ? tryDirect() : tryBank()) : null;
  const turretAngle = preferred ?? fallback;
  // Lapsed AND unsolvable is the only way the plan turns over. Re-armed on the same plan
  // otherwise, so a window ending while the gun has a target is a no-op on screen.
  const switching = lapsed && preferred === null;
  const nextShotPlan: 'bank' | 'direct' = switching ? (preferBank ? 'direct' : 'bank') : holdPlan;

  // Teal lays mines too (mirrors Grey's rule). Only while not dodging: a mine dropped
  // mid-dodge is wasted and risks self-trapping. The mine cap (cfg.mineCapacity) is checked
  // here as defence-in-depth: dropMine enforces a cap for every owner too, but checking it
  // here avoids burning tank.mineCooldown on a request dropMine would refuse anyway.
  // Also gated on the player being near enough for the mine to matter -- see
  // mineThreatensPlayer. Availability is not a reason to lay ordnance.
  // Profile-drawn inclination, as in grey.ts: the chance's magnitude is the
  // per-window probability of proposing.
  const mine = mineInclination(world, tank, cfg)
    && !avoid && tank.mineCooldown <= 0 && tank.activeMineIds.length < cfg.mineCapacity
    && mineThreatensPlayer(world, tank, hazard.tacticalRadius);

  if (turretAngle !== null) {
    return { desiredMove: move, turretAngle, fire: true, hasSolution: true, fireType: weapon.bulletType, mine, nextState: 'fire', nextTimer: 0, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0, nextShotPlan, nextShotPlanTicks };
  }


  // Neither exists: reposition.
  return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, hasSolution: sees || bankSeen, fireType: weapon.bulletType, mine, nextState: 'reposition', nextTimer: 0, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0, nextShotPlan, nextShotPlanTicks };
}
