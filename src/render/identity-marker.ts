import * as THREE from 'three';
import {
  type IdentityMarkerStyle,
  MARKER_VARIANTS,
} from '../presentation/identity-marker';

/**
 * The identity marker's GEOMETRY -- the half that needs Three.js. The vocabulary
 * (`IDENTITY_MARKER_STYLES`, `identityMarkerSpin`) lives in
 * `presentation/identity-marker.ts`; see that file for what these markers are for and why
 * one of them is held world-fixed.
 */

/** Vertex angles of a regular n-gon, first vertex pointing along -Z (up-screen). */
function polygonAngles(sides: number, rotation: number): number[] {
  return Array.from({ length: sides }, (_, i) => rotation + (i * 2 * Math.PI) / sides);
}

/**
 * An annulus band through the given angles, as one indexed BufferGeometry.
 *
 * `runs` is a list of contiguous angle sequences. One run of 48 samples is a full ring;
 * three runs of a few samples each are three arcs with gaps between them. Each run
 * contributes its own quad strip, and all of them share one buffer -- which is what keeps
 * the whole marker a single mesh whatever the style asks for.
 */
function bandGeometry(runs: readonly (readonly number[])[], inner: number, outer: number): THREE.BufferGeometry {
  const position: number[] = [];
  const index: number[] = [];
  for (const run of runs) {
    const base = position.length / 3;
    for (const a of run) {
      position.push(Math.cos(a) * outer, Math.sin(a) * outer, 0);
      position.push(Math.cos(a) * inner, Math.sin(a) * inner, 0);
    }
    for (let i = 0; i < run.length - 1; i++) {
      const o0 = base + i * 2, i0 = o0 + 1, o1 = o0 + 2, i1 = o0 + 3;
      index.push(o0, i0, o1, i0, i1, o1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The marker geometry for one slot, or `null` for "no marker" -- the caller then builds
 * today's `RingGeometry` unchanged. Returning null rather than a circle keeps the default
 * path byte-identical instead of merely equivalent, which is what lets the shipped
 * rendering be compared against a candidate without the comparison moving too.
 */
export function identityMarkerGeometry(
  style: IdentityMarkerStyle | null,
  slot: number,
  inner: number,
  outer: number,
  segments: number,
): THREE.BufferGeometry | null {
  if (style === null) return null;
  const variant = ((slot % MARKER_VARIANTS) + MARKER_VARIANTS) % MARKER_VARIANTS;

  if (style === 'arcs') {
    // `variant + 1` arcs, evenly spaced, with a gap that is a fixed FRACTION of each arc
    // rather than a fixed angle: at four arcs a fixed gap eats most of the ring, and at
    // one it is invisible. A single arc still carries a gap -- a closed ring and a
    // nearly-closed one read differently, and "slot 1 is the unbroken one" would be a
    // rule the player has to be told rather than one they can see.
    const count = variant + 1;
    const step = (Math.PI * 2) / count;
    const gap = step * 0.28;
    const perArc = Math.max(2, Math.round(segments / count));
    const runs = Array.from({ length: count }, (_, k) => {
      const from = k * step + gap / 2 - Math.PI / 2;
      const to = (k + 1) * step - gap / 2 - Math.PI / 2;
      return Array.from({ length: perArc + 1 }, (_, i) => from + ((to - from) * i) / perArc);
    });
    return bandGeometry(runs, inner, outer);
  }

  // `shape`: circle, triangle, square, diamond. The square and the diamond are the SAME
  // polygon 45 degrees apart, which is only a legitimate pair because the marker is held
  // world-fixed (`identityMarkerSpin`). Were it to spin with the hull they would be one
  // marker wearing two names, and the fourth slot would be indistinguishable from the
  // third for most of every match.
  const spec: ReadonlyArray<{ sides: number; rotation: number }> = [
    { sides: segments, rotation: -Math.PI / 2 },
    { sides: 3, rotation: -Math.PI / 2 },
    { sides: 4, rotation: -Math.PI / 4 },
    { sides: 4, rotation: 0 },
  ];
  const { sides, rotation } = spec[variant];
  const angles = polygonAngles(sides, rotation);
  // Closed: the first vertex repeated, so the last edge is drawn like every other one.
  return bandGeometry([[...angles, angles[0]]], inner, outer);
}
