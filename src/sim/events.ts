import type { Vec2, BulletType, TankKind } from './types';

// Canonical 11-kind event union emitted by step(). Render and audio both consume
// this stream; the sim core never imports render or audio.
/**
 * Who caused a destruction, for the stats layer. `source` says HOW (a shell impact or
 * a mine's blast), `ownerId` says WHOSE -- both were already known at every emit site;
 * the stream just never carried them, which made kills, self-kills and friendly fire
 * unattributable downstream.
 */
export interface DestroyedBy {
  source: 'shell' | 'blast';
  ownerId: number;
}

export type SimEvent =
  | { type: 'fire'; ownerId: number; bulletType: BulletType; pos: Vec2; angle: number }
  | { type: 'ricochet'; ownerId: number; pos: Vec2; bounceIndex: number }
  | { type: 'explosion'; pos: Vec2 }
  | { type: 'mine-dropped'; mineId: number; ownerId: number; pos: Vec2 }
  | { type: 'mine-armed'; mineId: number; ownerId: number; pos: Vec2 }
  | { type: 'mine-detonate'; mineId: number; ownerId: number; pos: Vec2 }
  | { type: 'tank-destroyed'; tankId: number; kind: TankKind; by: DestroyedBy; pos: Vec2 }
  /**
   * Coop's per-tank revival (stepRespawns, world.ts). `controlledBy` carries the
   * slot directly, matching why `tank-destroyed` carries `kind` inline -- consumers
   * do not need a tank lookup. Unreachable at playerCount 1: stepRespawns is only
   * ever called when countPlayerTanks(world) >= 2 (stepInputs' gate).
   */
  | { type: 'respawn'; tankId: number; controlledBy: number; pos: Vec2 }
  | { type: 'wall-destroyed'; wallId: number; ownerId: number; pos: Vec2 }
  | { type: 'win' }
  | { type: 'lose' };
