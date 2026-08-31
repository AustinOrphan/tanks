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
  | { type: 'mine-triggered'; mineId: number; ownerId: number; pos: Vec2 }
  | { type: 'mine-fuse-warning'; mineId: number; ownerId: number; pos: Vec2 }
  | { type: 'mine-detonate'; mineId: number; ownerId: number; pos: Vec2 }
  | { type: 'tank-destroyed'; tankId: number; kind: TankKind; by: DestroyedBy; pos: Vec2 }
  /**
   * A fire input that was REFUSED, and why (issue #356).
   *
   * `spawnBullet` returns `false` and emits nothing when the owner is already at its
   * active-shell limit, so a refused shot is indistinguishable from an input that never
   * happened -- to the player, and to every consumer of this stream. That silence reads as
   * dropped input or a broken control, which is the whole defect: an active-shell budget is
   * a conservation decision only if the player can tell it is being enforced.
   *
   * `reason` is a discriminator rather than a boolean because the cap is not the only way
   * a shot can be refused today (a dead owner also returns `false`), and #356 is scoped to
   * the CAP alone. A treatment keyed on `'shell-cap'` therefore cannot start firing for a
   * different refusal if another reason is added here later.
   *
   * Emitting the event is not the feedback. Which cue a player actually gets -- weapon-local,
   * tank-local, audio, haptic, HUD, or a combination -- is #356's own comparison to make;
   * this is the one input all of those candidates need.
   */
  | { type: 'fire-blocked'; ownerId: number; reason: 'shell-cap' }
  /**
   * Per-tank revival (stepRespawns, world.ts) -- coop's shared-pool respawns and,
   * since the versus stock PR, ffa/teams' own stock respawns. `controlledBy` carries
   * the slot directly, matching why `tank-destroyed` carries `kind` inline --
   * consumers do not need a tank lookup. Unreachable at campaign-coop playerCount 1
   * (stepRespawns' campaign-coop arm is only ever called when
   * countPlayerTanks(world) >= 2, stepInputs' gate) -- but reachable in ffa/teams at
   * ANY player count, since that arm carries no such guard.
   */
  | { type: 'respawn'; tankId: number; controlledBy: number; pos: Vec2 }
  | { type: 'wall-destroyed'; wallId: number; ownerId: number; pos: Vec2 }
  | { type: 'win' }
  | { type: 'lose' };
