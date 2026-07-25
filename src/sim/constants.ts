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

// ---- Player resource caps ----
export const PLAYER_SHELL_CAP = 5;
export const PLAYER_MINE_CAP = 2;

// ---- AI resource caps ----
// Enemies are capped lower than the player's PLAYER_MINE_CAP (2). dropMine (mines.ts)
// only enforces PLAYER_MINE_CAP for owner.kind === 'player' — it does NOT cap non-player
// owners at all — so AI decision functions (e.g. greyDecision) must self-enforce this cap
// by checking tank.activeMineIds.length before requesting a mine drop.
export const AI_MINE_CAP = 1;

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

// ---- Per-type bullet tuning ----
export const bulletConfig: Record<BulletType, { speed: number; bounces: number }> = {
  normal: { speed: NORMAL_SPEED, bounces: NORMAL_BOUNCES },
  fast: { speed: FAST_SPEED, bounces: FAST_BOUNCES },
  ricochet: { speed: RICOCHET_SPEED, bounces: RICOCHET_BOUNCES },
};
