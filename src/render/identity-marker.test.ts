import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { identityMarkerGeometry } from './identity-marker';
import {
  IDENTITY_MARKER_STYLES,
  shapeOutlineFor,
  identityMarkerSpin,
  isIdentityMarkerStyle,
} from '../presentation/identity-marker';
import { IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R } from './entities';
import { TANK_RADIUS } from '../sim/constants';

// ---------------------------------------------------------------------------
// Issue #630. Second channels for player identity. `shape` won on #234 and ships in FFA
// (issue #922), resolved by the game layer before this module sees a style, and it is the
// one style left since issue #1023 deleted `arcs` and `roof`; here `null` is still "no
// marker", the solid ring every other mode draws.
//
// NOTHING IN THIS SUITE ASSERTED RING GEOMETRY BEFORE. The identity ring was well guarded
// on COLOUR -- a pairwise distinctness sweep over all four hues plus the roster -- and not
// at all on shape: no assertion anywhere touched its geometry type, segment count, theta
// or vertices. That asymmetry is exactly why a second channel carried in geometry needs
// its own guards rather than inheriting confidence from the colour ones.
// ---------------------------------------------------------------------------

const SEGMENTS = 48;
const build = (style: 'shape', slot: number) =>
  identityMarkerGeometry(style, slot, IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R, SEGMENTS)!;

/** The outer-rim vertices, as angles -- what the eye follows around the marker. */
function outerAngles(geo: THREE.BufferGeometry): number[] {
  const pos = geo.getAttribute('position');
  const out: number[] = [];
  for (let i = 0; i < pos.count; i += 2) out.push(Math.atan2(pos.getY(i), pos.getX(i)));
  return out;
}

/**
 * How many SEPARATE runs the marker draws, measured the way a player reads it: walk the
 * outer rim and count the angular jumps that are far larger than the sampling step.
 * Deliberately not "count the runs I passed in" -- that would assert the input back.
 */
function arcRuns(geo: THREE.BufferGeometry): number {
  const angles = outerAngles(geo);
  const step = (Math.PI * 2) / SEGMENTS;
  let runs = 1;
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    while (d < 0) d += Math.PI * 2;
    if (d > step * 2.5) runs++;
  }
  return runs;
}

describe('identity marker vocabulary (issue #630)', () => {
  it('offers exactly the shipped style, and rejects anything else', () => {
    // `arcs` and `roof` are rejects since issue #1023 deleted them, spelled literally so a
    // half-revert that put either back in the list fails here.
    expect([...IDENTITY_MARKER_STYLES]).toEqual(['shape']);
    for (const s of IDENTITY_MARKER_STYLES) expect(isIdentityMarkerStyle(s)).toBe(true);
    for (const bad of ['solid', 'arcs', 'roof', 'Arcs', '', 'shapes', 'Roof', null, 7, undefined]) {
      expect(isIdentityMarkerStyle(bad), String(bad)).toBe(false);
    }
  });

  it('every value survives a URL round trip', () => {
    // The dev flag arrives through URLSearchParams. A value containing a space or a `+`
    // would decode to something the parser then rejects, so the flag would silently do
    // nothing -- the failure mode of a developer experiment nobody can turn on.
    for (const s of IDENTITY_MARKER_STYLES) {
      expect(new URLSearchParams(`identityMarker=${s}`).get('identityMarker')).toBe(s);
    }
  });

  it('builds NOTHING when no marker is asked for', () => {
    // Null rather than a circle, and the distinction is the point: the caller then builds
    // the exact `RingGeometry` expression that shipped, so the default rendering is
    // unchanged down to the vertex rather than merely equivalent to it. A comparison whose
    // control has also moved is not a comparison.
    expect(identityMarkerGeometry(null, 0, 0.65, 0.8, SEGMENTS)).toBeNull();
  });
});

describe('identity marker: shape (issue #630)', () => {
  it('gives each of the four slots a different outline', () => {
    const sigs = [0, 1, 2, 3].map((s) => outerAngles(build('shape', s)).map((a) => a.toFixed(4)).join(','));
    expect(new Set(sigs).size, 'two slots share an outline').toBe(4);
  });

  it('makes slot 4 a STARBURST, not the square turned 45 degrees', () => {
    // WHY THE DIAMOND WENT. Slots 3 and 4 used to be the same 4-gon 45 degrees apart, so
    // slot 4's distinctness rested entirely on the marker being held world-fixed -- lose
    // the counter-rotation and the two became one marker wearing two names. It was also
    // the weakest of the four in a real capture: its vertices point at the corners where
    // the hull is widest, so the outline collapsed to a flat line under the tank.
    //
    // A starburst is topologically different rather than a rotation, which is what this
    // asserts: a varying outer radius is something no regular polygon in the set has.
    const square = build('shape', 2);
    const star = build('shape', 3);
    const radii = (g: THREE.BufferGeometry): number[] => {
      const pos = g.getAttribute('position');
      const out: number[] = [];
      for (let i = 0; i < pos.count; i += 2) out.push(Math.hypot(pos.getX(i), pos.getY(i)));
      return out;
    };
    const sq = radii(square), st = radii(star);
    const spread = (v: number[]): number => Math.max(...v) - Math.min(...v);
    expect(spread(sq), 'a square sits at one radius').toBeLessThan(1e-6);
    expect(spread(st), 'a starburst alternates between two').toBeGreaterThan(0.05);
    // ...and it reaches the family's own outer extent, which since issue #660 is LARGER
    // than the solid ring's. The ring is deliberately not moved -- it is the control.
    expect(Math.max(...st)).toBeGreaterThan(IDENTITY_RING_OUTER_R);
  });

  it('draws slot 1 as a full circle, matching the shipped ring it replaces', () => {
    // The first slot keeps the silhouette players already know; only slots 2-4 depart from
    // it. That is deliberate -- a channel that changes every slot makes the control harder
    // to compare against the default than it needs to be.
    expect(arcRuns(build('shape', 0))).toBe(1);
    expect(outerAngles(build('shape', 0)).length).toBe(SEGMENTS + 1);
  });
});

describe('identity marker: every shape reads at one weight (issue #660)', () => {
  /*
   * The shapes shared one band in WORLD units and therefore read at four different
   * weights. `bandGeometry` places both edges at the same vertex angles, so a polygon's
   * edges are chords and the perpendicular gap between them is the gap between apothems:
   * `band * cos(PI / n)`. That put the triangle at HALF the circle's ink.
   *
   * Measured perpendicular rather than radially, because radial width is the number that
   * was already equal and already wrong.
   */
  const perpendicular = (geo: THREE.BufferGeometry, sides: number): number => {
    const pos = geo.getAttribute('position');
    let outer = 0, inner = Infinity;
    for (let i = 0; i < pos.count; i += 2) {
      outer = Math.max(outer, Math.hypot(pos.getX(i), pos.getY(i)));
      inner = Math.min(inner, Math.hypot(pos.getX(i + 1), pos.getY(i + 1)));
    }
    // apothem gap: the perpendicular distance between two concentric n-gon edges
    return (outer - inner) * Math.cos(Math.PI / sides);
  };

  it('draws circle, triangle and square to the same perpendicular ink', () => {
    const w = [
      perpendicular(build('shape', 0), SEGMENTS),
      perpendicular(build('shape', 1), 3),
      perpendicular(build('shape', 2), 4),
    ];
    const spread = (Math.max(...w) - Math.min(...w)) / Math.max(...w);
    expect(spread, `widths ${w.map((v) => v.toFixed(4)).join(', ')}`).toBeLessThan(0.02);
  });

  it('NEGATIVE CONTROL: the old shared band did not', () => {
    // Without this the test above passes on any implementation that happens to give every
    // shape the same band, including the shipped one it was written to replace. These are
    // the numbers that motivated the change: 0.1497 / 0.0750 / 0.1061.
    const shared = (sides: number): number =>
      (IDENTITY_RING_OUTER_R - IDENTITY_RING_INNER_R) * Math.cos(Math.PI / sides);
    const w = [shared(SEGMENTS), shared(3), shared(4)];
    const spread = (Math.max(...w) - Math.min(...w)) / Math.max(...w);
    expect(spread, 'the shared band was already even').toBeGreaterThan(0.4);
  });

  it('sizes each shape so its EDGES clear the tank, without any corner running away', () => {
    /*
     * TUNED PER SHAPE, NOT DERIVED, and the two formulas that were tried say why.
     *
     *  - Shared CIRCUMRADIUS levels the corners and sends a triangle's edges to
     *    `R * cos(60)` = 0.44, inside TANK_RADIUS, so the hull ate them and the shape read
     *    as three orphaned corners.
     *  - Shared MEAN radius fixes the edges (0.59) and overshoots: corners at 1.17, and the
     *    triangle visibly dominates the set, because perceived size follows the extremes.
     *
     * A triangle cannot match a circle on both axes at once. So the contract is a
     * CONSTRAINT rather than an equality, which is what this asserts.
     */
    const SIDES = [SEGMENTS, 3, 4];
    const corners = [0, 1, 2].map((sl) => {
      const p = build('shape', sl).getAttribute('position');
      let r = 0;
      for (let i = 0; i < p.count; i += 2) r = Math.max(r, Math.hypot(p.getX(i), p.getY(i)));
      return r;
    });
    const edges = corners.map((r, i) => r * Math.cos(Math.PI / SIDES[i]));

    // 1. Every edge clears the hull by a visible margin. This is the one that the
    //    circumradius build failed, and the reason the triangle looked broken.
    for (const [i, e] of edges.entries()) {
      expect(e, `shape ${i} edge at ${e.toFixed(3)} is under the hull`)
        .toBeGreaterThan(TANK_RADIUS + 0.04);
    }

    // 2. No corner runs away from the family. The mean-radius build failed THIS one, at
    //    1.17 against the circle's 0.88 -- a 33% overshoot that read as "the triangle is
    //    huge". 30% is the bound this set is tuned inside.
    expect(Math.max(...corners) / Math.min(...corners),
      `corners ${corners.map((v) => v.toFixed(3)).join(', ')}`).toBeLessThan(1.30);

    // 3. ...and every shape still reaches past the solid ring it replaces, which must not
    //    itself have moved -- it is the control the candidates are compared against.
    for (const sl of [0, 1, 2, 3]) {
      const p = build('shape', sl).getAttribute('position');
      let r = 0;
      for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.getX(i), p.getY(i)));
      expect(r, `slot ${sl + 1}`).toBeGreaterThan(IDENTITY_RING_OUTER_R);
    }
  });
});

describe('identity marker: it does not spin with the hull (issue #630)', () => {
  /*
   * THE THING A MOCKUP CANNOT TELL YOU, and the reason this test composes real matrices
   * rather than trusting the sign.
   *
   * The ring is parented to the tank's group, and `view.group.rotation.y = -bodyA` is
   * written every frame. A circular annulus is rotation-invariant, so this never mattered
   * and nothing asserted it. It matters to `shape`: a square turned 45 degrees IS the
   * diamond.
   *
   * A wrong sign here does not look broken at a glance -- it spins the marker twice as
   * fast instead of stopping it, which at small turn rates reads as wobble. So the
   * assertion is on a world position under composed transforms, at several angles.
   */
  it('holds a marker vertex at a fixed world position through a full turn', () => {
    const group = new THREE.Object3D();
    const mesh = new THREE.Mesh(build('shape', 1));
    mesh.rotation.x = -Math.PI / 2;
    group.add(mesh);

    const local = new THREE.Vector3(IDENTITY_RING_OUTER_R, 0, 0);
    const seen: THREE.Vector3[] = [];
    for (const bodyA of [0, 0.4, 1.1, Math.PI / 2, Math.PI, 4.9, 6.0]) {
      group.rotation.y = -bodyA;
      mesh.rotation.z = identityMarkerSpin(bodyA);
      group.updateMatrixWorld(true);
      seen.push(local.clone().applyMatrix4(mesh.matrixWorld));
    }
    for (const p of seen) {
      expect(p.x, 'x drifted as the hull turned').toBeCloseTo(seen[0].x, 5);
      expect(p.z, 'z drifted as the hull turned').toBeCloseTo(seen[0].z, 5);
    }
  });

  it('NEGATIVE CONTROL: without the counter-rotation the same vertex does move', () => {
    // Without this, the test above passes on a marker that is accidentally symmetric, on a
    // `spin` that returns a constant, and on a parent that never rotated at all.
    const group = new THREE.Object3D();
    const mesh = new THREE.Mesh(build('shape', 1));
    mesh.rotation.x = -Math.PI / 2;
    group.add(mesh);
    const local = new THREE.Vector3(IDENTITY_RING_OUTER_R, 0, 0);

    group.rotation.y = 0;
    group.updateMatrixWorld(true);
    const at0 = local.clone().applyMatrix4(mesh.matrixWorld);
    group.rotation.y = -1.1;
    group.updateMatrixWorld(true);
    const at1 = local.clone().applyMatrix4(mesh.matrixWorld);
    expect(at0.distanceTo(at1)).toBeGreaterThan(0.1);
  });
});

/**
 * THE RING FOLLOWS THE SHARED TABLE (issue #778).
 *
 * The per-slot table moved to `presentation/identity-marker.ts` so the HUD stock strip can
 * draw the same mark. This side asserts the ring still does what the table says; the strip's
 * own half is in `game/hud.match.test.ts`. Between them a slot cannot change in one place
 * and stay put in the other, which is the disagreement the move exists to make impossible.
 *
 * Measured from the BUFFER rather than from the call: the expectation is derived from
 * `shapeOutlineFor` and compared against the vertices three.js actually produced, so
 * re-privatising the table into this file would fail here rather than quietly pass.
 */
describe('identity markers: the ring follows the shared table (issue #778)', () => {
  const samples = (g: THREE.BufferGeometry): number => g.getAttribute('position').count / 2;

  it('builds the outline the table names, for every slot', () => {
    // A band is two vertices per sample -- inner and outer -- and a CLOSED outline repeats
    // its first vertex, so an n-gon is n+1 samples. The star alternates point and valley,
    // so it is 2p+1. Both fall out of the table rather than being quoted as constants.
    for (let slot = 0; slot < 8; slot++) {
      const outline = shapeOutlineFor(slot);
      const want = outline.kind === 'circle' ? 48 + 1
        : outline.kind === 'polygon' ? outline.sides + 1
        : outline.points * 2 + 1;
      const geo = identityMarkerGeometry('shape', slot, 0.7, 0.8, 48);
      expect(geo, `slot ${slot} built no marker`).not.toBeNull();
      expect(samples(geo as THREE.BufferGeometry), `slot ${slot} (${outline.kind})`).toBe(want);
    }
  });
});
