import type * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';

/**
 * The gun tube kicks back when the gun cycles (issue #526).
 *
 * This began as issue #356's `turret` refusal arm -- one of five candidate ways to say
 * "your shot was refused". It won that comparison, and the owner's ruling turned it into
 * something else: the recoil now plays on EVERY shot, so it is no longer a cue about
 * refusal at all. It is what firing looks like. A refusal is then the same recoil with
 * no shell and no muzzle flash, which is why it reads without having to be learned: the
 * mechanism cycled and nothing came out.
 *
 * That inversion is the whole design. A dedicated refusal effect asks the player to know
 * what it means. This asks them to notice what is MISSING from a motion they have already
 * seen a hundred times, which needs no teaching.
 *
 * THE BARREL, NOT THE TURRET GROUP. The offset goes on the gun tube alone
 * (`EntityViews.barrelOf`), so the dome stays seated on its ring while the tube slides
 * back through it. Moving the group -- the shape this had as a refusal arm -- moved dome
 * and tube together, which reads as the whole turret rocking on the hull rather than a
 * gun in recoil.
 *
 * EVERY TANK, not just the player. As a refusal arm this was player-only, because an
 * enemy's refusal would report the enemy's ammunition state to the player. That reason
 * does not survive the change: firing is already visible -- the shell is right there --
 * so recoiling on it tells the player nothing they cannot already see. An enemy gun that
 * stayed rigid while the player's kicked would be the odd thing.
 *
 * It writes a channel `sync` does not. entities.ts assigns the barrel's `rotation.z` and
 * its `position` exactly once, at construction; this writes `position.x` and always
 * returns it to zero when the recoil ends, so the two never fight and no offset can
 * outlive its motion. The view behind a tank id is NOT stable (a kind change or a repaint
 * rebuilds it), which is why the object is looked up per frame instead of latched at
 * spawn.
 */
export interface BarrelRecoilSystem {
  /**
   * Start a recoil for every shot fired and every shot refused this frame.
   *
   * Both event types, one gesture: `fire` is a shot that left the barrel and
   * `fire-blocked` is one the shell cap refused (see sim/bullets.ts's `shellCapReached`).
   * The gun cycled either way, so it kicks either way, and the difference the player
   * reads is the shell and the flash that accompany one and not the other.
   */
  spawn(events: SimEvent[], world: World): void;
  update(dt: number): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

/**
 * Where the moving barrel comes from. Structural, not `EntityViews` itself: this needs
 * one lookup, and taking the whole interface would make every test here build a full
 * entity-view set to exercise a number.
 */
export interface BarrelSource {
  barrelOf(tankId: number): THREE.Object3D | null;
}

/**
 * Feel constants. OWNER DECISIONS, stated rather than buried:
 *
 *  - 0.16s total, so the whole gesture is over inside a fifth of a second. It now plays
 *    on every shot, which makes brevity load-bearing rather than merely tasteful: a
 *    longer kick would still be running when the next shell leaves.
 *  - KICK 0.13 world units, which the decay term below turns into a FIRST BUMP of about
 *    0.098 and a second of about 0.033 -- roughly a tenth of the hull's length and a
 *    quarter of the turret's own radius (0.36). Measured by eye against a rendered frame:
 *    0.07 was invisible in a still and marginal in motion; this reads as a kick without
 *    the tube sliding out of its ring.
 *  - TWO bumps (`CYCLES = 1` through `abs(sin)`), the second a third the size of the
 *    first, because one push reads as a nudge and a stutter reads as a mechanism.
 *
 * Carried over unchanged from the refusal arm the owner picked, deliberately: these are
 * the numbers that were played and ranked first, and re-tuning them here would discard
 * the evidence that chose them.
 */
const LIFETIME_SECONDS = 0.16;
const KICK = 0.13;
const CYCLES = 1;
/**
 * Reduced motion (issue #289/#453 policy, the shape blocked-fire-ring.ts uses): keep the
 * gesture, remove the travel. There is no version of a recoil with no movement at all, so
 * the animated stutter becomes ONE held offset -- the gun sits back for the motion's life
 * and returns once -- rather than oscillating. Half amplitude, because a static offset is
 * on screen far longer than any single bump of the animated one.
 */
const REST_KICK = KICK / 2;

export function createBarrelRecoilSystem(barrels: BarrelSource): BarrelRecoilSystem {
  let reducedMotion = false;
  /** tank id -> seconds elapsed. One recoil per tank; a fresh shot restarts it. */
  const active = new Map<number, number>();

  /** How far back the gun sits, in world units, at `k` (0 -> 1) through the recoil. */
  function offsetAt(k: number): number {
    if (reducedMotion) return REST_KICK;
    // `abs`, so every bump is RECOIL. A signed sine would push the barrel forward on the
    // second half of each cycle, which reads as the gun lunging at the target.
    return KICK * (1 - k) * Math.abs(Math.sin(k * Math.PI * 2 * CYCLES));
  }

  function rest(tankId: number): void {
    const barrel = barrels.barrelOf(tankId);
    if (barrel) barrel.position.x = 0;
  }

  function spawn(events: SimEvent[], world: World): void {
    for (const e of events) {
      if (e.type !== 'fire' && e.type !== 'fire-blocked') continue;
      // A dead tank's view is being torn down or replaced; kicking it would animate a
      // corpse. Every LIVING owner recoils, player and enemy alike.
      const owner = world.tanks.find((t) => t.id === e.ownerId);
      if (!owner || !owner.alive) continue;
      active.set(owner.id, 0);
    }
  }

  function update(dt: number): void {
    for (const [tankId, elapsed] of [...active]) {
      const next = elapsed + dt;
      if (next >= LIFETIME_SECONDS) {
        // Always land back at zero. Leaving the last frame's offset in place would park
        // the barrel permanently short on a tank that is otherwise fine.
        rest(tankId);
        active.delete(tankId);
        continue;
      }
      active.set(tankId, next);
      const barrel = barrels.barrelOf(tankId);
      // No view: the tank died or was rebuilt mid-recoil. Drop the entry rather than
      // counting down against an object that no longer exists -- a rebuilt barrel starts
      // at zero anyway, so there is nothing left to reset.
      if (!barrel) {
        active.delete(tankId);
        continue;
      }
      // Recomputed from the CURRENT preference every frame, so a reduced-motion toggle
      // mid-recoil snaps the gun to its held offset instead of freezing it wherever the
      // animation had reached -- the landmine blocked-fire-ring.ts records for its ring.
      barrel.position.x = -offsetAt(next / LIFETIME_SECONDS);
    }
  }

  function dispose(): void {
    for (const tankId of active.keys()) rest(tankId);
    active.clear();
  }

  return {
    spawn,
    update,
    setReducedMotion: (on: boolean) => { reducedMotion = on; },
    dispose,
  };
}
