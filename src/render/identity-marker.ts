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

/**
 * The turret-crown blades: `slot + 1` radial spokes in a flat disc, as ONE geometry.
 *
 * A COUNT, so it needs no counter-rotation -- and that is a genuine simplification over
 * both ring arms, which exist only because a square turned 45 degrees is the diamond.
 * Blades may spin with the turret freely; three blades are three blades at every yaw.
 *
 * Sized against `TURRET_R` (0.36) rather than the ring's radii: inner 0.07, outer 0.32,
 * so the mark sits inside the crown with a margin and never overhangs the dome's edge
 * where the silhouette would clip it. Each blade spans 30 degrees.
 */
export function identityRoofGeometry(
  slot: number,
  inner: number,
  outer: number,
): THREE.BufferGeometry {
  const count = (((slot % MARKER_VARIANTS) + MARKER_VARIANTS) % MARKER_VARIANTS) + 1;
  // 44 degrees, not 30. The first build used a thin 30-degree wedge and it read as
  // spindly at the shipped camera -- a hairline scratch on the crown rather than a mark.
  // A blade is also foreshortened to 0.78 of its width across one axis (sin 51), so the
  // drawn span has to start wider than it needs to look.
  //
  // Why a FIXED span rather than a fraction of the spacing: at four blades the gaps are
  // already 46 degrees, so a proportional span would close them up as the count rises,
  // and "how many gaps" is the read. Fixed keeps every gap at least as wide as a blade.
  const half = (44 * Math.PI) / 180 / 2;
  const runs = Array.from({ length: count }, (_, k) => {
    const c = -Math.PI / 2 + (k * 2 * Math.PI) / count;
    // Seven samples per blade: the wider span needs more of them to stay a sector rather
    // than flattening into a quad at the edges. Four blades still sit under 120 vertices.
    return Array.from({ length: 7 }, (_, i) => c - half + (2 * half * i) / 6);
  });
  return bandGeometry(runs, inner, outer);
}

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
 * THE INK WIDTH every `shape` marker is drawn to, in world units, measured PERPENDICULAR to
 * its own outline (issue #660).
 *
 * The shapes used to share one band in world units -- `IDENTITY_RING_INNER_R` to
 * `IDENTITY_RING_OUTER_R`, a 0.15 gap -- and that is not one weight. `bandGeometry` places
 * both edges at the same vertex ANGLES, so a polygon's two edges are chords, and the
 * perpendicular gap between them is the gap between their apothems: `0.15 * cos(PI / n)`.
 *
 *   circle (n=48)   0.1497   100%
 *   square (n=4)    0.1061    71%
 *   triangle (n=3)  0.0750    50%
 *
 * So the four markers were drawn to one number and read at four weights, the triangle at
 * half the circle. Under greyscale and at distance that reads as four levels of emphasis
 * rather than four identities. Dividing by `cos(PI / n)` equalises them.
 *
 * 0.11, not the circle's old 0.15: equalising UP to the heaviest would put the triangle's
 * band at 0.30 -- wider than the gap between the ring and the tank itself -- so the target
 * sits nearer the middle and the circle thins slightly as the triangle thickens.
 */
const MARKER_WEIGHT = 0.11;

/**
 * The outer extent every `shape` marker shares, larger than the solid ring's 0.80 (issue
 * #660: "they probably could stand to be a bit bigger across the board").
 *
 * ONE OUTER RADIUS FOR ALL FOUR, with the weight taken inward, so the shapes read as one
 * family at one size rather than four marks of differing extent. The default solid ring is
 * deliberately NOT moved: it is the control these are compared against, and a control that
 * grows with them measures nothing.
 *
 * Two tanks at their closest legal approach have centres `TANK_RADIUS * 2` = 1.0 apart, so
 * markers already overlap at 0.80 and this does not introduce that -- it is a pre-existing
 * property of drawing an identity ring wider than the tank. What it does change is how much,
 * which is a judgement for a capture rather than for arithmetic.
 */
const SHAPE_OUTER_R = 0.88;

/** The band for an `n`-sided outline that renders at `MARKER_WEIGHT` perpendicular ink. */
function bandForSides(sides: number): { inner: number; outer: number } {
  return { inner: SHAPE_OUTER_R - MARKER_WEIGHT / Math.cos(Math.PI / sides), outer: SHAPE_OUTER_R };
}

/**
 * A band whose OUTER edge follows a per-vertex radius while the inner edge stays circular.
 * `bandGeometry` above holds both radii constant, which cannot describe a star.
 */
function starBand(verts: readonly (readonly [number, number])[], inner: number): THREE.BufferGeometry {
  const position: number[] = [];
  const index: number[] = [];
  for (const [a, r] of verts) {
    position.push(Math.cos(a) * r, Math.sin(a) * r, 0);
    position.push(Math.cos(a) * inner, Math.sin(a) * inner, 0);
  }
  for (let i = 0; i < verts.length - 1; i++) {
    const o0 = i * 2, i0 = o0 + 1, o1 = o0 + 2, i1 = o0 + 3;
    index.push(o0, i0, o1, i0, i1, o1);
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
  // `let`, because the `shape` arm replaces both: each outline needs its own band to render
  // at one perpendicular weight (issue #660), and they share an outer radius of their own
  // rather than the solid ring's. `arcs` uses the radii as given -- it IS the ring.
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

  if (style === 'roof') {
    // Unreachable: the roof style paints the turret crown, not the ring, and
    // `makeIdentityRing` is handed `ringMarkerFor(style)` which is null here. Returning
    // null rather than throwing keeps this function total, and the caller's `?? new
    // RingGeometry(...)` then produces the shipped ring -- which is exactly what the roof
    // arm wants underneath its blades.
    return null;
  }

  // `shape`: circle, triangle, square, diamond. The square and the diamond are the SAME
  // polygon 45 degrees apart, which is only a legitimate pair because the marker is held
  // world-fixed (`identityMarkerSpin`). Were it to spin with the hull they would be one
  // marker wearing two names, and the fourth slot would be indistinguishable from the
  // third for most of every match.
  // Slot 4 is a STARBURST, not the diamond it used to be.
  //
  // The diamond was a square turned 45 degrees, which made it the only slot whose
  // distinctness depended entirely on the marker being held world-fixed: lose the
  // counter-rotation and slots 3 and 4 become one marker wearing two names. It was also
  // the weakest of the four to read in a real capture -- its vertices point at the
  // corners where the hull is widest, so the outline collapsed to a flat line under the
  // tank. A starburst is topologically different from every other slot rather than a
  // rotation of one, so it survives both problems, and its points project OUTWARD past
  // the hull silhouette, which is exactly the visibility the diamond lacked.
  if (variant === 3) {
    // The starburst is NOT weight-corrected, and that is deliberate rather than an
    // oversight. Its edges run radially from a valley to a point, so they are not a
    // tangential band at all and `cos(PI / n)` does not describe them; its weight is the
    // WIDTH OF A TOOTH, which is set by the point count. It takes the shared outer radius
    // so it matches the family's size, and keeps its own taper.
    inner = SHAPE_OUTER_R - MARKER_WEIGHT * 2.2;
    outer = SHAPE_OUTER_R;
    // Outer edge alternates between the band's full radius and just above its inner edge,
    // so the star lives entirely inside the annulus the other three occupy -- a literal
    // 5-point star would need concave vertices at ~0.3 of the radius, which is under the
    // hull and invisible.
    // SIX TEETH, PINCHED TO NOTHING between them. The first build set the valleys at 18%
    // of the band and the shape rendered as a smooth hexagon -- at this size a shallow
    // waviness in an outline is not a star, it is a slightly irregular polygon. Taking the
    // valley all the way to `inner` collapses the band to zero width between points, so
    // the mark separates into six distinct teeth instead of one wobbly ring, which is the
    // only version of "star" that reads once the hull has eaten the far half of it.
    const points = 6;
    const valley = inner;
    const verts: [number, number][] = [];
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / points;
      verts.push([a, i % 2 === 0 ? outer : valley]);
    }
    verts.push(verts[0]);
    return starBand(verts, inner);
  }

  const spec: ReadonlyArray<{ sides: number; rotation: number }> = [
    { sides: segments, rotation: -Math.PI / 2 },
    { sides: 3, rotation: -Math.PI / 2 },
    { sides: 4, rotation: -Math.PI / 4 },
  ];
  const { sides, rotation } = spec[variant];
  ({ inner, outer } = bandForSides(sides));
  const angles = polygonAngles(sides, rotation);
  // Closed: the first vertex repeated, so the last edge is drawn like every other one.
  return bandGeometry([[...angles, angles[0]]], inner, outer);
}
