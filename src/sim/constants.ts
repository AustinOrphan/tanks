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

// ---- Cooldowns (seconds) ----
export const FIRE_COOLDOWN = 0.4;
export const MINE_COOLDOWN = 0.5;

// ---- Mines ----
export const MINE_TIMER = 3.0;
export const MINE_PROXIMITY_RADIUS = 1.5;
export const MINE_BLAST_RADIUS = 2.0;

// ---- Meta ----
export const LIVES = 3;

// ---- Per-type bullet tuning ----
export const bulletConfig: Record<BulletType, { speed: number; bounces: number }> = {
  normal: { speed: NORMAL_SPEED, bounces: NORMAL_BOUNCES },
  fast: { speed: FAST_SPEED, bounces: FAST_BOUNCES },
  ricochet: { speed: RICOCHET_SPEED, bounces: RICOCHET_BOUNCES },
};
