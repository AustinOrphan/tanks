import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { makeSpawnRing } from './spawn-anim';
import { resolveOwnerColor } from '../presentation/identity';

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
  /**
   * The resolved reduced-motion policy (issue #289), pushed in rather than read here.
   *
   * A LIVE setter, not a spawn option, because the policy can change with the page open
   * (`'system'` follows the OS) and the growth it governs happens in `update`, not at
   * spawn -- a ring already in flight has to stop expanding mid-life, not on the next
   * death. `game/capabilities.ts` is the one place anything asks the OS; this reads the
   * value `effective-settings.ts` resolved from it.
   */
  setReducedMotion(on: boolean): void;
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

/**
 * DETONATE (issue #230, the `opposed` arm): the same shockwave with an attack envelope.
 *
 * The shipped ring grows LINEARLY and fades linearly, which is a swell rather than a blast
 * -- and the spawn entrances swell too, which is the whole of why the issue says the two
 * are "hard to tell apart at normal speed".
 *
 * Three changes, all envelope, none of them new geometry:
 *  - growth is ease-OUT (`1 - (1-k)^3`), so most of the travel happens in the first third.
 *    A blast is fast then slow; a swell is even.
 *  - opacity HOLDS at full for the first `ATTACK` of the life, then falls. That hold is
 *    the "hard attack" -- a frame of solid ring before anything fades, which is what the
 *    eye reads as an impact rather than an arrival.
 *  - the band is `DETONATE_WIDTH` times fatter (spawn-anim.ts), so weight separates the
 *    two events as well as direction. Direction alone is legible in a still and much less
 *    so at speed.
 */
const ATTACK = 0.18;

export function createDeathPulseSystem(
  scene: THREE.Scene,
  /** Issue #230's `opposed` arm -- see ATTACK above. Construction-time because it decides
   *  the ring's GEOMETRY (a fat band), which a per-frame flag could not change without
   *  rebuilding a pooled mesh every death. */
  opposed = false,
): DeathPulseSystem {
  let reducedMotion = false;
  const pool: DeathRing[] = [];
  const active: DeathRing[] = [];

  function acquire(color: number): DeathRing | null {
    let r = pool.pop();
    if (!r) {
      if (active.length >= MAX_RINGS) return null;
      const mesh = makeSpawnRing(color, opposed) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
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
      // THE OPACITY ALTERNATIVE issue #289 asks for, and it is the one this effect already
      // had: the ring is a shockwave that GROWS and FADES, so reduced motion keeps the fade
      // and drops the growth. The death stays perceptible -- a ring still appears in the
      // tank's identity colour and still fades on the same clock -- while the expanding
      // motion, which carries no information the fade does not, is gone. Nothing else about
      // the effect's lifetime changes, so a reduced ring and a full one recycle on the same
      // frame.
      if (opposed) {
        // Ease-out travel, and an opacity that holds before it falls. Under reduced motion
        // the travel is dropped exactly as the shipped arm drops it -- the hold stays,
        // because it is timing rather than movement, and it is what distinguishes the
        // event. Calming a cue must not silently delete the thing being compared.
        const eased = 1 - (1 - k) ** 3;
        r.mesh.scale.setScalar(reducedMotion ? 1 : 1 + GROWTH * eased);
        r.mesh.material.opacity = k < ATTACK ? 1 : 1 - (k - ATTACK) / (1 - ATTACK);
      } else {
        r.mesh.scale.setScalar(reducedMotion ? 1 : 1 + GROWTH * k);
        r.mesh.material.opacity = 1 - k;
      }
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

  return {
    spawn,
    update,
    setReducedMotion: (on: boolean) => { reducedMotion = on; },
    dispose,
  };
}
