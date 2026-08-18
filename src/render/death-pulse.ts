import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { makeSpawnRing } from './spawn-anim';
import { resolveOwnerColor } from './entities';

/**
 * A detached, pooled, self-expiring world shockwave ring at a tank's death position,
 * in its identity/team colour (issue #200's death-pulse work).
 *
 * Detached and pooled for the same reason particles.ts is: `entities.ts`'s
 * `syncTanks` disposes a dead tank's whole `TankView.group` the SAME tick it detects
 * `!t.alive` (its `!seen.has(id)` teardown loop runs every sync), so a death ring
 * parented to the tank's group would be destroyed before it ever drew a frame. This
 * mirrors `createParticleSystem`'s pool/active shape instead: a scene-attached mesh
 * that outlives the view, driven by its own clock in `update(dt)`.
 */
export interface DeathPulseSystem {
  /**
   * Event-driven, mirroring `particles.spawn(events)` one line above it in
   * `renderer.render` -- deliberately NOT a `prev`/`curr` world diff (what this used to
   * be). `render` is called every FRAME with the driver's per-frame world snapshots, not
   * once per sim TICK: a 0-tick frame (common above 60Hz refresh) hands `spawn` the same
   * `(prev, curr)` pair as the frame before it, so a stateless diff re-fires the same
   * death every frame until the next tick moves the world; a >=2-tick frame (<=30Hz,
   * post-stall catch-up) only ever exposes the LAST tick's world, so an intermediate
   * tick's death is invisible to any diff of `prev` against `curr`. `events` is the
   * driver's `frameEvents` -- every tick-stamped event this frame actually produced --
   * so each `tank-destroyed` fires its ring exactly once, on the frame it happened,
   * however many ticks that frame advanced.
   *
   * For each `tank-destroyed` event, spawns a ring at `event.pos` (the death position
   * the sim recorded, not a re-derived one), coloured by `resolveOwnerColor` for the
   * tank looked up by `event.tankId` in `world` -- tanks are never removed from
   * `world.tanks` (they flip `alive: false`), so the lookup always finds a dead tank,
   * never a live one. Skipped if the tank is a non-player kind and `opts.enemyEnabled`
   * is false; player deaths always ring, regardless of the flag. If the lookup somehow
   * fails, the event is skipped rather than throwing.
   */
  spawn(events: SimEvent[], world: World, opts: { enemyEnabled: boolean }): void;
  /** Ages every active ring by `dt`, expanding it outward and fading it out; recycles
   * any ring whose own clock has run out. */
  update(dt: number): void;
  dispose(): void;
}

interface DeathRing {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
  maxLife: number;
}

// A small pool: deaths are rare compared to particles.ts's bursts, so this cap exists
// only to bound worst-case simultaneous deaths (e.g. a full coop wipe), not to shape
// the common case.
const MAX_RINGS = 16;
// Feel constants (CLAUDE.md's "numbers that are feel, not measurement"): how long a
// ring lives and how far it expands over that life. Both cheap to retune by eye.
const LIFETIME_SECONDS = 0.6;
const GROWTH = 2.4;

export function createDeathPulseSystem(scene: THREE.Scene): DeathPulseSystem {
  const pool: DeathRing[] = [];
  const active: DeathRing[] = [];

  function acquire(color: number): DeathRing | null {
    let r = pool.pop();
    if (!r) {
      if (active.length >= MAX_RINGS) return null;
      const mesh = makeSpawnRing(color) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      // Renamed so a same-frame respawn's own spawn-ring (entities.ts) stays
      // separable -- see the file doc comment.
      mesh.name = 'death-ring';
      scene.add(mesh);
      r = { mesh, life: LIFETIME_SECONDS, maxLife: LIFETIME_SECONDS };
    } else {
      r.mesh.material.color.setHex(color);
    }
    r.mesh.visible = true;
    r.mesh.material.opacity = 1;
    r.mesh.scale.setScalar(1);
    r.life = LIFETIME_SECONDS;
    r.maxLife = LIFETIME_SECONDS;
    active.push(r);
    return r;
  }

  function recycle(r: DeathRing, i: number): void {
    r.mesh.visible = false;
    active.splice(i, 1);
    pool.push(r);
  }

  function spawn(events: SimEvent[], world: World, opts: { enemyEnabled: boolean }): void {
    for (const event of events) {
      if (event.type !== 'tank-destroyed') continue;
      const isPlayer = event.kind === 'player';
      if (!isPlayer && !opts.enemyEnabled) continue;
      const tank = world.tanks.find((t) => t.id === event.tankId);
      if (!tank) continue; // should be unreachable (tanks are never removed), but never throw
      const color = resolveOwnerColor(world, tank);
      const r = acquire(color);
      if (!r) continue; // pool exhausted; drop this ring, never the tick
      // The event's OWN position -- the place the sim recorded the death, on the tick
      // it actually happened -- not a re-derived "current tank position".
      r.mesh.position.x = event.pos.x;
      r.mesh.position.z = event.pos.y;
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const r = active[i];
      r.life -= dt;
      if (r.life <= 0) {
        recycle(r, i);
        continue;
      }
      const k = 1 - r.life / r.maxLife; // 0 fresh -> 1 about to expire
      r.mesh.scale.setScalar(1 + GROWTH * k);
      r.mesh.material.opacity = 1 - k;
    }
  }

  function dispose(): void {
    for (const r of active) {
      r.mesh.material.dispose();
      r.mesh.geometry.dispose();
      scene.remove(r.mesh);
    }
    for (const r of pool) {
      r.mesh.material.dispose();
      r.mesh.geometry.dispose();
      scene.remove(r.mesh);
    }
    active.length = 0;
    pool.length = 0;
  }

  return { spawn, update, dispose };
}
