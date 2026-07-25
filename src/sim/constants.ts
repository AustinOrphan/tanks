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

// ---- Mines ----
export const MINE_TIMER = 3.0;
export const MINE_PROXIMITY_RADIUS = 1.5;
export const MINE_BLAST_RADIUS = 2.0;

// ---- Meta ----
export const LIVES = 3;

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

// ---- AI wander (wanderMove) ----
export const WANDER_TICKS = 30; // how many ticks a wander heading is held (~0.5s at 60Hz)

// ---- Teal AI (tealDecision) ----
// How many consecutive dodging ticks Teal will hold fire before shooting back regardless.
// 45 ticks = 0.75s at 60Hz, deliberately longer than the player's FIRE_COOLDOWN (0.4s) so
// sustained player fire still suppresses Teal most of the time, but never forever.
export const DODGE_PATIENCE_TICKS = 45;
// Alternation period (in ticks) between bank-preferred and direct-preferred targeting, so
// Teal visibly performs both shot types instead of banking only when cover happens to block
// the direct line. 120 ticks = 2s at 60Hz. A preference only: the non-preferred option is
// still tried as a fallback, so Teal never loses a shot it could have taken.
export const BANK_PREFER_TICKS = 120;

// ---- Per-type bullet tuning ----
export const bulletConfig: Record<BulletType, { speed: number; bounces: number }> = {
  normal: { speed: NORMAL_SPEED, bounces: NORMAL_BOUNCES },
  fast: { speed: FAST_SPEED, bounces: FAST_BOUNCES },
  ricochet: { speed: RICOCHET_SPEED, bounces: RICOCHET_BOUNCES },
};
