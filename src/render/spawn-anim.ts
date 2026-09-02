import * as THREE from 'three';
import type { SpawnAnimId } from '../presentation/customization';

export type SpawnPhase = 'entrance' | 'invincible';

export interface SpawnFrame {
  tankOpacity: number;
  tankScale: number;
  ring: { radius: number; opacity: number; arc: number };
}

export type SpawnAnimator = (phase: SpawnPhase, progress: number, color: number) => SpawnFrame;

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

const warp: SpawnAnimator = (phase, progress) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: p,
      tankScale: 0.6 + 0.4 * p,
      ring: { radius: 0.4 + 1.6 * p, opacity: 1 - p, arc: 1 },
    };
  }
  // invincible: translucent, solidifying as the shield runs out (p: 0 fresh -> 1 ending).
  return {
    tankOpacity: 0.45 + 0.55 * p,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.35 * (1 - p), arc: 1 },
  };
};

const rise: SpawnAnimator = (phase, progress) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.4),
      tankScale: p, // grows from 0
      ring: { radius: 0.9 + 0.3 * Math.sin(p * Math.PI), opacity: 0.6 * (1 - p), arc: 1 },
    };
  }
  // pulse faster as the shield ends: frequency rises with p.
  const pulse = 0.5 + 0.5 * Math.sin(p * Math.PI * (4 + 6 * p));
  return {
    tankOpacity: 0.45 + 0.55 * p,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.3 * pulse, arc: 1 },
  };
};

const beacon: SpawnAnimator = (phase, progress) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.6), // materializes to opaque quickly
      tankScale: 1,
      ring: { radius: 0.5 + 1.2 * p, opacity: 1 - p, arc: 1 },
    };
  }
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
