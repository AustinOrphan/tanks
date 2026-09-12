import * as THREE from 'three';
import type { SpawnAnimId } from '../presentation/customization';

export type SpawnPhase = 'entrance' | 'invincible';

export interface SpawnFrame {
  tankOpacity: number;
  tankScale: number;
  ring: { radius: number; opacity: number; arc: number };
}

/**
 * `reducedMotion` is the seam issue #651 records as missing here, and it is a PARAMETER
 * rather than a correction applied to the returned frame, because one case cannot be
 * corrected afterwards: `rise`'s invincible ring OSCILLATES its opacity at a rising
 * frequency, and a `SpawnFrame` carries only the value that oscillation happened to reach.
 * Nothing downstream can tell that 0.3 from a fade's 0.3, so nothing downstream can hold it
 * steady. The animator knows; the frame does not.
 *
 * Defaulted, so every existing call site and every existing test reads unchanged.
 *
 * THE RULE, and it is `death-pulse.ts`'s ("keeps the fade and drops the growth") applied to
 * three animators: scales and radii hold at their resting value, an oscillating opacity
 * holds at the mean it oscillates about, and a monotone fade or a depleting timer arc is
 * left alone -- those carry information the motion does not add.
 */
export type SpawnAnimator = (
  phase: SpawnPhase,
  progress: number,
  color: number,
  reducedMotion?: boolean,
  /** Issue #230's `opposed` arm: the entrance ring converges instead of expanding. A
   *  parameter for the same reason `reducedMotion` is one -- the direction is baked into
   *  each style's own radius curve, and nothing downstream can invert a number it cannot
   *  tell from a resting value. Defaulted, so every existing caller reads unchanged. */
  opposed?: boolean,
) => SpawnFrame;

/** Fixed entrance length, in seconds of render wall-clock. Round start and respawn share it. */
export const ENTRANCE_SECONDS = 0.5;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Ring geometry the animators drive by scaling; base radius is 1 world unit so a frame's
// `ring.radius` is a direct world-space radius.
const RING_BASE_R = 1;
const RING_WIDTH = 0.12;
const RING_Y = 0.06;
const RING_SEGMENTS = 48;

/** A flat additive ring, same family as entities.ts's makeIdentityRing. */
/**
 * How much fatter a DETONATE band is than the shipped shockwave ring (issue #230).
 *
 * The complaint this answers is that spawn and death "are easy to miss and hard to tell
 * apart at normal speed", and they were: every spawn entrance grows its ring outward
 * (warp 0.4->2.0, beacon 0.5->1.7, rise a bump) and so does the death pulse. Two events,
 * one expanding-ring vocabulary.
 *
 * Weight is half of what separates them under the `opposed` arm -- an arrival is a thin
 * line closing in, a destruction is a heavy band thrown out. Direction alone reads at a
 * still frame and much less well at speed, which is where the complaint lives.
 */
const DETONATE_WIDTH = 3.2;

export function makeSpawnRing(color: number, fat = false): THREE.Mesh {
  const width = RING_WIDTH * (fat ? DETONATE_WIDTH : 1);
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(RING_BASE_R - width, RING_BASE_R, RING_SEGMENTS),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.name = 'spawn-ring';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = RING_Y;
  return mesh;
}

/**
 * CONVERGE: the entrance ring collapses inward instead of expanding (issue #230, the
 * `opposed` arm).
 *
 * Every shipped entrance grows its ring outward and so does the death pulse, which is why
 * the two are "hard to tell apart at normal speed". Under this arm an arrival gathers --
 * the ring starts wide and thin and closes onto the tank as it materialises -- and a
 * destruction throws a fat band out. Opposed direction AND opposed weight, because
 * direction alone is legible in a still frame and much less so at speed.
 *
 * Applied to all three styles rather than to one: the player picks a SPAWN STYLE
 * (`spawnAnim`), but arrival-versus-destruction is a property of the EVENT, and a language
 * that only held for one style would leave the other two reading like deaths.
 *
 * Radius runs 2.4 -> 1.0, landing exactly on the tank's own footprint rather than passing
 * through it; opacity rises with progress so the ring is brightest at the moment it lands,
 * which is the frame the entrance ends on.
 */
function convergeRing(p: number, reducedMotion: boolean): { radius: number; opacity: number; arc: number } {
  // Held at the landing radius under reduced motion -- the ring still appears, still fades
  // with the tank's own opacity, and simply does not travel. Same rule as death-pulse's
  // ("keeps the fade and drops the growth") and the one this file's own doc comment states.
  return { radius: reducedMotion ? 1 : 2.4 - 1.4 * p, opacity: p, arc: 1 };
}

const warp: SpawnAnimator = (phase, progress, _color, reducedMotion = false, opposed = false) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      // The fade stays: it is what says a tank is arriving rather than standing there.
      tankOpacity: p,
      tankScale: reducedMotion ? 1 : 0.6 + 0.4 * p,
      ring: opposed ? convergeRing(p, reducedMotion)
        : { radius: reducedMotion ? 1 : 0.4 + 1.6 * p, opacity: 1 - p, arc: 1 },
    };
  }
  // invincible: translucent, solidifying as the shield runs out (p: 0 fresh -> 1 ending).
  return {
    tankOpacity: 0.45 + 0.55 * p,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.35 * (1 - p), arc: 1 },
  };
};

const rise: SpawnAnimator = (phase, progress, _color, reducedMotion = false, opposed = false) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.4),
      tankScale: reducedMotion ? 1 : p, // grows from 0
      ring: opposed ? convergeRing(p, reducedMotion) : {
        radius: reducedMotion ? 1 : 0.9 + 0.3 * Math.sin(p * Math.PI),
        opacity: 0.6 * (1 - p),
        arc: 1,
      },
    };
  }
  // pulse faster as the shield ends: frequency rises with p.
  //
  // THE ONE OSCILLATION in this file, and the reason the flag is a parameter: at p = 1 the
  // ring completes five cycles over the phase. Reduced motion holds it at the value it
  // oscillates ABOUT -- the mean of `0.5 + 0.5 sin(...)` is 0.5 -- so the shield still reads
  // as present and as fading with `tankOpacity`, without the flicker. Not zero: an invisible
  // ring would delete the "you are still protected" cue rather than calm it, which is the
  // trap #652 records for `.hud-capacity` and `.hud-count`.
  const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(p * Math.PI * (4 + 6 * p));
  return {
    tankOpacity: 0.45 + 0.55 * p,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.3 * pulse, arc: 1 },
  };
};

const beacon: SpawnAnimator = (phase, progress, _color, reducedMotion = false, opposed = false) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.6), // materializes to opaque quickly
      tankScale: 1,
      ring: opposed ? convergeRing(p, reducedMotion)
        : { radius: reducedMotion ? 1 : 0.5 + 1.2 * p, opacity: 1 - p, arc: 1 },
    };
  }
  // The invincible frame below is UNCHANGED under reduced motion, deliberately: its ring
  // neither grows nor pulses, and the depleting `arc` is a TIMER -- how much shield is left
  // -- so calming it would delete information rather than motion.
  // Opaque tank; the ring is the timer — its arc depletes as the shield runs out.
  return {
    tankOpacity: 1,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.9, arc: 1 - p },
  };
};

export const SPAWN_ANIMATORS: Record<SpawnAnimId, SpawnAnimator> = {
  warp,
  rise,
  beacon,
};
