import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { hullGeometry } from './tank-model';
import { resolveOwnerColor } from '../presentation/identity';

/**
 * A detached, pooled, self-expiring wreck silhouette at a tank's death position and heading
 * (issue #232).
 *
 * DECORATION, NOT AN OBSTACLE. Nothing here reaches the simulation: the system is constructed
 * by the renderer, fed the frame's events and the world it already has, and aged by its own
 * clock. It cannot alter collision, AI or a deterministic trace, and that is true by
 * construction rather than by test.
 *
 * DETACHED FOR THE REASON `death-pulse.ts` RECORDS. `entities.ts`'s `syncTanks` disposes a
 * dead tank's whole `TankView.group` on the SAME sync that first sees `!t.alive`, so a wreck
 * parented to that group would be destroyed before it drew a frame. This is scene-attached
 * and pooled, exactly as the death pulse is.
 *
 * EVENT-DRIVEN, NEVER A `prev`/`curr` DIFF, for the reason that file also records: `render` is
 * called every FRAME, not once per sim TICK. A 0-tick frame hands a stateless diff the same
 * pair as the frame before and re-fires the same death; a multi-tick catch-up frame exposes
 * only the LAST tick's world and hides intermediate deaths entirely. Reading the frame's own
 * `tank-destroyed` events is what makes "once per visible destruction, no duplicates at high
 * refresh rates or after catch-up frames" true.
 *
 * THE ANGLE IS A SNAPSHOT, NEVER A REFERENCE. A destroyed tank stays in `world.tanks` with
 * `alive: false`, and `bodyAngle` on that same object is overwritten when the slot respawns
 * (`world.ts`). Holding the tank and reading its angle per frame would make every wreck
 * silently swing to its owner's new spawn heading. `Tank.aiLastSeenPos` carries the same
 * warning for the same reason.
 */

/**
 * How a wreck leaves. A FEEL choice, and deliberately an arm rather than a decision: issue
 * #232 lists "fade, crumble, sink, or otherwise" without picking, and "clearly inert and
 * distinguishable from a living or respawning tank" is a look rather than a threshold.
 *
 * `crumble` -- breaking into several settling pieces -- is NOT here. It is the only one of the
 * issue's suggestions that changes the pool's shape, because one death becomes several
 * objects and the cap stops meaning what it says. Building a one-piece imitation of it and
 * calling it `crumble` would put a fake option in front of the ruling.
 */
export const WRECK_EFFECTS = ['sink', 'fade', 'tilt'] as const;
export type WreckEffect = (typeof WRECK_EFFECTS)[number];

export function isWreckEffect(value: unknown): value is WreckEffect {
  return typeof value === 'string' && (WRECK_EFFECTS as readonly string[]).includes(value);
}

export interface WreckSystem {
  /** One wreck per `tank-destroyed` event in this frame, at the event's own death position. */
  spawn(events: SimEvent[], world: World): void;
  /** Ages every wreck by `dt` and recycles the expired. */
  update(dt: number): void;
  /**
   * Reduced motion (issue #289's rule, as `death-pulse.ts` applies it): keep the cue, drop the
   * movement. `sink` and `tilt` are movement, so under reduced motion both hold still and end
   * on the opacity fade `fade` uses -- the wreck still appears, still in the owner's colour,
   * and still leaves on the same clock.
   */
  setReducedMotion(on: boolean): void;
  /**
   * Retires every wreck at once, because the board they died on no longer exists.
   *
   * Issue #232 asks for cleanup "on round reset, arena change". The renderer is told about
   * both by the game layer's `worldReplaced()` announcement (issue #531), and a wreck that
   * survives it is drawn at the OLD board's coordinates on the new one -- the same defect
   * that announcement was added for, where an inferred discontinuity turned two tread decals
   * into 158. Six seconds of lifetime is long enough for a cleared level to straddle it.
   */
  clear(): void;
  dispose(): void;
}

interface Wreck {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

/**
 * Bounds simultaneous wrecks. Eight is a full four-player versus board twice over, so the cap
 * exists for a coop wipe rather than for the common case -- the same posture `MAX_RINGS = 16`
 * takes in `death-pulse.ts`. When it is reached the OLDEST wreck is recycled, which is the
 * deterministic replacement policy the issue asks for: never a dropped death, never unbounded
 * growth.
 */
const MAX_WRECKS = 8;

/** Feel constants. Long enough to read as history, short enough not to litter a long match. */
const LIFETIME_SECONDS = 6;
/** World units the `sink` arm settles through over a full life. */
const SINK_DEPTH = 0.35;
/** Radians the `tilt` arm rolls through over a full life -- a hull coming to rest on its side. */
const TILT_RADIANS = Math.PI / 2.6;
/** Just off the felt, matching the RING_Y precedent `ai-contact.ts` sets for the same reason. */
const WRECK_Y = 0.02;
/**
 * How far the identity colour is dragged toward black.
 *
 * The wreck is drawn UNLIT (`MeshBasicMaterial`) while every live tank is lit and shaded, so
 * it reads as a flat silhouette rather than a tank at a distance. That is most of what makes
 * it "clearly inert"; the darkening is the rest, and it keeps the owner's identity legible --
 * the issue asks for the wreck to carry identity, not to discard it.
 */
const DARKEN = 0.45;

function darken(hex: number, k: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(1 - k);
  return c.getHex();
}

export function createWreckSystem(scene: THREE.Scene, effect: WreckEffect = 'sink'): WreckSystem {
  let reducedMotion = false;
  const pool: Wreck[] = [];
  const active: Wreck[] = [];

  function acquire(color: number): Wreck {
    let w = pool.pop();
    if (!w) {
      if (active.length >= MAX_WRECKS) {
        // Oldest first: `active` is append-ordered, so index 0 is the longest-lived.
        const oldest = active[0];
        recycle(oldest, 0);
        w = pool.pop();
      }
    }
    if (!w) {
      const mesh = new THREE.Mesh(
        hullGeometry(),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false }),
      ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      mesh.name = 'wreck';
      scene.add(mesh);
      w = { mesh, life: LIFETIME_SECONDS };
    } else {
      w.mesh.material.color.setHex(color);
    }
    w.mesh.visible = true;
    w.mesh.material.opacity = 1;
    w.mesh.rotation.set(0, 0, 0);
    w.mesh.position.y = WRECK_Y;
    w.life = LIFETIME_SECONDS;
    active.push(w);
    return w;
  }

  function recycle(w: Wreck, i: number): void {
    w.mesh.visible = false;
    active.splice(i, 1);
    pool.push(w);
  }

  function spawn(events: SimEvent[], world: World): void {
    for (const event of events) {
      if (event.type !== 'tank-destroyed') continue;
      const tank = world.tanks.find((t) => t.id === event.tankId);
      if (!tank) continue; // unreachable: tanks are never removed. Never throw in a render path.
      const w = acquire(darken(resolveOwnerColor(world, tank), DARKEN));
      // The event's OWN position -- where the sim recorded the death -- and the heading the
      // tank is wearing on this frame, COPIED rather than referenced. See the file header.
      w.mesh.position.x = event.pos.x;
      w.mesh.position.z = event.pos.y;
      w.mesh.rotation.y = -tank.bodyAngle;
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const w = active[i];
      w.life -= dt;
      if (w.life <= 0) {
        recycle(w, i);
        continue;
      }
      const k = 1 - w.life / LIFETIME_SECONDS; // 0 fresh -> 1 about to expire
      // Every arm ends invisible; they differ in what happens on the way. Under reduced
      // motion the moving arms hold still and keep only the fade they all share.
      const still = reducedMotion;
      if (effect === 'sink' && !still) {
        w.mesh.position.y = WRECK_Y - SINK_DEPTH * k;
        w.mesh.material.opacity = 1 - k * k;
      } else if (effect === 'tilt' && !still) {
        w.mesh.rotation.z = TILT_RADIANS * k;
        w.mesh.material.opacity = 1 - k * k;
      } else {
        w.mesh.material.opacity = 1 - k;
      }
    }
  }

  function clear(): void {
    for (let i = active.length - 1; i >= 0; i--) recycle(active[i], i);
  }

  function dispose(): void {
    for (const w of [...active, ...pool]) {
      w.mesh.material.dispose();
      w.mesh.geometry.dispose();
      scene.remove(w.mesh);
    }
    active.length = 0;
    pool.length = 0;
  }

  return {
    spawn,
    update,
    setReducedMotion: (on: boolean) => { reducedMotion = on; },
    clear,
    dispose,
  };
}
