import { describe, it, expect } from 'vitest';
import {
  bulletConfig, DT, TICK_HZ, SHELL_CAP, MINE_CAP,
  NORMAL_BOUNCES, FAST_BOUNCES, RICOCHET_BOUNCES, LIVES,
  PLAYER_TURRET_TURN_RATE, AI_TURRET_TURN_RATE,
} from './constants';
import type { BulletType } from './types';

describe('constants', () => {
  it('DT is the reciprocal of the tick rate', () => {
    expect(TICK_HZ).toBe(60);
    expect(DT).toBeCloseTo(1 / 60, 12);
  });

  it('carries the spec default caps and lives (caps apply to every tank, player and AI)', () => {
    expect(SHELL_CAP).toBe(5);
    expect(MINE_CAP).toBe(2);
    expect(LIVES).toBe(3);
  });

  it('bulletConfig covers every BulletType exhaustively', () => {
    const types: BulletType[] = ['normal', 'fast', 'ricochet'];
    for (const t of types) {
      expect(bulletConfig[t]).toBeDefined();
      expect(typeof bulletConfig[t].speed).toBe('number');
      expect(typeof bulletConfig[t].bounces).toBe('number');
    }
    expect(Object.keys(bulletConfig).sort()).toEqual([...types].sort());
  });

  it('bounce counts match the spec: fast=0, normal=1, ricochet=3', () => {
    expect(bulletConfig.fast.bounces).toBe(FAST_BOUNCES);
    expect(bulletConfig.normal.bounces).toBe(NORMAL_BOUNCES);
    expect(bulletConfig.ricochet.bounces).toBe(RICOCHET_BOUNCES);
    expect(FAST_BOUNCES).toBe(0);
    expect(NORMAL_BOUNCES).toBe(1);
    expect(RICOCHET_BOUNCES).toBe(3);
  });

  it('turret turn rates: player is faster (more responsive) than AI (more telegraphed)', () => {
    expect(PLAYER_TURRET_TURN_RATE).toBe(8.0);
    expect(AI_TURRET_TURN_RATE).toBe(2.5);
    expect(PLAYER_TURRET_TURN_RATE).toBeGreaterThan(AI_TURRET_TURN_RATE);
  });
});
