import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { cueDrives, type BlockedFireCue } from '../presentation/blocked-fire';
import { SHELL_MUZZLE_FORWARD } from '../sim/constants';
import { BULLET_Y } from './tank-model';

/**
 * Issue #356's WEAPON-LOCAL visual candidate, and issue #516's `muzzle` arm: the shot's
 * own flash, fired at the barrel opening and then cut short.
 *
 * WHY IT IS THE SHOT'S OWN VISUAL. The issue asks for "a restrained muzzle/barrel/turret
 * pulse" attached to the firing tank, and the sharpest question a blocked-fire cue can
 * answer is "did the gun go off?". This one deliberately answers it with the SAME light
 * the gun makes when it does -- the same colour particles.ts bursts on a real `fire`, at
 * the same place (SHELL_MUZZLE_FORWARD, the muzzle plane the sim already emits its fire
 * event's `pos` at) and the same height (BULLET_Y, the barrel centreline). What differs
 * is that it is over almost before it starts and no shell leaves: one short blink where a
 * real discharge is a five-particle burst with travel. Whether that reads as "the gun
 * tried and failed" or merely as "a shot I did not see land" is exactly the comparison
 * #356 exists to run, so the arm is built to be judged, not to be safe.
 *
 * NOT A PARTICLE BURST, even though it borrows the burst's colour and additive material.
 * particles.ts is driven by `fire`, and a refusal emits no `fire` -- routing this through
 * it would have meant either faking the event (a lie the audio director and every other
 * consumer would also hear) or teaching the particle system a second event whose spawn
 * position it cannot compute. One mesh, one lifetime, no velocity: the whole point is
 * that nothing travels.
 *
 * SILENT BY DEFAULT and PLAYER-ONLY, exactly as blocked-fire-ring.ts is: no arm may
 * become the shipped cue by being wired first, and `fire-blocked` is emitted for every
 * refused owner including AI, whose ammunition is not the player's business.
 */
export interface BlockedFireMuzzleSystem {
  /** Flash for every refusal this frame that belongs to a player tank. */
  spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void;
  update(dt: number): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

/**
 * Feel constants. OWNER DECISION, stated rather than buried: 0.07s is a little over a
 * third of the 0.18s a real `fire` burst's particles live for, which is what "the shot's
 * own visual, cut short" means here in numbers.
 */
const LIFETIME_SECONDS = 0.07;
/** particles.ts's own `fire` colour, deliberately not a new one -- see the header. */
const COLOR = 0xffd873;
/** The flash's radius at birth, in world units, before it collapses toward SHRINK_TO. */
const RADIUS = 0.26;
/** Where the collapse ends: a flash that shrank to nothing would read as a spark. */
const SHRINK_TO = 0.45;
/** Enough for every player on the board to be refused in one frame, with headroom. */
const MAX_FLASHES = 8;

interface Flash {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

export function createBlockedFireMuzzleSystem(scene: THREE.Scene): BlockedFireMuzzleSystem {
  let reducedMotion = false;
  // One geometry for every flash, disposed once: the flashes differ only in transform.
  const geometry = new THREE.SphereGeometry(RADIUS, 8, 8);
  const pool: Flash[] = [];
  const active: Flash[] = [];

  function acquire(): Flash | null {
    let f = pool.pop();
    if (!f) {
      if (active.length >= MAX_FLASHES) return null;
      const mesh = new THREE.Mesh(
        geometry,
        // Additive and depth-write-free, the treatment particles.ts documents for glow:
        // a transparent flash that writes depth punches a hole in whatever is behind it,
        // and the barrel is directly behind this one.
        new THREE.MeshBasicMaterial({
          color: COLOR,
          transparent: true,
          opacity: 1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      mesh.name = 'blocked-fire-muzzle';
      scene.add(mesh);
      f = { mesh, life: LIFETIME_SECONDS };
    }
    f.mesh.visible = true;
    f.mesh.material.opacity = 1;
    f.mesh.scale.setScalar(1);
    f.life = LIFETIME_SECONDS;
    active.push(f);
    return f;
  }

  function spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void {
    // The channel first, then the arm. `cueDrives` is the vocabulary's own answer to "is
    // this cue mine at all" (presentation/blocked-fire.ts); the identity check is which
    // visual arm it is, since the visual channel now has five of them and each draws its
    // own treatment. A cue reclassified out of the visual channel goes dark here rather
    // than drawing under a name that no longer claims a screen.
    if (!cueDrives(cue, 'visual') || cue !== 'muzzle') return;
    for (const e of events) {
      if (e.type !== 'fire-blocked') continue;
      const owner = world.tanks.find((t) => t.id === e.ownerId);
      if (!owner || !owner.alive || owner.kind !== 'player') continue;
      const f = acquire();
      if (!f) continue;
      // The muzzle plane, the same point bullets.ts hands the real fire event as `flash`:
      // world (x, y) -> three (x, z), and the barrel points along `turretAngle`.
      f.mesh.position.set(
        owner.pos.x + Math.cos(owner.turretAngle) * SHELL_MUZZLE_FORWARD,
        BULLET_Y,
        owner.pos.y + Math.sin(owner.turretAngle) * SHELL_MUZZLE_FORWARD,
      );
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const f = active[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.mesh.visible = false;
        active.splice(i, 1);
        pool.push(f);
        continue;
      }
      // k runs 0 -> 1 across the life. The flash collapses and fades together, so it
      // reads as light going out rather than as an object shrinking.
      const k = 1 - f.life / LIFETIME_SECONDS;
      // Written on EVERY frame under the CURRENT policy rather than skipped when reduced
      // motion is on -- the landmine blocked-fire-ring.ts records: skipping the term
      // freezes an already-live flash at whatever scale it had reached when the
      // preference flipped. Reduced motion removes the collapse, not the cue: the flash
      // still appears at full size and still fades out.
      f.mesh.scale.setScalar(reducedMotion ? 1 : 1 - (1 - SHRINK_TO) * k);
      f.mesh.material.opacity = 1 - k;
    }
  }

  function dispose(): void {
    for (const f of [...active, ...pool]) {
      scene.remove(f.mesh);
      f.mesh.material.dispose();
    }
    geometry.dispose();
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
