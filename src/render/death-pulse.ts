import * as THREE from 'three';
import type { World } from '../sim/world';
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
   * Diffs `prev`/`curr`: any tank alive in `prev` and dead-or-absent in `curr` spawns a
   * ring at its PREV position (the last place it was actually seen alive), coloured by
   * `resolveOwnerColor` -- unless it is a non-player tank and `opts.enemyEnabled` is
   * false, in which case it is skipped. Player deaths always ring, regardless of the
   * flag.
   */
  spawn(prev: World, curr: World, opts: { enemyEnabled: boolean }): void;
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

  function spawn(prev: World, curr: World, opts: { enemyEnabled: boolean }): void {
    const currAlive = new Set(curr.tanks.filter((t) => t.alive).map((t) => t.id));
    for (const p of prev.tanks) {
      if (!p.alive) continue;
      if (currAlive.has(p.id)) continue; // still alive in curr: not a death
      const isPlayer = p.kind === 'player';
      if (!isPlayer && !opts.enemyEnabled) continue;
      const color = resolveOwnerColor(curr, p);
      const r = acquire(color);
      if (!r) return; // pool exhausted; drop the effect, never the tick
      // PREV position -- the tank's last-seen alive place, not wherever curr (if it
      // even still has an entry) put it.
      r.mesh.position.x = p.pos.x;
      r.mesh.position.z = p.pos.y;
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
