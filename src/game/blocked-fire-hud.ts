import type { SimEvent } from '../sim/events';
import type { World } from '../sim/world';
import { ownerShellCount } from '../sim/bullets';
import { configFor } from '../sim/config';
import { cueDrives, type BlockedFireCue } from '../presentation/blocked-fire';

/**
 * Issue #356's MINIMAL HUD candidate, and issue #516's `hud` arm: one transient capacity
 * line, off the arena, when the active-shell cap refuses the controlling player's shot.
 *
 * WHY IT IS ITS OWN MODULE rather than four lines in loop.ts. Every other blocked-fire
 * consumer keeps its own gate -- `audio/director.ts` for the sample, `game/haptics.ts` for
 * the buzz, `render/blocked-fire-ring.ts` for the ring -- and each keeps a one-row-per-cue
 * table beside it, so a cue that no consumer acts on fails a test instead of shipping as a
 * silent flag. Putting this arm's gate in the loop would have put its table in
 * loop.test.ts, among a thousand assertions about something else, and left the HUD arm the
 * one arm with no dedicated home. loop.ts stays wiring: it builds this and hands it the
 * frame's events.
 *
 * WHY THE HUD ITSELF KNOWS NOTHING ABOUT CUES. `hud.ts` owns a surface, not a policy: it
 * is handed `signalShellCapacity` and paints it. That separation is what keeps the
 * transient line usable if #356 later adopts it under different conditions -- the gate
 * moves, the surface does not.
 *
 * THE NUMBERS ARE THE SIMULATION'S OWN. `configFor(kind).weapon.maxActiveProjectiles` and
 * `ownerShellCount` are the two halves of `shellCapReached` (sim/bullets.ts), the gate
 * that refused the shot in the first place. #356 requires the displayed capacity to derive
 * from the same resolved tank configuration `spawnBullet` enforces; reading it from
 * anywhere else would let the explanation disagree with the rule.
 *
 * SILENT BY DEFAULT and gated to the CONTROLLING player, the contract every arm shares:
 * `fire-blocked` is emitted for whoever was refused, AI tanks included, and an enemy's
 * ammunition is not the player's business.
 */
export interface BlockedFireHudCue {
  /** Flash for this frame's refusals, if any belong to the tracked player. */
  handle(events: SimEvent[], world: World): void;
  /** The tracked player's tank id changes with every arena; loop.ts pushes it. */
  setPlayerId(id: number | undefined): void;
}

/**
 * The slice of the HUD this arm drives. A `Pick` rather than the whole `Hud`, so a test
 * can hand it one function instead of standing up a DOM surface with fifty setters.
 */
export interface ShellCapacitySurface {
  signalShellCapacity(info: { inFlight: number; cap: number }): void;
}

export interface BlockedFireHudOptions {
  /**
   * `?dev=1&blockedFire=hud` (devflags.ts). Null -- the shipped default -- stays silent,
   * because issue #356 requires its treatments to be compared before one is adopted.
   */
  readonly blockedFire?: BlockedFireCue | null;
}

export function createBlockedFireHudCue(
  hud: ShellCapacitySurface,
  initialPlayerId: number | undefined,
  options: BlockedFireHudOptions = {},
): BlockedFireHudCue {
  let playerId = initialPlayerId;

  return {
    handle(events: SimEvent[], world: World): void {
      // The channel first, then the arm: `cueDrives` is the vocabulary's own answer to
      // "does this cue claim a screen at all" (presentation/blocked-fire.ts), and the
      // identity check is which of the five visual arms it is. The same two-part gate
      // every visual arm uses.
      if (!cueDrives(options.blockedFire, 'visual') || options.blockedFire !== 'hud') return;
      if (playerId === undefined) return;
      for (const e of events) {
        // Discriminated by ownerId, not presence: the stream is shared, so a bare
        // `some(e => e.type === 'fire-blocked')` would flash on every AI tank running out
        // of shells -- exactly the anti-pattern CLAUDE.md names.
        if (e.type !== 'fire-blocked' || e.ownerId !== playerId) continue;
        const owner = world.tanks.find((t) => t.id === playerId);
        if (!owner) continue;
        hud.signalShellCapacity({
          inFlight: ownerShellCount(world, owner.id),
          cap: configFor(owner.kind).weapon.maxActiveProjectiles,
        });
        // One flash per frame however many refusals arrive in it. A held trigger cannot
        // outrun the fire cooldown (#451 charges a refused attempt the same cooldown a
        // real shot pays), but two player tanks cannot both be THIS player, and a
        // duplicated event would otherwise restart the animation twice in one frame for
        // no visible gain.
        return;
      }
    },
    setPlayerId(id: number | undefined): void {
      playerId = id;
    },
  };
}
