import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { cueDrives, type BlockedFireCue } from '../presentation/blocked-fire';
import { SHELL_MUZZLE_FORWARD } from '../sim/constants';
import { BULLET_Y } from './tank-model';

/**
 * Issue #356's WEAPON-LOCAL smoke candidate: the gun cycled, and what came out of it was
 * a puff of smoke instead of a shell.
 *
 * WHY A SECOND ARM AT THE MUZZLE. Since issue #526 the barrel recoils on EVERY shot, so a
 * refusal already reads as that same kick arriving with nothing behind it. This arm does
 * not replace that sentence, it finishes it: the mechanism cycled, and the only thing the
 * barrel produced was smoke. The comparison the owner is actually running here is recoil
 * alone against recoil plus smoke, which is why the puff is deliberately small and
 * deliberately late-reading -- it annotates a motion the player has already seen rather
 * than competing with it.
 *
 * NOT THE MUZZLE FLASH, and every visible property is chosen to keep the two apart.
 * blocked-fire-muzzle.ts fires the shot's own light: saturated yellow-white, ADDITIVE, one
 * sphere, collapsing, gone in 0.07s. Smoke is its opposite in each of those -- a
 * desaturated grey, NORMALLY blended so it obscures rather than glows, several soft
 * billows rather than one hard body, EXPANDING rather than collapsing, and alive long
 * enough to drift. A player asked to rank the two arms must be ranking two pictures, not
 * two settings of one.
 *
 * A TEXTURE, not a shape. The owner asked for "a smoke type texture", and the reason it
 * has to be one is that smoke has no silhouette: an untextured sphere or disc reads as a
 * grey ball however softly it is shaded, because its boundary is exact. `makeSmokeTexture`
 * below paints a soft radial falloff whose edge is pushed in and out by a few angular
 * lobes, so each billow ends in an irregular fade instead of a circle. Generated as raw
 * pixels rather than drawn on a canvas, the same choice textures.ts and mine-warning.ts
 * make and for the same reason -- the jsdom test environment has no 2D context.
 *
 * SPRITES, so the billows face the camera from any angle. The gallery reviews this arm
 * from `--view close`, `low` and `top`, and a flat quad laid in the world would vanish
 * edge-on from one of them.
 *
 * NO RNG. Real smoke is random and this is not: the puff layout is a fixed table, because
 * the gallery renders the same timeline twice and needs the two renders byte-identical
 * (particles.ts's `rng` seam exists for exactly that reason). What the table buys instead
 * of randomness is that the three billows differ from each other -- different offsets,
 * sizes, spins and drift rates -- so the cloud shears as it rises rather than reading as
 * one stamp printed three times.
 *
 * SILENT BY DEFAULT and PLAYER-ONLY, the contract every arm shares: no arm may become the
 * shipped cue by being wired first, and `fire-blocked` is emitted for every refused owner
 * including AI, whose ammunition is not the player's business.
 */
export interface BlockedFireSmokeSystem {
  /** Puff for every refusal this frame that belongs to a player tank. */
  spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void;
  update(dt: number): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

/**
 * Feel constants. OWNER DECISIONS, stated rather than buried:
 *
 *  - 0.75s, an order of magnitude longer than the muzzle flash's 0.07s, because smoke
 *    that is gone in a blink is a flash wearing a grey coat. It is still the shortest
 *    thing on screen that could be called lingering: an explosion's particles live 0.6s
 *    AND throw 24 bright bodies outward, so a small grey cloud at the barrel cannot be
 *    mistaken for one however long it hangs.
 *  - Grey 0x9aa1a8, desaturated on purpose. Every other arena arm is a saturated warm
 *    colour (the ring's amber, the flash's yellow-white, the pips' hot orange), so a
 *    cool neutral is the one thing on the board that is not signalling.
 *  - Peak opacity 0.72 rather than 1: smoke you can see the barrel through. Exported so
 *    the test can say "thinner than it was born" against the constant itself rather than
 *    against a remembered decimal, the reason blocked-fire-pips.ts exports its colours.
 *  - The cloud rises slightly further than it drifts forward (0.30 against 0.28). Chosen
 *    on a rendered clip: with the drift dominant the billows read as a jet leaving the
 *    bore, which is what a shot looks like -- and the whole claim of this arm is that no
 *    shot happened.
 */
const LIFETIME_SECONDS = 0.75;
const COLOR = 0x9aa1a8;
export const PEAK_OPACITY = 0.72;
/** Sprite size at birth, in world units, before the billow expands toward GROWN_SIZE. */
const BIRTH_SIZE = 0.34;
/**
 * Size at the end of the life. Roughly a hull's width across at full spread -- large
 * enough to read as a cloud, nowhere near the 2.5-unit reach of a mine blast.
 */
const GROWN_SIZE = 0.95;
/** How far the cloud drifts along the barrel over its life, in world units. */
const DRIFT_FORWARD = 0.28;
/** How far it rises over its life. Less than the drift: it is exhaust, not a signal fire. */
const RISE = 0.3;
/** Radians a billow turns over its whole life, times its own spin rate. Slow on purpose. */
const SPIN = 0.5;
/** Enough for every player on the board to be refused in one frame, with headroom. */
const MAX_CLOUDS = 8;

/**
 * The billows, as a fixed table -- see the header for why this is not random.
 *
 * `along`/`across` place each billow relative to the muzzle in barrel-local units, `lift`
 * raises it, `size` and `drift` scale its own growth and travel against the constants
 * above, and `spin` gives each one a different starting angle so the same texture stamped
 * three times is not recognisable as the same texture.
 */
const BILLOWS: readonly {
  along: number;
  across: number;
  lift: number;
  size: number;
  drift: number;
  spin: number;
}[] = [
  { along: 0.0, across: 0.0, lift: 0.0, size: 1.0, drift: 1.0, spin: 0.0 },
  { along: 0.13, across: 0.07, lift: 0.04, size: 0.78, drift: 1.25, spin: 2.2 },
  { along: 0.08, across: -0.09, lift: -0.02, size: 0.64, drift: 0.8, spin: 4.1 },
];

/** Texture resolution. 64 is the size mine-warning.ts's glow falloff settled on. */
const TEX_SIZE = 64;

/**
 * The billow stamp: white, with all the shape in the alpha channel so the material's
 * `color` is free to tint it.
 *
 * The radial falloff is squared, the same choice mine-warning.ts's glow makes so the disc
 * has no visible edge where alpha is falling fastest. What is different here is that the
 * radius itself wobbles with the angle: three broad lobes and five finer ones push the
 * boundary in and out by about a fifth, which is what turns a circle into something with
 * the lumpy, unrepeating outline smoke has. The interior is mottled slightly by the same
 * angle, fading out toward the middle, so the billow is not a uniform wash.
 */
function makeSmokeTexture(): THREE.DataTexture {
  const n = TEX_SIZE;
  const px = new Uint8ClampedArray(n * n * 4);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const dx = x - c;
      const dy = y - c;
      const ang = Math.atan2(dy, dx);
      const lobes = 1 + 0.2 * Math.sin(ang * 3 + 0.9) + 0.11 * Math.sin(ang * 5 - 2.1);
      const d = Math.hypot(dx, dy) / c / lobes;
      const fade = d >= 1 ? 0 : (1 - d) * (1 - d);
      const mottle = 1 - 0.18 * (1 - d) * (0.5 + 0.5 * Math.sin(ang * 7 + 1.3));
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = Math.round(255 * fade * mottle);
    }
  }
  const t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

interface Cloud {
  billows: THREE.Sprite[];
  /** The muzzle the cloud left, in three's coordinates. */
  origin: THREE.Vector3;
  /** Barrel direction and its perpendicular, both unit, in three's xz plane. */
  forward: THREE.Vector3;
  right: THREE.Vector3;
  life: number;
}

export function createBlockedFireSmokeSystem(scene: THREE.Scene): BlockedFireSmokeSystem {
  let reducedMotion = false;
  // One texture for every billow of every cloud, disposed once: `Material.dispose()` does
  // not release a bound map, which is the leak disposeMineGlowMesh exists to avoid.
  const texture = makeSmokeTexture();
  const pool: Cloud[] = [];
  const active: Cloud[] = [];

  function makeCloud(): Cloud {
    const billows = BILLOWS.map((b) => {
      const sprite = new THREE.Sprite(
        // NORMAL blending, unlike every other additive effect in this renderer. Additive
        // smoke would brighten the felt behind it, which is the one thing smoke never
        // does -- and it is precisely what makes the muzzle flash read as light.
        new THREE.SpriteMaterial({
          map: texture,
          color: COLOR,
          transparent: true,
          opacity: PEAK_OPACITY,
          depthWrite: false,
        }),
      );
      sprite.material.rotation = b.spin;
      sprite.name = 'blocked-fire-smoke';
      scene.add(sprite);
      return sprite;
    });
    return {
      billows,
      origin: new THREE.Vector3(),
      forward: new THREE.Vector3(1, 0, 0),
      right: new THREE.Vector3(0, 0, 1),
      life: LIFETIME_SECONDS,
    };
  }

  function acquire(): Cloud | null {
    let cl = pool.pop();
    if (!cl) {
      if (active.length >= MAX_CLOUDS) return null;
      cl = makeCloud();
    }
    // Only what `place` does not write: a reused cloud takes its size, position and spin
    // from the placement `spawn` makes immediately below, but nothing else would clear
    // the opacity it faded out at.
    for (const sprite of cl.billows) {
      sprite.visible = true;
      sprite.material.opacity = PEAK_OPACITY;
    }
    cl.life = LIFETIME_SECONDS;
    active.push(cl);
    return cl;
  }

  /** Place every billow of `cl` at `k` (0 -> 1) through its life. */
  function place(cl: Cloud, k: number): void {
    for (let i = 0; i < cl.billows.length; i++) {
      const b = BILLOWS[i];
      const sprite = cl.billows[i];
      // Written on EVERY frame under the CURRENT policy rather than skipped when reduced
      // motion is on -- the landmine blocked-fire-ring.ts records: skipping the term
      // freezes a live billow wherever it had drifted to when the preference flipped.
      // Reduced motion removes the travel, not the cue: the cloud still appears, at the
      // size it would have spread to, and still thins away.
      const travel = reducedMotion ? 0 : k;
      // Growth eased so most of the spread happens early, the way a puff bursts out of a
      // barrel and then slows. Held at full spread under reduced motion, because a puff
      // stuck at its birth size would be a grey dot rather than smoke.
      const grow = reducedMotion ? 1 : Math.pow(k, 0.6);
      const size = (BIRTH_SIZE + (GROWN_SIZE - BIRTH_SIZE) * grow) * b.size;
      sprite.scale.set(size, size, 1);
      const along = b.along + DRIFT_FORWARD * b.drift * travel;
      sprite.position.set(
        cl.origin.x + cl.forward.x * along + cl.right.x * b.across,
        cl.origin.y + b.lift + RISE * travel,
        cl.origin.z + cl.forward.z * along + cl.right.z * b.across,
      );
      sprite.material.rotation = b.spin + SPIN * b.drift * travel;
    }
  }

  function spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void {
    // The channel first, then the arm -- see blocked-fire-muzzle.ts's own gate for why
    // both halves, and what shipped broken when one of them was missing.
    if (!cueDrives(cue, 'visual') || cue !== 'smoke') return;
    for (const e of events) {
      if (e.type !== 'fire-blocked') continue;
      const owner = world.tanks.find((t) => t.id === e.ownerId);
      if (!owner || !owner.alive || owner.kind !== 'player') continue;
      const cl = acquire();
      if (!cl) continue;
      // The muzzle plane, the same point bullets.ts hands the real fire event as `flash`:
      // world (x, y) -> three (x, z), and the barrel points along `turretAngle`.
      const cos = Math.cos(owner.turretAngle);
      const sin = Math.sin(owner.turretAngle);
      cl.origin.set(
        owner.pos.x + cos * SHELL_MUZZLE_FORWARD,
        BULLET_Y,
        owner.pos.y + sin * SHELL_MUZZLE_FORWARD,
      );
      cl.forward.set(cos, 0, sin);
      // The barrel's perpendicular in the ground plane, so `across` spreads the billows
      // sideways across the bore rather than along it whatever way the turret points.
      cl.right.set(-sin, 0, cos);
      place(cl, 0);
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const cl = active[i];
      cl.life -= dt;
      if (cl.life <= 0) {
        for (const sprite of cl.billows) sprite.visible = false;
        active.splice(i, 1);
        pool.push(cl);
        continue;
      }
      // k runs 0 -> 1 across the life. The cloud expands while it thins, which is the
      // whole shape of the arm: the flash it sits beside does the exact opposite.
      const k = 1 - cl.life / LIFETIME_SECONDS;
      place(cl, k);
      // Thinning is faster than linear, so the cloud is at its most legible in the first
      // moments -- when the player is still looking at the barrel that just kicked.
      const fade = (1 - k) * (1 - k);
      for (const sprite of cl.billows) sprite.material.opacity = PEAK_OPACITY * fade;
    }
  }

  function dispose(): void {
    for (const cl of [...active, ...pool]) {
      for (const sprite of cl.billows) {
        scene.remove(sprite);
        sprite.material.dispose();
      }
    }
    texture.dispose();
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
