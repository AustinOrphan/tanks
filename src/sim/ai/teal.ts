import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter, bankShot, dangerAvoidMove, incomingThreats, mineInclination, profileAimSpread, profileHazardSpread, estimationError, seekMove, shotHitsOwnSide, mineThreatensPlayer } from './targeting';
import { driveVelocity } from '../collision';
import { AI_MINE_FLEE_RADIUS, DANGER_CORRIDOR, AI_MINE_TACTICAL_RADIUS } from '../constants';

/** PROTOTYPE span, hardcoded until the profile field and its sweep land (issue #332). */
const SHOT_PLAN_SPAN_TICKS = 120;
import { configFor, type ResolvedTankConfig } from '../config';
import type { AiDecision } from './decision';

// The mobile/aggressive-behaviour implementation (decideAi routes TACTICAL --
// teal today -- plus the not-yet-shipped OFFENSIVE and BERSERKER behaviours here).
// `cfg` is injectable so tests can probe profile consumption.
export function tealDecision(world: World, tank: Tank, cfg: ResolvedTankConfig = configFor(tank.kind)): AiDecision {
  // Weapon (ricochet bullet, its muzzle speed, and its bounce budget) comes from
  // the resolved config -- Teal fires the RICOCHET_ROCKET its definition names.
  const weapon = cfg.weapon;
  // Directive B: perceived, not exact, hazard radii -- same per-tick, per-window draw
  // grey.ts uses (targeting.ts's estimationError/profileHazardSpread), reused below at
  // both dangerAvoidMove and the mine-threat gate.
  const hazardOffset = estimationError(world, tank, profileHazardSpread(cfg));
  const fleeRadius = AI_MINE_FLEE_RADIUS + hazardOffset;
  const dangerCorridor = DANGER_CORRIDOR + hazardOffset;
  const avoid = dangerAvoidMove(world, tank, fleeRadius, dangerCorridor);
  // Which hazard `avoid` escapes, for the commitment layer's sign rule (see AiDecision's
  // avoidKind). Unlike grey, teal has no `underFire` of its own to reuse, so this is a
  // second incomingThreats pass over the same perceived corridor -- bullets only, no wall
  // geometry, and skipped entirely when there is nothing to escape.
  const avoidKind = avoid === null
    ? null
    : incomingThreats(world, tank, dangerCorridor).length > 0 ? 'bullet' as const : 'mine' as const;
  // Mobile (spec §7): wander is the baseline move whenever there's nothing more specific
  // to do; dodging overrides it when a threat is present. This lets Teal keep roaming
  // (and reposition itself into new bank opportunities) instead of standing still as a
  // stationary turret while it has line-of-sight or a bank path.
  // The baseline move is the distance-band seek (targeting.ts seekMove): approach
  // beyond ai.preferredDistance, retreat-by-draw inside ai.minimumDistance, wander
  // in the band. Dodging still overrides it entirely.
  const move = avoid ?? seekMove(world, tank, cfg);

  // Aggressive (swapped from Grey): the dodge above overrides only `move`. Unlike Grey,
  // Teal does NOT hold fire while dodging and has no patience counter — it dodges and
  // shoots in the same tick, same as Grey used to. Nothing below consumes tank.aiTimer,
  // so nextTimer is always 0 on every path.
  // Finds the FIRST alive player-kind tank -- correct-as-P1-preferred, not wrong, at
  // playerCount > 1: a second human is simply invisible to this AI. Who AI targets
  // when two humans are on the board is balance work, deferred.
  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    // No target, but Teal is the MOBILE personality (spec §7): keep roaming, exactly as
    // Grey does in the same situation. Freezing at {0,0} here made Teal a stationary
    // target for the whole of every countdown and every player respawn -- a hardcoded
    // zero, not a decision. `move` already folds in the dodge when one is present.
    return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, hasSolution: false, fireType: weapon.bulletType, mine: false, nextState: 'idle', nextTimer: 0, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0 };
  }

  const speed = weapon.speed;
  // Raw solution existence, for the reaction clock (hasSolution): LINE OF SIGHT
  // or a bank path -- NOT the vetted, jittered firing angle. A teammate crossing
  // the lane holds the TRIGGER (shotHitsOwnSide below), but must not reset the
  // clock: review measured teal's clock zeroing where grey's kept 60 held ticks
  // on identical geometry, against the field's own doc. bankSeen is only known
  // when tryBank actually runs; when it doesn't, either the direct line exists
  // (sees) or the profile never banks -- both give the honest answer.
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

  // WHICH SHOT TYPE Teal prefers, held per tank instead of alternating on a global cycle
  // (issue #332). The preference still exists so Teal visibly performs both bank shots and
  // direct shots rather than banking only when the player happens to stand behind cover
  // (user decision: "alternate/mix"), and both orderings still fall through to the other
  // option when the preferred one is unavailable -- a preference, not an exclusion; Teal
  // never loses a shot it could have taken.
  //
  // What changed is WHEN it may turn over. `Math.floor(world.tick / BANK_PREFER_TICKS) % 2`
  // flipped every tank's preference on the same tick regardless of the engagement, and
  // because 120 is an exact multiple of the aim-jitter cadence the flip landed on a
  // boundary tick. Measured on this tree over 60 seeds x 2 arenas x 2 player policies,
  // isolating plan-boundary ticks from ordinary jitter boundaries: teal's aim-target step
  // there had a P95 of 52.83-64.91 degrees against 0.01-1.63 for every other kind, while
  // its MEDIAN was 0.00 -- the flip cost nothing most of the time and swung the gun most
  // of a half-turn in the tail, which reads as indecision rather than personality.
  //
  // THE RULE, and the reason it is not merely a longer cycle: a longer span reduces how
  // OFTEN the swing happens and does nothing to the size of it, which is what the metric
  // measures. The window may only turn the plan over on a tick where the held plan has NO
  // solution -- so the angle that tick is the fallback's either way, and the turnover adds
  // nothing on top of a takeover that was already happening. That is a property of the two
  // lines below, not an empirical claim. Solutions come and go as the player moves relative
  // to cover, and that is what keeps both plans in circulation.
  //
  // WHAT THIS DOES NOT DO, measured rather than assumed: it does not make a plan change
  // free to look at. On the ticks where the plan genuinely turned over, the aim-target step
  // has a median of 0.00 degrees but a P95 of 23.97-58.93 and a maximum of 92.90-137.10 --
  // because losing a solution moves the gun to the other plan's angle whether or not the
  // stored preference follows. What the gating removes is the ~150 flips per arena/policy
  // that used to happen while BOTH plans were solvable: plan changes fall from 199 and 163
  // to 38 and 25 over the same population. An earlier draft of this comment claimed the
  // turnover "moves no target"; the measurement above is what corrected it.
  const heldPlan = tank.aiShotPlan ?? null;
  const planTicks = tank.aiShotPlanTicks ?? 0;
  // The held plan is evaluated first, so `tryBank`'s O(walls^2) search is still only paid
  // when the plan in force is the bank one or the direct one came back empty.
  const preferBank = heldPlan === null ? true : heldPlan === 'bank';
  const preferred = preferBank ? tryBank() : tryDirect();
  const fallback = preferred === null ? (preferBank ? tryDirect() : tryBank()) : null;
  const turretAngle = preferred ?? fallback;
  // Lapsed AND unsolvable is the only way the plan turns over. Re-armed on the same plan
  // otherwise, so a window ending while the gun has a target is a no-op on screen.
  const lapsed = planTicks <= 1;
  const switching = lapsed && preferred === null;
  const nextShotPlan: 'bank' | 'direct' = switching ? (preferBank ? 'direct' : 'bank') : (preferBank ? 'bank' : 'direct');
  const nextShotPlanTicks = lapsed ? SHOT_PLAN_SPAN_TICKS : planTicks - 1;

  // Teal now lays mines too (mirrors Grey's rule). Only while NOT dodging: a mine dropped
  // mid-dodge is wasted and risks self-trapping. MINE_CAP is checked here as
  // defence-in-depth: dropMine enforces this cap for every owner too, but checking it
  // here avoids burning tank.mineCooldown on a request dropMine would refuse anyway.
  // Also gated on the player being near enough for the mine to matter -- see
  // mineThreatensPlayer. Availability is not a reason to lay ordnance.
  // Profile-drawn inclination, as in grey.ts: the chance's magnitude is the
  // per-window probability of proposing.
  const mine = mineInclination(world, tank, cfg)
    && !avoid && tank.mineCooldown <= 0 && tank.activeMineIds.length < cfg.mineCapacity
    && mineThreatensPlayer(world, tank, AI_MINE_TACTICAL_RADIUS + hazardOffset);

  if (turretAngle !== null) {
    return { desiredMove: move, turretAngle, fire: true, hasSolution: true, fireType: weapon.bulletType, mine, nextState: 'fire', nextTimer: 0, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0, nextShotPlan, nextShotPlanTicks };
  }


  // Neither exists: reposition. Teal never falls back to a direct/rocket shot (spec §7).
  return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, hasSolution: sees || bankSeen, fireType: weapon.bulletType, mine, nextState: 'reposition', nextTimer: 0, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0, nextShotPlan, nextShotPlanTicks };
}
