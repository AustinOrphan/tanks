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
 * How big every `shape` marker reads, larger than the solid ring's 0.80 (issue #660: "they
 * probably could stand to be a bit bigger across the board").
 *
 * NOT A SHARED CIRCUMRADIUS, and the first build of this got that wrong in exactly the way
 * the weight was wrong. Giving every shape the same circumradius gives them the same number
 * and four different apparent sizes, because a polygon's EDGES cut inward to its apothem,
 * `R * cos(PI / n)`:
 *
 *   circle    edge at 0.88
 *   square    edge at 0.62
 *   triangle  edge at 0.44   <- inside TANK_RADIUS (0.5), so the hull hides it
 *
 * Only the triangle's three corners cleared the tank at all, which is why it read small
 * however wide its ink was.
 *
 * So the size a shape is normalised on is its MEAN radius, halfway between corner and edge.
 * Matching apothems instead would put every edge at 0.88 and be the most literally equal --
 * but it throws the triangle's corners out to 1.76, more than three times the tank's radius,
 * which is a different shape of wrong. The mean puts the triangle's edges just outside the
 * hull (0.59) and its corners at 1.17.
 *
 * Two tanks at their closest legal approach have centres `TANK_RADIUS * 2` = 1.0 apart, so
 * markers already overlapped at 0.80; this does not introduce overlap, it changes how much.
 * That is a judgement for a capture rather than for arithmetic.
 */
const SHAPE_MEAN_R = 0.88;

/**
 * The size of each outline, TUNED PER SHAPE rather than derived (issue #660).
 *
 * Two formulas were tried and both produce a number that is equal and does not look it:
 *
 *  - Shared CIRCUMRADIUS puts every corner on one circle, and a triangle's edges then cut
 *    inward to `R * cos(60) = 0.44` -- inside `TANK_RADIUS` (0.5), so the hull swallowed
 *    them and the triangle read as three orphaned corners.
 *  - Shared MEAN radius fixes that (edges at 0.59) and overshoots the other way: the
 *    triangle's corners reach 1.17, 2.35x the tank, and it visibly dominates the set.
 *    Perceived size follows the EXTREMES, not the mean.
 *
 * A triangle cannot match a circle on both axes at once; this is the ordinary icon-scaling
 * problem, and icon sets solve it by hand rather than by formula. So these are chosen
 * against a constraint instead: every edge clears the tank by at least 0.05, and corners sit
 * as close to level as that allows.
 *
 *   circle     0.880 corner   0.880 edge
 *   square     0.930          0.658
 *   triangle   1.100          0.550
 *   starburst  0.990          0.748 (its valleys, not an apothem)
 *
 * `SHAPE_MEAN_R` above is kept as the family's nominal size, the number to move if the whole
 * set should grow or shrink; the per-shape values are ratios against it.
 */
const SHAPE_SCALE: Readonly<Record<number, number>> = { 48: 1.0, 4: 1.057, 3: 1.25 };

/** The starburst's own size, in the same nominal units. */
const STAR_SCALE = 1.125;

function bandForSides(sides: number): { inner: number; outer: number } {
  const k = Math.cos(Math.PI / sides);
  const outer = SHAPE_MEAN_R * (SHAPE_SCALE[sides] ?? 1);
  return { inner: outer - MARKER_WEIGHT / k, outer };
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
    // The starburst alternates corner and valley by design, so its mean radius is
    // already the midpoint of its own extremes -- it takes SHAPE_MEAN_R directly.
    outer = SHAPE_MEAN_R * STAR_SCALE;
    inner = outer - MARKER_WEIGHT * 2.2;
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
