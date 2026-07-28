import type { BulletType } from './types';

// ---- Simulation timing ----
export const TICK_HZ = 60;
export const DT = 1 / 60;

// ---- Tanks ----
export const TANK_RADIUS = 0.5;
export const TANK_SPEED = 3.0;

// ---- Bullets ----
export const BULLET_RADIUS = 0.1;

export const NORMAL_SPEED = 6;
export const FAST_SPEED = 12;
export const RICOCHET_SPEED = 6;

export const NORMAL_BOUNCES = 1;
export const FAST_BOUNCES = 0;
export const RICOCHET_BOUNCES = 3;

// ---- Resource caps ----
// These caps apply to ALL tanks, player and AI alike (dropMine/spawnBullet enforce them
// uniformly regardless of owner.kind). AI decision functions may also self-check these
// caps as defence-in-depth, e.g. to avoid burning a cooldown on a request that would be
// refused anyway, but the caps themselves are enforced at the shared spawn chokepoints.
export const SHELL_CAP = 5;
export const MINE_CAP = 2;

// ---- Cooldowns (seconds) ----
export const FIRE_COOLDOWN = 0.4;
export const MINE_COOLDOWN = 0.5;

/**
 * The same two cooldowns as whole TICKS, which is what the sim actually counts.
 *
 * Storing seconds and subtracting DT once per tick does not land on zero:
 * repeated subtraction accumulates rounding, so after the intended 24
 * decrements FIRE_COOLDOWN sits a hair ABOVE zero and the `<= 0` gate needs one
 * more tick. Measured: 0.4s delivered a 25-tick, 0.41667s cadence and 0.5s a
 * 31-tick, 0.51667s one, and 23 of 40 plausible cooldown values (50ms..2000ms
 * in 50ms steps) expired late the same way. (The one-shot form 0.4 - 24*DT IS
 * exactly zero; only the iterated form drifts, which is why this is easy to
 * miss by inspection.)
 *
 * Integers decremented by 1 cannot drift, so the cadence is now exactly what
 * the seconds above say.
 */
export const FIRE_COOLDOWN_TICKS = Math.round(FIRE_COOLDOWN * TICK_HZ);
export const MINE_COOLDOWN_TICKS = Math.round(MINE_COOLDOWN * TICK_HZ);

// ---- Mines ----
export const MINE_TIMER = 3.0;
export const MINE_PROXIMITY_RADIUS = 1.5;
export const MINE_BLAST_RADIUS = 2.0;

// ---- Meta ----
export const LIVES = 3;

// ---- Round phases (roundPhase, applied uniformly to player + AI) ----
// Two phases run before normal play, timed from `world.roundStartTick` (reset on every
// resetArena, so every respawn gets the same protection as the very start of the game):
//   countdown -- nobody can move or fire; turret aim still updates so the player can
//     orient before combat starts.
//   grace     -- everyone can move; nobody can fire or lay mines, giving both sides
//     maneuvering room before the first shot.
// COUNTDOWN_TICKS = 180 ticks = 3s at 60Hz (TICK_HZ).
export const COUNTDOWN_TICKS = 180;
// GRACE_TICKS = 120 ticks = 2s at 60Hz (TICK_HZ).
export const GRACE_TICKS = 120;

// ---- Collision sweep (reflectSweep) ----
export const SWEEP_EPS = 1e-7;
export const SWEEP_MAX_ITERATIONS = 16;

// ---- AI targeting (aimLead) ----
// Pure non-degeneracy guard for the intercept quadratic, NOT a physical
// tolerance: it is compared against several dimensionally distinct
// quantities (a: speed^2, b: position*speed, t: seconds), so it has no
// single physical unit of its own.
export const AIM_EPS = 1e-9;

// ---- AI danger avoidance (incomingThreats, dangerAvoidMove) ----
export const VEC_EPS = 1e-6; // zero-length-vector degeneracy guard
export const THREAT_HORIZON = 1.0; // seconds of lookahead for incoming bullets
export const DANGER_CORRIDOR = TANK_RADIUS + 0.3; // lateral half-width the bullet may pass within

// ---- AI mine avoidance (dangerAvoidMove) ----
// The radius at which an AI starts running from an ARMED mine. It must be derived from
// the radius detonateMine actually KILLS at (MINE_BLAST_RADIUS + TANK_RADIUS = 2.5),
// never from MINE_PROXIMITY_RADIUS -- proximity is only the *trigger* radius, and
// guarding on it left the AI standing calmly inside a 0.5-unit-thick shell of the lethal
// zone. On top of the lethal radius sits a reaction margin: fleeing at exactly the kill
// distance is fleeing from inside the blast with zero time to leave it, so the margin is
// the distance a tank actually covers at TANK_SPEED in AI_MINE_FLEE_TICKS.
export const AI_MINE_FLEE_TICKS = 15; // 0.25s at 60Hz
export const AI_MINE_FLEE_MARGIN = TANK_SPEED * AI_MINE_FLEE_TICKS * DT; // 0.75 units
export const AI_MINE_FLEE_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS + AI_MINE_FLEE_MARGIN; // 3.25
// How near the player has to be for laying a mine to be worth doing at all.
//
// Grey and Teal used to drop a mine the instant the cooldown allowed it, with no reference
// to where anyone was, so a roamer alone in a corner littered the floor with live ordnance
// it then had to dodge. Mines are area denial: one goes down to threaten ground the player
// is actually contesting, not to mark where a tank happened to be standing.
//
// Derived, not picked: the blast kills out to MINE_BLAST_RADIUS + TANK_RADIUS, and a player
// within two seconds' travel of that edge can still be caught by, or forced to respect, a
// 3-second fuse. Being a radius around the DROP POINT it also permits a deliberate burst --
// while the player stays close a tank may still lay up to MINE_CAP mines back to back, which
// is exactly the chokepoint denial worth keeping.
//
// The multiplier was chosen by measurement, not taste. Over the same 60 pacifist seeds
// (see ai/pacifist.test.ts), sweeping it against the ungated behaviour it replaces:
//   ungated   9.7 mines/round, 5 player kills, 31.7% of rounds lost to AI self-destruction
//   1 second  1.4 mines/round, 4 player kills, 0%
//   2 seconds 4.3 mines/round, 9 player kills, 0%   <- here
//   3 seconds 8.2 mines/round, 8 player kills, 6.7%
// Two seconds lays fewer than half the mines the old rule did and kills the player nearly
// twice as often with them: what got deleted was ordnance that never threatened anyone but
// the tank that laid it. Three seconds is where mines start killing their owners again.
export const AI_MINE_TACTICAL_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS + TANK_SPEED * 2.0; // 8.5

// How many evenly spaced headings the mine escape search tries. A tank can have MINE_CAP
// mines in flee range at once, so the escape has to satisfy several repulsions together
// rather than run from the nearest one; the search maximises the worst-case outward
// component over a fixed wheel of directions. 16 is a 22.5-degree resolution, and being a
// multiple of 4 it puts the exact axis directions on the wheel, so the single-mine case
// still yields precisely "straight away".
export const ESCAPE_SAMPLES = 16;

// ---- AI shot vetting (friendlyBlocksShot, bankShot's return-leg check) ----
// How close a shell may pass to a tank the AI did NOT aim at before the shot is refused:
// a teammate standing on the firing line (friendlyBlocksShot) or the shooter's own hull
// on a bank shot's returning leg (bankShot). Both matter because resolveBulletHits kills
// ANY non-owner tank a shell touches -- teammates included -- and makes a shell lethal to
// its OWNER as soon as it heads back; lineOfSight only ever tested walls, so neither case
// was covered. TANK_RADIUS + BULLET_RADIUS is the exact grazing distance; the extra 0.15
// covers the gap between the angle a decision reasons about and the angle the barrel
// actually fires along after AI_TURRET_TURN_RATE slew, plus a tick of tank movement.
export const AI_HULL_CLEARANCE = TANK_RADIUS + BULLET_RADIUS + 0.15;
// How many seconds of shell flight (bounces included) shotHitsOwnSide simulates before
// deciding a shot is safe. It is a horizon, not a guarantee: checking the shell's ENTIRE
// life would refuse nearly every shot in a boxed arena, since a ricochet eventually
// wanders back through the pack, and an AI that never shoots is its own kind of broken.
// 1.5s covers roughly 9 units at NORMAL_SPEED/RICOCHET_SPEED -- about half the arena's
// long axis, and comfortably past the first two bounces, which is where the self-kills
// and teammate kills actually clustered.
export const AI_SHOT_LOOKAHEAD = 1.5;

// ---- AI wander (wanderMove) ----
export const WANDER_TICKS = 30; // how many ticks a wander heading is held (~0.5s at 60Hz)

// ---- AI aim jitter (aimJitter) ----
// A perfect-intercept-solution AI (aimLead) is unmissable; this adds a small, seeded
// error to every AI firing solution so enemies are threatening but survivable.
// THIS IS THE PRIMARY DIFFICULTY KNOB for this slice -- the value most likely to need
// retuning after playtest. Radians; ~4.6 degrees at the current value.
export const AI_AIM_SPREAD = 0.08;
// How often (in ticks) the jitter offset is re-rolled. ~0.33s at 60Hz. A constant offset
// per tank would just be a fixed miss the AI could never correct for; re-rolling this
// often makes shots scatter around the target instead of consistently missing to one side.
export const AI_JITTER_TICKS = 20;

// ---- Grey AI (greyDecision) ----
// How many consecutive dodging ticks Grey will hold fire before shooting back regardless.
// 45 ticks = 0.75s at 60Hz, deliberately longer than the player's FIRE_COOLDOWN (0.4s) so
// sustained player fire still suppresses Grey most of the time, but never forever. This cap
// is mandatory for any cautious personality: without it, the player's 0.4s reload against the
// 1.0s THREAT_HORIZON locks the tank out of firing forever.
export const DODGE_PATIENCE_TICKS = 45;

// ---- Teal AI (tealDecision) ----
// Alternation period (in ticks) between bank-preferred and direct-preferred targeting, so
// Teal visibly performs both shot types instead of banking only when cover happens to block
// the direct line. 120 ticks = 2s at 60Hz. A preference only: the non-preferred option is
// still tried as a fallback, so Teal never loses a shot it could have taken.
export const BANK_PREFER_TICKS = 120;

// ---- Turret slew (slewAngle, types.ts) ----
// Turrets turn at a finite rate instead of snapping to their target angle in a single
// tick. Applied at the two places a desired turret angle is written onto a tank:
// applyPlayerInput (world.ts) and stepAi (ai/index.ts). Units: rad/s; the per-tick
// turn budget is RATE * DT.
// 8.0 rad/s ~= 458 deg/s at 60Hz -- responsive but not instant for the player; a full
// 180-degree reversal takes ~0.39s (pi / 8.0).
export const PLAYER_TURRET_TURN_RATE = 8.0;
// 2.5 rad/s ~= 143 deg/s at 60Hz -- ~1.26s to swing a full 180 degrees (pi / 2.5).
// THIS IS A PRIMARY DIFFICULTY KNOB alongside AI_AIM_SPREAD: unlike aim spread (which
// affects accuracy), this affects how long an enemy visibly telegraphs its aim before
// it can land a shot, giving the player a real window to break line of sight or dodge.
// Lowering it makes enemies more readable/telegraphed.
export const AI_TURRET_TURN_RATE = 2.5;

// ---- Per-type bullet tuning ----
export const bulletConfig: Record<BulletType, { speed: number; bounces: number }> = {
  normal: { speed: NORMAL_SPEED, bounces: NORMAL_BOUNCES },
  fast: { speed: FAST_SPEED, bounces: FAST_BOUNCES },
  ricochet: { speed: RICOCHET_SPEED, bounces: RICOCHET_BOUNCES },
};
