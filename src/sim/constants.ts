import type { BulletType } from './types';
// The balance scalars. config/data/balance.json is their authoritative home; this
// module derives its exports from that data (and stays the one import site the rest
// of the sim knows). Retuning one pinned by constants.test.ts is a deliberate
// two-file edit -- the JSON entry and its pin there -- and the JSON is a build-time
// static import, so the sim stays pure and replays stay exact functions of their
// inputs. Everything else (epsilons, derived radii, most tick counts, and
// SHELL_MUZZLE_FORWARD, whose value is coupled to the rendered barrel geometry)
// remains TypeScript below.
import data from './config/data/balance.json';

// ---- Simulation timing ----
export const TICK_HZ = 60;
export const DT = 1 / 60;

// ---- Tanks ----
export const TANK_RADIUS = data.tank.radius;
export const TANK_SPEED = data.tank.speed;

// ---- Bullets ----
export const BULLET_RADIUS = data.shells.radius;
/**
 * The muzzle plane: distance from tank centre to the barrel opening, in the firing
 * direction. Tuned to match the rendered muzzle reach from the gameplay camera.
 *
 * This lives in the sim because the sim decides where the gun ends. The render derives
 * its barrel length from it (tank-model.ts: BARREL_OUT = SHELL_MUZZLE_FORWARD - TURRET_R),
 * so the drawn muzzle is exactly the plane the sim fires from -- lengthening the gun
 * moves everything with it.
 *
 * Firing effects belong here, not at the shell's centre: the `fire` event carries this
 * point, so the muzzle flash stays on the barrel opening even though the shell itself is
 * born behind it (issue #237).
 */
export const SHELL_MUZZLE_FORWARD = 0.85;

/**
 * How far the drawn shell reaches ahead of its simulated centre, in bullet-radii.
 *
 * This is a render measurement that the sim has to know, which is why it is a bare number
 * here rather than an import: `src/sim` may not read `src/render`. It is 3.25 because
 * entities.ts builds a shell as a cylinder of SHELL_BODY_LEN = BULLET_RADIUS * 4.5 centred
 * on the shell's position, capped with a nose sphere of SHELL_R = BULLET_RADIUS * 1.0
 * centred on the cylinder's end -- so the nose reaches BULLET_RADIUS * (4.5 / 2 + 1).
 *
 * Keyed to the drawn length, not to BULLET_RADIUS alone. The obvious inset is one
 * collision radius, and it is wrong: the renderer deliberately draws a shell far larger
 * than it collides ("drawn dead-on it is nearly invisible, so the body is scaled up and
 * given length" -- entities.ts), and it is that exaggerated body, not the 0.1-radius
 * collision circle, that the player sees clear the barrel. Insetting by BULLET_RADIUS
 * leaves the visible nose 0.225 past the opening and the pop entirely intact.
 *
 * Because the justification lives in the renderer, entities.test.ts pins this both ways
 * against the built shell mesh's measured nose reach: retuning SHELL_BODY_LEN or SHELL_R
 * without moving this number fails there. That pin is the only thing keeping the two
 * files honest, since the dependency cannot be expressed as an import.
 */
export const SHELL_NOSE_REACH_RADII = 3.25;

/**
 * Distance from tank centre to the shell's CENTRE at spawn: the muzzle plane less the
 * shell's drawn nose reach, so its visible nose begins at the opening (issue #237).
 *
 * Separate from SHELL_MUZZLE_FORWARD because a centre at the muzzle plane puts the nose clear
 * of the barrel on the first frame, which reads as a pop. Insetting the centre while leaving
 * the plane alone fixes that without shortening the drawn gun, which is why BARREL_OUT
 * derives from the plane rather than from this.
 *
 * The shell starts inside the barrel on purpose. At 0.525 the drawn body spans [0.3, 0.85]
 * inside a barrel tube [TURRET_R = 0.36, 0.85] wider than the shell, so the round slides out
 * over the first few ticks (5.5 at NORMAL_SPEED, 2.8 at FAST_SPEED); the tail's last 0.06
 * sits inside the opaque turret dome.
 *
 * The spawn circle overlaps the owner's hull (0.425 against TANK_RADIUS = 0.5). That is safe
 * only because resolveBulletHits exempts the owner while `vdot(b.vel, toOwner) <= 0`, which
 * holds for any shell leaving the muzzle; the exemption is load-bearing here.
 *
 * Derived through `shellSpawnForward` so a shell with a different radius insets by its own
 * drawn reach; bullets.test.ts varies the radius to prove the derivation is live.
 */
export function shellSpawnForward(bulletRadius: number): number {
  return SHELL_MUZZLE_FORWARD - bulletRadius * SHELL_NOSE_REACH_RADII;
}
export const SHELL_SPAWN_FORWARD = shellSpawnForward(BULLET_RADIUS);

export const NORMAL_SPEED = data.shells.normal.speed;
export const FAST_SPEED = data.shells.fast.speed;
export const RICOCHET_SPEED = data.shells.ricochet.speed;

export const NORMAL_BOUNCES = data.shells.normal.bounces;
export const FAST_BOUNCES = data.shells.fast.bounces;
export const RICOCHET_BOUNCES = data.shells.ricochet.bounces;

// ---- Resource caps ----
// The spec's default per-tank caps. A cap applies to every tank, player and AI alike, and
// is enforced at the shared spawn chokepoints (dropMine/spawnBullet) regardless of
// owner.kind -- but from each owner's resolved capacity (configFor), which differs from
// these for some kinds (olive: 1 shell, no mines; yellow: 4 mines). AI decision functions
// may also self-check a cap as defence-in-depth, e.g. to avoid burning a cooldown on a
// request that would be refused anyway.
export const SHELL_CAP = data.shells.cap;
export const MINE_CAP = data.mines.cap;

// ---- Cooldowns (seconds) ----
export const FIRE_COOLDOWN = data.shells.cooldownSeconds;
export const MINE_COOLDOWN = data.mines.cooldownSeconds;

/**
 * The same two cooldowns as whole ticks, which is what the sim actually counts.
 *
 * Storing seconds and subtracting DT once per tick does not land on zero:
 * repeated subtraction accumulates rounding, so after the intended 24
 * decrements FIRE_COOLDOWN sits a hair above zero and the `<= 0` gate needs one
 * more tick (0.4s would deliver a 25-tick cadence, 0.5s a 31-tick one). The
 * one-shot form 0.4 - 24*DT is exactly zero; only the iterated form drifts,
 * which is why this is easy to miss by inspection.
 *
 * Integers decremented by 1 cannot drift, so the cadence is exactly what the
 * seconds above say.
 */
export const FIRE_COOLDOWN_TICKS = Math.round(FIRE_COOLDOWN * TICK_HZ);
export const MINE_COOLDOWN_TICKS = Math.round(MINE_COOLDOWN * TICK_HZ);

// ---- Mines ----
export const MINE_TIMER = data.mines.timerSeconds;
/**
 * Source-specific mine warning timings (issue #275, owner-revised on PR #311):
 * the three trigger sources deliberately do not share one post-trigger delay.
 *
 * - `MINE_FUSE_WARNING_TICKS`: the final portion of the existing fuse -- when
 *   `timer` enters this window a one-shot `mine-fuse-warning` event fires ("time
 *   is running out", #276's cue), and expiry still detonates exactly when it
 *   always did. No time is added after the fuse.
 * - `MINE_PROXIMITY_DELAY_TICKS`: the short deterministic reaction window between
 *   tripping an armed mine (proximity entry -- `mine-triggered`, "you tripped
 *   this") and its blast. The one place a post-trigger delay exists.
 * - A shell hit detonates an armed mine immediately (bullets.ts) -- shooting a
 *   mine is deliberately setting it off, and the skill-shot credit rides the
 *   blast with no delay.
 *
 * Both values are 30 ticks (500 ms at 60 Hz) initially -- separately named and
 * separately configured because the semantics differ; #277 owns tuning each.
 * Simulation ticks, never wall clock: the proximity countdown decrements once
 * per stepMines call and the fuse window is measured on the sim's own dt timer.
 */
export const MINE_FUSE_WARNING_TICKS = data.mines.fuseWarningTicks;
export const MINE_PROXIMITY_DELAY_TICKS = data.mines.proximityDelayTicks;
export const MINE_PROXIMITY_RADIUS = data.mines.proximityRadius;
export const MINE_BLAST_RADIUS = data.mines.blastRadius;

/**
 * A detonation is not instantaneous: the blast grows to MINE_BLAST_RADIUS,
 * holds there, then is gone. Very fast, but not instant -- fast enough that you
 * cannot outrun one you are standing in, slow enough that the edge sweeping
 * outward is something you can see and, at the fringe, escape.
 *
 * 5 ticks each at 60Hz: about 83ms expanding, 83ms at full size, 167ms total.
 * A tank dies on the tick the edge reaches it, not the tick the mine went off.
 */
export const MINE_BLAST_EXPAND_TICKS = 5;
export const MINE_BLAST_HOLD_TICKS = 5;

/**
 * How close a shell must pass to set a mine off.
 *
 * The mine's own body, not its blast: a shell should have to hit the thing, not
 * merely enter the radius it would kill in. MINE_BLAST_RADIUS is 2.0, nearly six
 * times this -- using that here would make every mine a 2-unit shell trap.
 */
export const MINE_TRIGGER_RADIUS = data.mines.triggerRadius;

/**
 * Does a mine's blast continue past a destructible wall on its way to a tank?
 *
 * Solid walls always stop it -- being killed through intact cover is a defect,
 * not a design. Destructible ones are a judgement call: the wall is destroyed by
 * the same detonation either way, so the question is only whether it absorbs the
 * blast on its way out. `true` says a blast strong enough to shatter a wall does
 * not politely stop at it; `false` would make destructible walls one-use cover.
 *
 * A build-time constant, deliberately, not a runtime flag: src/sim/ is a pure
 * deterministic core and a replay must stay an exact function of its inputs.
 */
export const MINE_BLAST_THROUGH_DESTRUCTIBLE = true;

// ---- Meta ----
export const LIVES = data.lives;

/**
 * Versus's Smash-style life counter (n-player arc, stock PR): how many respawns each
 * player-kind tank starts an FFA/teams match with -- see Tank.stockRemaining (types.ts)
 * and world.ts's resolveStatusFfa/resolveStatusTeams. Distinct from LIVES, which is
 * campaign-coop's own shared/per-round pool (world.lives): stock is tracked per tank,
 * never shared, and a tank's last death eliminates it rather than restarting a round.
 */
export const VERSUS_STOCK = data.versusStock;

// ---- Round phases (roundPhase, applied uniformly to player + AI) ----
// Two phases run before normal play, timed from `world.roundStartTick` (reset on every
// resetArena, so every arena restart after a lost life gets the same protection as the
// very start of the game; per-tank respawns do not, see below):
//   countdown -- nobody can move or fire; turret aim still updates so the player can
//     orient before combat starts.
//   grace     -- everyone can move; nobody can fire or lay mines, giving both sides
//     maneuvering room before the first shot.
// COUNTDOWN_TICKS = 180 ticks = 3s at 60Hz (TICK_HZ).
export const COUNTDOWN_TICKS = 180;
// GRACE_TICKS is 0: the grace phase is off.
//
// It existed so a respawned player was not shot the instant a life began, but it cost
// two seconds of standing still unable to fire, on every death, with nothing on screen
// explaining why. The phase machinery and its tests stay -- roundPhase still returns
// 'grace' whenever this is positive -- so restoring it is this one number.
export const GRACE_TICKS = 0;

// ---- Per-tank respawn (stepRespawns, resolveStatusCoop/resolveStatusFfa/
// resolveStatusTeams -- world.ts) ----
// Feel values: tests pin behavior against the constant, not a hardcoded tick count, and
// constants.test.ts pins each value in seconds. Deliberately not GRACE_TICKS/roundPhase --
// that machinery is world-scoped (one roundStartTick drives every tank), and reusing it
// for an individual respawn would freeze every other live tank's fire/movement too, which
// is exactly wrong mid-fight. See the coop semantics plan
// (docs/superpowers/plans/2026-08-15-coop-semantics.md). Shared by versus's stock
// respawns (the stock PR) rather than given a second pair of constants -- versus's
// respawn timing and post-revival grace are not new feel values, they are coop's own.
//
// RESPAWN_DELAY_TICKS = 120 ticks = 2.0s at 60Hz: how long a corpse waits before
// reviving (at its own spawn in coop; at a `pickVersusSpawnCell`-chosen cell in
// versus -- see stepRespawns).
export const RESPAWN_DELAY_TICKS = 120;
// RESPAWN_SHIELD_TICKS = 90 ticks = 1.5s: post-revival damage immunity. Stands in for
// everything resetArena would otherwise have guaranteed safe (wall state, the
// partner's live ordnance, a no-sightline spawn) -- see isDamageImmune (types.ts).
export const RESPAWN_SHIELD_TICKS = 90;

// ---- Collision sweep (reflectSweep) ----
export const SWEEP_EPS = 1e-7;
export const SWEEP_MAX_ITERATIONS = 16;

// ---- AI targeting (aimLead) ----
// Pure non-degeneracy guard for the intercept quadratic, not a physical
// tolerance: it is compared against several dimensionally distinct
// quantities (a: speed^2, b: position*speed, t: seconds), so it has no
// single physical unit of its own.
export const AIM_EPS = 1e-9;

// ---- AI danger avoidance (incomingThreats, dangerAvoidMove) ----
export const VEC_EPS = 1e-6; // zero-length-vector degeneracy guard
export const THREAT_HORIZON = 1.0; // seconds of lookahead for incoming bullets
export const DANGER_CORRIDOR = TANK_RADIUS + 0.3; // lateral half-width the bullet may pass within

// ---- AI mine avoidance (dangerAvoidMove) ----
// The radius at which an AI starts running from an armed mine. It must be derived from
// the radius detonateMine actually kills at (MINE_BLAST_RADIUS + TANK_RADIUS = 2.5),
// never from MINE_PROXIMITY_RADIUS -- proximity is only the *trigger* radius (1.5), and
// guarding on it would leave the AI standing calmly inside a 1.0-unit-thick shell of the
// lethal zone. On top of the lethal radius sits a reaction margin: fleeing at exactly the
// kill distance is fleeing from inside the blast with zero time to leave it, so the margin
// is the distance a tank actually covers at TANK_SPEED in AI_MINE_FLEE_TICKS.
export const AI_MINE_FLEE_TICKS = 15; // 0.25s at 60Hz
export const AI_MINE_FLEE_MARGIN = TANK_SPEED * AI_MINE_FLEE_TICKS * DT; // 0.75 units
export const AI_MINE_FLEE_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS + AI_MINE_FLEE_MARGIN; // 3.25
// How near the player has to be for laying a mine to be worth doing at all.
//
// Mines are area denial: one goes down to threaten ground the player is actually
// contesting, not to mark where a tank happened to be standing. Without this gate a roamer
// alone in a corner litters the floor with live ordnance it then has to dodge.
//
// Derived, not picked: the blast kills out to MINE_BLAST_RADIUS + TANK_RADIUS, and a player
// within two seconds' travel of that edge can still be caught by, or forced to respect, a
// 3-second fuse. Being a radius around the drop point it also permits a deliberate burst --
// while the player stays close a tank may still lay its full mine capacity back to back,
// which is exactly the chokepoint denial worth keeping.
//
// The multiplier was chosen by measurement over the 60 pacifist seeds (ai/pacifist.test.ts):
// against the ungated rule, two seconds laid fewer than half the mines (4.3 vs 9.7 a round)
// and killed the player nearly twice as often with them (9 vs 5), with no rounds lost to AI
// self-destruction. One second was also safe (0%) but laid only 1.4 mines a round for 4
// kills; three seconds is where mines start killing their owners again (6.7% of rounds).
export const AI_MINE_TACTICAL_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS + TANK_SPEED * 2.0; // 8.5

// How many evenly spaced headings the mine escape search tries. A tank can have MINE_CAP
// mines in flee range at once, so the escape has to satisfy several repulsions together
// rather than run from the nearest one; the search maximises the worst-case outward
// component over a fixed wheel of directions. 16 is a 22.5-degree resolution, and being a
// multiple of 4 it puts the exact axis directions on the wheel, so the single-mine case
// still yields precisely "straight away".
export const ESCAPE_SAMPLES = 16;

/**
 * How many ticks ahead a candidate movement direction is checked against wall geometry
 * (issue #224). A single-tick probe establishes only that the very next step is legal --
 * not that the short evasive path is navigable, which is the thing the issue reports as
 * missing.
 *
 * Sampling is one probe per tick along the candidate. At the base speed of 3 units/s that is
 * 0.05 units between probes against a TANK_RADIUS of 0.5, so the swept hull is covered ten
 * times over and no probe can tunnel through a wall between samples.
 *
 * The value is a genuine trade-off and was picked by sweep, not by taste: a longer horizon
 * rejects more candidates, and in tight geometry a long enough horizon rejects every one of
 * them and drives the AI onto its fallback permanently -- which is worse than the defect.
 *
 * Swept over 1-16 against player-profile.test.ts's scripted-bot win rate (then a 125-game
 * population) and wall-pinned ticks from evasion.measure.test.ts: 8 captured 58-83% of the
 * full 1->16 pinning improvement at a win rate identical to horizon 1. Neither metric is
 * monotonic in the horizon, and the win rate did not discriminate between horizons at that
 * N. 10 was avoided because it measured exactly 25/125 = 0.200 and failed that test's
 * `> 0.2` bound.
 */
export const AI_PATH_HORIZON_TICKS = 8;

// ---- AI shot vetting (shotHitsOwnSide, bankShot's return-leg check) ----
// How close a shell may pass to a tank the AI did not aim at before the shot is refused:
// a teammate standing on the firing line (shotHitsOwnSide) or the shooter's own hull
// on a bank shot's returning leg (bankShot). Both matter because resolveBulletHits kills
// any non-owner tank a shell touches -- teammates included -- and makes a shell lethal to
// its owner as soon as it heads back; lineOfSight tests only walls, so it covers neither
// case. TANK_RADIUS + BULLET_RADIUS is the exact grazing distance; the extra 0.15
// covers the gap between the angle a decision reasons about and the angle the barrel
// actually fires along after AI_TURRET_TURN_RATE slew, plus a tick of tank movement.
export const AI_HULL_CLEARANCE = TANK_RADIUS + BULLET_RADIUS + 0.15;
// How many seconds of shell flight (bounces included) shotHitsOwnSide simulates before
// deciding a shot is safe. It is a horizon, not a guarantee: checking the shell's entire
// life would refuse nearly every shot in a boxed arena, since a ricochet eventually
// wanders back through the pack, and an AI that never shoots is its own kind of broken.
// 1.5s covers 9 units at NORMAL_SPEED (6 at RICOCHET_SPEED) -- about half the arena's
// long axis, and comfortably past the first two bounces, which is where the self-kills
// and teammate kills actually clustered.
export const AI_SHOT_LOOKAHEAD = 1.5;

// ---- AI wander (wanderMove) ----
export const WANDER_TICKS = 30; // how many ticks a wander heading is held (~0.5s at 60Hz)

/**
 * How close a fresh movement candidate must sit to the one already committed for the two
 * to count as the same decision -- a dot product between unit headings, so 0.866 is 30
 * degrees. Inside this cone the committed heading is kept even at window expiry, which is
 * what stops an AI oscillating between choices no player could tell apart.
 *
 * Measured before the commitment layer existed (commitment.measure.test.ts, 60 seeds x 2
 * arenas x 2 player policies): 40.6% of all movement reversals under a shooting player
 * were `bullet->bullet` -- dangerAvoidMove's dodge perpendicular swapping sides as the
 * tank crossed the shell's axis, an exact 180-degree flip between two equally good
 * dodges. That single bucket rose to 48.2% on arena 3.
 */
export const AI_COMMIT_HYSTERESIS_DOT = 0.866;
/**
 * How badly a newly-required escape must disagree with the committed heading before it
 * counts as an emergency and interrupts the commitment mid-window (again a dot between
 * unit headings; 0 is 90 degrees).
 *
 * Deliberately not "any escape breaks the hold": that restores the per-tick re-decision
 * this whole mechanism removes, which is issue #222's "allow genuine emergencies to
 * interrupt a held decision without making every shell or wall contact an immediate full
 * reversal". A held heading that still carries the tank broadly out of the corridor rides
 * out its window.
 */
export const AI_COMMIT_EMERGENCY_DOT = 0.0;
/**
 * For a bullet dodge only: the minimum |dot| a committed heading must keep with the
 * escape perpendicular to still count as dodging. Absolute value, because
 * `dangerAvoidMove` returns one of two exact opposite perpendiculars and both leave the
 * danger corridor equally well -- which of the two it names is a tie-break made at dodge
 * onset (the side the tank already sits on), not a fact about safety.
 *
 * Comparing the signed dot against AI_COMMIT_EMERGENCY_DOT instead makes every side-flip
 * read as an emergency, so the hold breaks on exactly the oscillation it exists to stop:
 * measured that way, `bullet->bullet` rose from 40.6% to 68.5% of all reversals under a
 * shooting player, and grey's 95th percentile turn stayed pinned at 180.0 degrees.
 *
 * 0.5 is 60 degrees off the perpendicular axis: a heading still carrying the tank
 * substantially sideways out of the corridor rides out its commitment; one that has
 * fallen to running along the shell's own line has stopped being a dodge and breaks it.
 */
export const AI_COMMIT_DODGE_ALIGN_DOT = 0.5;

// ---- AI distance-band seeking (seekMove) ----
// How strongly an out-of-band tank's heading points along the seek direction
// (toward the player when too far, away when pressed), with the remainder taken
// from the wander heading so approach and retreat stay organic rather than
// robotic beelines. 0 is pure wander; 1 a dead straight line.
//
// Chosen by sweep, not taste, over 60 fixed pacifist seeds per arena against
// pacifist.test.ts's free-win gate (the harness ships as
// engagement.measure.test.ts, skipped in CI, so a future sweep re-measures with
// the same method). 0.50 beats pure wander on both axes (free wins 2 vs 3; every
// mobile kind's engagement spread pulled toward its band); 0.65 breaches the
// gate, because harder approach clusters the AI into its own ordnance.
export const SEEK_APPROACH_BIAS = 0.5;

// ---- AI aim jitter (aimJitter) ----
// A perfect-intercept-solution AI (aimLead) is unmissable; this adds a small, seeded
// error to every AI firing solution so enemies are threatening but survivable.
// This is the primary difficulty knob -- the value most likely to need
// retuning after playtest. Radians; ~4.6 degrees at the current value.
// It is the anchor, not the spread every enemy fires at: the jitter of a
// hypothetical perfect-accuracy profile, from which each profile derives its
// real spread as AI_AIM_SPREAD / ai.aimAccuracy (targeting.ts
// profileAimSpread) -- so grey (0.60) jitters at 0.133 rad, brown (0.55) at
// 0.145. Every shipped profile sits below accuracy 1, so every enemy is wilder
// than the anchor. The reciprocal curve passed the free-win gate over the
// 60-seed harness (engagement.measure.test.ts) with lethality preserved within
// seed noise; a gentler-looking `* (2 - accuracy)` curve failing it was
// free-win chaos (trajectory-sensitive self-destruction events), which is what
// the gate's slack is for.
export const AI_AIM_SPREAD = data.ai.aimSpread;
// How often (in ticks) the jitter offset is re-rolled. ~0.33s at 60Hz. A constant offset
// per tank would just be a fixed miss the AI could never correct for; re-rolling this
// often makes shots scatter around the target instead of consistently missing to one side.
export const AI_JITTER_TICKS = 20;

// ---- AI hazard estimation (targeting.ts profileHazardSpread/estimationError) ----
// Directive B (2026-08-16 owner ruling): AIs must not have oracle knowledge of exact mine
// blast radii or perfect dodge positions -- educated guessing with seeded error, sometimes
// fatal, guess quality scaling by tank type. Same anchor/derate shape as AI_AIM_SPREAD:
// this is the estimation error of a hypothetical perfect-estimationAccuracy profile, world
// units, added to (not multiplying) a true hazard radius -- AI_MINE_FLEE_RADIUS (3.25),
// DANGER_CORRIDOR (0.8) or AI_MINE_TACTICAL_RADIUS (8.5). Chosen so it can cross a real
// decision boundary at DANGER_CORRIDOR's scale (the smallest of the three) without every
// profile's perceived corridor going negative: at the shipped profiles' estimationAccuracy
// (0.3-0.9), spread/accuracy ranges roughly 0.44-1.33, inside DANGER_CORRIDOR for every
// profile above accuracy 0.5 and larger than it only below that. Feel value, like
// AI_AIM_SPREAD -- tune with `npm run gallery -- --sweep` or the pacifist/engagement
// harnesses, not by guessing.
export const AI_HAZARD_SPREAD = data.ai.hazardSpread;

// ---- Grey AI (greyDecision) ----
// How many consecutive dodging ticks Grey will hold fire before shooting back regardless.
// 45 ticks = 0.75s at 60Hz, deliberately longer than the player's FIRE_COOLDOWN (0.4s) so
// sustained player fire still suppresses Grey most of the time, but never forever. This cap
// is mandatory for any cautious personality: without it, the player's 0.4s reload against the
// 1.0s THREAT_HORIZON locks the tank out of firing forever.
//
// Not read by greyDecision: the live value is profile-driven there,
// (1 - ai.aggression) * TICK_HZ, which at the shipped DEFENSIVE_BASIC aggression
// (0.25) is exactly these 45 ticks. This constant is the tests' pinned
// reference; config/roster.test.ts asserts the derivation equals it, so retuning
// the profile without retuning this pin (or vice versa) fails loudly.
export const DODGE_PATIENCE_TICKS = 45;

// ---- Turret slew (slewAngle, types.ts) ----
// Turrets turn at a finite rate instead of snapping to their target angle in a single
// tick. Applied at the two places a desired turret angle is written onto a tank:
// driveTank (world.ts, via slewAngle) and stepAi (ai/index.ts, via accelSlew). Units:
// rad/s; the per-tick turn budget is RATE * DT.
// 8.0 rad/s ~= 458 deg/s at 60Hz -- responsive but not instant for the player; a full
// 180-degree reversal takes ~0.39s (pi / 8.0).
export const PLAYER_TURRET_TURN_RATE = data.turret.playerTurnRate;

/**
 * How fast a hull can swing to face where it is being driven, in radians/second: the
 * MEDIUM rotation speed, which config/balance.ts scales for the other tiers.
 *
 * The hull slews rather than snapping to the input direction, and drives along the hull it
 * actually has rather than the one it wants -- so a turn is an arc. A request for the
 * direction behind the hull backs it up on the reverse gear instead of pivoting (moveTank,
 * collision.ts).
 *
 * Below PLAYER_TURRET_TURN_RATE on purpose. The turret is the precision instrument and
 * must stay quicker than the thing carrying it; a hull that outturned its own gun would
 * make aiming while moving feel like fighting the tank.
 */
export const TANK_TURN_RATE = data.tank.turnRate;
// 2.5 rad/s ~= 143 deg/s at 60Hz -- ~1.26s to swing a full 180 degrees (pi / 2.5).
// This is a primary difficulty knob alongside AI_AIM_SPREAD: unlike aim spread (which
// affects accuracy), this affects how long an enemy visibly telegraphs its aim before
// it can land a shot, giving the player a real window to break line of sight or dodge.
// Lowering it makes enemies more readable/telegraphed.
export const AI_TURRET_TURN_RATE = data.turret.aiTurnRate;

// ---- Last-seen contact memory (issue #372) ----
// How long an AI keeps looking at the last point it actually observed its committed target,
// after direct line of sight breaks.
//
// One constant, not a per-profile field, unlike targetCommitmentTime beside it. #372 asks
// for "a small, deterministic last-seen target memory" and says PP1 needs no advanced
// perception; a per-profile table would be eight invented numbers where the issue asked for
// one. Promote it to the profile when a sweep says the profiles should differ.
//
// 90 ticks is 1.5s, deliberately the same span as targetCommitmentTime: the tank stops
// looking for a contact at about the time it would reconsider who it is fighting, so the two
// give up together rather than leaving a tank staring at an empty corner it is no longer
// committed to. Comfortably longer than AI_SEARCH_HOLD_TICKS (45), so a remembered contact
// outlives a single search heading -- otherwise search would visibly interrupt the memory
// it is supposed to follow.
export const AI_LAST_SEEN_TICKS = 90;

// ---- Sticky opponent selection (issue #359) ----
// The band inside which two candidates count as equivalent, and so are separated by the
// seeded per-AI tie-break rather than by their distances.
//
// This exists because rule 3 is otherwise unreachable. Two opponents are almost never at
// exactly equal range in floating point, so an unquantised comparison would leave the
// tie-break as dead code -- and dead code here is indistinguishable from working code until
// somebody writes a symmetric multi-player fixture. 0.5 units is one tank radius: closer
// than that and no profile can act on the difference.
export const AI_TARGET_TIE_BAND = 0.5;

// How much better a challenger must be, in preferred-range cost, before an AI abandons a
// still-valid opponent at the end of its commitment span (rule 6: "do not switch merely
// because a numerically tiny score difference exists").
//
// Strictly larger than AI_TARGET_TIE_BAND on purpose. If it were smaller, a challenger could
// be too close to rank ahead on acquisition yet far enough ahead to trigger a switch, and the
// AI would flip between two opponents at every span boundary.
export const AI_TARGET_SWITCH_MARGIN = 2;

// ---- Idle turret search (issue #371) ----
// How long an AI holds one search heading, and how far from its hull facing that heading
// may fall. Both are plain literals like AI_JITTER_TICKS, not data-driven scalars: they
// describe a presentation cadence rather than a balance quantity, and nothing reads them
// outside ai/search.ts.
//
// Why this exists, measured over 3 seeds x 3 arenas before it was added: an AI turret was
// perfectly still on 99.50% of the ticks on which it had no firing solution, and those
// ticks were 89.7% of every AI tank-tick in that sample. The gun was dormant, not
// searching, for the large majority of its life.
//
// AI_SEARCH_HOLD_TICKS is the decision span the issue asks for, not the slew time: the
// turret spends part of the span travelling and the rest dwelling, which is what makes the
// motion read as a deliberate look rather than jitter. Shorter than the ~75 ticks a full
// half-turn takes at AI_TURRET_TURN_RATE, so a heading that lands far away is still being
// approached when the next one is chosen -- deliberately, since arriving exactly on every
// search heading is the "perfect coverage" the issue rules out.
export const AI_SEARCH_HOLD_TICKS = 45; // 0.75s at 60Hz

// Bounded to a forward-ish arc rather than the full circle, so a searching tank sweeps the
// ground it faces and never guarantees it will look behind itself. That is a deliberate
// competence limit: full coverage would let a scan find an enemy the perception model says
// the tank has not detected, which is the one thing issue #371 forbids outright.
export const AI_SEARCH_SWEEP = 1.2; // radians, ~69 degrees either side of the hull facing

// ---- AI turret angular acceleration (issue #347) ----
// Ticks the AI turret takes to reach AI_TURRET_TURN_RATE from a standstill. The per-tick
// acceleration budget is AI_TURRET_TURN_RATE * DT / this, and accelSlew (ai/turret-accel.ts)
// also uses it to decelerate onto a target rather than stopping dead.
//
// Why this exists: slewAngle is bang-bang -- min(|error|, maxDelta) with no velocity state --
// so without a ramp the turret can only be stopped or travelling at the full rate cap, with
// nothing in between: the gun switching between stopped and flat out, which is what reads
// as unpolished.
//
// The player turret is deliberately excluded. world.ts's driveTank still calls slewAngle, and
// must: easing live player input reads as input lag, not polish. Same ruling as issue #330's
// deadband, and world.test.ts has the companion proof.
// 6 ticks (0.1s), chosen from a sweep of {1, 3, 6, 10, 15} over 60 seeds x 2 arenas. The
// metric is the fraction of ticks on which the per-tick step size changes by more than half
// the cap -- an abrupt change of speed, which is what the eye reads as a twitch. Dwell (%
// still ticks) is deliberately not the metric: it measures stillness, which trades against
// smoothness, and optimising it is what produced a turret whose median move was the full cap.
//
// 6 is the knee (about 85% of the total available reduction); 10 and 15 buy a little more
// smoothness at the cost of a turret that takes a quarter of a second to reach speed.
// Lethality does not discriminate. The one gate failure in the sweep was pacifist.test.ts at
// ramp 3 (4 of 60 rounds won by a non-firing player against a bound of 3), most likely seed
// noise rather than a real cliff at 3.
export const AI_TURRET_RAMP_TICKS = data.turret.aiRampTicks;
// ---- AI aim hold (issue #344) ----
// How far the freshly recomputed aim solution may drift from the one a tank is holding
// before the hold breaks and the tank re-solves immediately (radians). Below this the
// tank keeps pointing where it decided to point; above it, a genuinely new target has
// appeared and waiting out the rest of the span would be a visible failure to react.
//
// Read with aimHoldTime (the per-profile span, config/types.ts): the span decides how
// long a tank dwells, this decides what interrupts the dwell.
//
// 0.14 radians (8 degrees) is the midpoint of the swept range {0.07, 0.14, 0.28}, chosen
// rather than measured because the sweep (60 seeds x 2 arenas x 2 player policies) did not
// discriminate: dwell, losses and medianTicks moved no more than seed noise, and
// reaction.test.ts and pacifist.test.ts passed at every value.
//
// So this constant is under-determined by the evidence, and the honest reading is that
// anything in single-digit degrees behaves the same. It is pinned at the midpoint so that
// neither end of the tested range is a surprise. If a future artefact turns out to hinge on
// it, re-measure rather than treating this figure as load-bearing.
export const AI_AIM_BREAK = data.ai.aimBreak;

// ---- Per-type bullet tuning ----
export const bulletConfig: Record<BulletType, { speed: number; bounces: number }> = {
  normal: { speed: NORMAL_SPEED, bounces: NORMAL_BOUNCES },
  fast: { speed: FAST_SPEED, bounces: FAST_BOUNCES },
  ricochet: { speed: RICOCHET_SPEED, bounces: RICOCHET_BOUNCES },
};
