import type { Vec2, BulletType, TankKind } from './types';

/**
 * Who caused a destruction, for the stats layer. `source` says how (a shell impact or
 * a mine's blast), `ownerId` says whose; without them, kills, self-kills and friendly fire
 * are unattributable downstream.
 */
export interface DestroyedBy {
  source: 'shell' | 'blast';
  ownerId: number;
}

// Canonical event union emitted by step(). Render, audio, and the game layer's HUD,
// haptics and stats consume this stream; the sim core imports none of them.
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
   * A fire input that was refused, and why (issue #356).
   *
   * Without it, a shot `spawnBullet` refuses at the owner's active-shell limit would be
   * indistinguishable from an input that never happened -- to the player, and to every
   * consumer of this stream. That silence reads as dropped input or a broken control: an
   * active-shell budget is a conservation decision only if the player can tell it is being
   * enforced.
   *
   * `reason` is a discriminator rather than a boolean because the cap is not the only way
   * a shot can be refused (`spawnBullet` also returns `false`, emitting nothing, for a dead
   * owner), and #356 is scoped to the cap alone. A treatment keyed on `'shell-cap'` therefore
   * cannot start firing for a different refusal if another reason is added here later.
   *
   * Emitting the event is not the feedback. Which cue a player actually gets -- weapon-local,
   * tank-local, audio, haptic, HUD, or a combination -- is #356's own comparison to make;
   * this is the one input all of those candidates need.
   */
  | { type: 'fire-blocked'; ownerId: number; reason: 'shell-cap' }
  /**
   * Per-tank revival (stepRespawns, world.ts) -- coop's shared-pool respawns and ffa/teams'
   * stock respawns. `controlledBy` carries the slot directly, matching why `tank-destroyed`
   * carries `kind` inline -- consumers do not need a tank lookup. Unreachable at
   * campaign-coop playerCount 1 (stepRespawns' campaign-coop arm is only ever called when
   * countPlayerTanks(world) >= 2, stepInputs' gate) -- but reachable in ffa/teams at any
   * player count, since that arm carries no such guard.
   */
  | { type: 'respawn'; tankId: number; controlledBy: number; pos: Vec2 }
  | { type: 'wall-destroyed'; wallId: number; ownerId: number; pos: Vec2 }
  | { type: 'win' }
  | { type: 'lose' };
