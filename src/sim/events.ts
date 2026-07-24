import type { Vec2, BulletType, TankKind } from './types';

// Canonical 10-kind event union emitted by step(). Render and audio both consume
// this stream; the sim core never imports render or audio.
export type SimEvent =
  | { type: 'fire'; ownerId: number; bulletType: BulletType; pos: Vec2; angle: number }
  | { type: 'ricochet'; pos: Vec2; bounceIndex: number }
  | { type: 'explosion'; pos: Vec2 }
  | { type: 'mine-dropped'; mineId: number; pos: Vec2 }
  | { type: 'mine-armed'; mineId: number; pos: Vec2 }
  | { type: 'mine-detonate'; mineId: number; pos: Vec2 }
  | { type: 'tank-destroyed'; tankId: number; kind: TankKind; pos: Vec2 }
  | { type: 'wall-destroyed'; wallId: number; pos: Vec2 }
  | { type: 'win' }
  | { type: 'lose' };
