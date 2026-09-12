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
export function makeSpawnRing(color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(RING_BASE_R - RING_WIDTH, RING_BASE_R, RING_SEGMENTS),
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

const warp: SpawnAnimator = (phase, progress, _color, reducedMotion = false) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      // The fade stays: it is what says a tank is arriving rather than standing there.
      tankOpacity: p,
      tankScale: reducedMotion ? 1 : 0.6 + 0.4 * p,
      ring: { radius: reducedMotion ? 1 : 0.4 + 1.6 * p, opacity: 1 - p, arc: 1 },
    };
  }
  // invincible: translucent, solidifying as the shield runs out (p: 0 fresh -> 1 ending).
  return {
    tankOpacity: 0.45 + 0.55 * p,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.35 * (1 - p), arc: 1 },
  };
};

const rise: SpawnAnimator = (phase, progress, _color, reducedMotion = false) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.4),
      tankScale: reducedMotion ? 1 : p, // grows from 0
      ring: {
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

const beacon: SpawnAnimator = (phase, progress, _color, reducedMotion = false) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.6), // materializes to opaque quickly
      tankScale: 1,
      ring: { radius: reducedMotion ? 1 : 0.5 + 1.2 * p, opacity: 1 - p, arc: 1 },
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
