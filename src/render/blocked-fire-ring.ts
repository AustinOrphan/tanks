import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import type { BlockedFireCue } from '../game/devflags';
import { TANK_RADIUS } from '../sim/constants';

/**
 * Issue #356's tank-local visual candidate: a ring that closes onto the hull when the
 * active-shell cap refuses a shot.
 *
 * WHY TANK-LOCAL AT ALL. The issue lists this separately from the weapon-local treatment
 * for a stated reason -- a cue attached to the barrel is invisible when the turret is
 * pointing away from where you are looking, and a capacity problem is a property of the
 * TANK rather than of the direction it happens to face.
 *
 * IT CLOSES INWARD, which is the opposite of `death-pulse.ts`'s ring and deliberate. An
 * expanding ring reads as a discharge -- something leaving the tank -- and a refused shot
 * is precisely the absence of that. This snaps in slightly wide and contracts to the hull,
 * which reads as a mechanism closing. It is also over three times faster than a death
 * pulse, because a refusal is a small event that must not compete with one.
 *
 * EVENT-DRIVEN, never a `prev`/`curr` world diff, for exactly the reason death-pulse.ts
 * documents at length: `render` runs per FRAME and not per TICK, so a stateless diff both
 * re-fires on a 0-tick frame and misses an intermediate tick's event on a >=2-tick one.
 * `events` is the driver's frameEvents, which carries every tick's events regardless.
 *
 * SILENT BY DEFAULT. Like the audio and haptic arms, this draws nothing unless the flag
 * names it: #356 requires its treatments to be compared before one is adopted, so no arm
 * may become the shipped cue by being wired first.
 */
export interface BlockedFireRingSystem {
  /** Spawn a ring for every refusal this frame that belongs to a player tank. */
  spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void;
  update(dt: number): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

/** Feel constants (numbers that are feel, not measurement); cheap to retune by eye. */
const LIFETIME_SECONDS = 0.18;
/** How far outside the hull the ring starts before closing onto it. */
const OVERSHOOT = 0.9;
const COLOR = 0xffb020;
/** Enough for every player on the board to be refused in one frame, with headroom. */
const MAX_RINGS = 8;
/** Just off the felt, the RING_Y precedent minedebug.ts sets for the same z-fight reason. */
const RING_Y = 0.032;

interface Ring {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

function makeRing(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const inner = TANK_RADIUS * 0.92;
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(inner, TANK_RADIUS * 1.1, 40),
    new THREE.MeshBasicMaterial({
      color: COLOR,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'blocked-fire-ring';
  return mesh;
}

export function createBlockedFireRingSystem(scene: THREE.Scene): BlockedFireRingSystem {
  let reducedMotion = false;
  const pool: Ring[] = [];
  const active: Ring[] = [];

  function acquire(): Ring | null {
    let r = pool.pop();
    if (!r) {
      if (active.length >= MAX_RINGS) return null;
      const mesh = makeRing();
      scene.add(mesh);
      r = { mesh, life: LIFETIME_SECONDS };
    }
    r.mesh.visible = true;
    r.mesh.material.opacity = 1;
    r.life = LIFETIME_SECONDS;
    active.push(r);
    return r;
  }

  function spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void {
    if (cue !== 'ring' && cue !== 'ring+audio') return;
    for (const e of events) {
      if (e.type !== 'fire-blocked') continue;
      // Only a player tank. `fire-blocked` is emitted for whoever was refused, AI tanks
      // included, and ringing an enemy would be telling the player about the enemy's
      // ammunition rather than about their own.
      const owner = world.tanks.find((t) => t.id === e.ownerId);
      if (!owner || !owner.alive || owner.kind !== 'player') continue;
      const r = acquire();
      if (!r) continue;
      r.mesh.position.set(owner.pos.x, RING_Y, owner.pos.y);
      // Reduced motion gets the ring at rest rather than a contraction: the cue still
      // appears and still fades, but nothing travels. Same policy shape death-pulse.ts
      // applies to its own growth term.
      r.mesh.scale.setScalar(reducedMotion ? 1 : 1 + OVERSHOOT);
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const r = active[i];
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        active.splice(i, 1);
        pool.push(r);
        continue;
      }
      // k runs 0 -> 1 across the life. Scale closes from the overshoot onto the hull and
      // opacity falls with it, so the ring arrives and vanishes rather than lingering.
      const k = 1 - r.life / LIFETIME_SECONDS;
      if (!reducedMotion) r.mesh.scale.setScalar(1 + OVERSHOOT * (1 - k));
      r.mesh.material.opacity = 1 - k;
    }
  }

  function dispose(): void {
    for (const r of [...active, ...pool]) {
      scene.remove(r.mesh);
      r.mesh.geometry.dispose();
      r.mesh.material.dispose();
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
