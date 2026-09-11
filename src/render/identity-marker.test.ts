import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { identityMarkerGeometry } from './identity-marker';
import {
  IDENTITY_MARKER_STYLES,
  identityMarkerSpin,
  isIdentityMarkerStyle,
} from '../presentation/identity-marker';
import { IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R } from './entities';

// ---------------------------------------------------------------------------
// Issue #630. Two candidate second channels for player identity, both selectable and
// neither the default, so the owner can choose from real play rather than a mockup.
//
// NOTHING IN THIS SUITE ASSERTED RING GEOMETRY BEFORE. The identity ring was well guarded
// on COLOUR -- a pairwise distinctness sweep over all four hues plus the roster -- and not
// at all on shape: no assertion anywhere touched its geometry type, segment count, theta
// or vertices. That asymmetry is exactly why a second channel carried in geometry needs
// its own guards rather than inheriting confidence from the colour ones.
// ---------------------------------------------------------------------------

const SEGMENTS = 48;
const build = (style: 'arcs' | 'shape', slot: number) =>
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
/**
 * The biggest angular gap anywhere around the marker, in radians. For a closed ring every
 * gap is one sampling step; a real break is many times that. Written to be immune to the
 * `atan2` wrap that made an earlier version of the one-arc assertion vacuous.
 */
function largestGap(geo: THREE.BufferGeometry): number {
  const sorted = outerAngles(geo).map((a) => (a + Math.PI * 2) % (Math.PI * 2)).sort((x, y) => x - y);
  let max = sorted[0] + Math.PI * 2 - sorted[sorted.length - 1]; // the wrap-around gap
  for (let i = 1; i < sorted.length; i++) max = Math.max(max, sorted[i] - sorted[i - 1]);
  return max;
}

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
  it('offers exactly the two candidates, and rejects anything else', () => {
    expect([...IDENTITY_MARKER_STYLES]).toEqual(['arcs', 'shape']);
    for (const s of IDENTITY_MARKER_STYLES) expect(isIdentityMarkerStyle(s)).toBe(true);
    for (const bad of ['solid', 'Arcs', '', 'shapes', null, 7, undefined]) {
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

describe('identity marker: arcs (issue #630)', () => {
  it('draws one arc for slot 1, two for slot 2, three for slot 3, four for slot 4', () => {
    // The whole proposition of this candidate, measured off the geometry rather than
    // restated from the input.
    for (let slot = 0; slot < 4; slot++) {
      expect(arcRuns(build('arcs', slot)), `slot ${slot + 1}`).toBe(slot + 1);
    }
  });

  it('leaves a gap even at one arc', () => {
    // A closed ring and a nearly-closed one read differently. Were slot 1 drawn solid,
    // "the unbroken one is player 1" would be a rule a player has to be told rather than
    // one they can see -- and it would be indistinguishable from the shipped default.
    //
    // MEASURED AS THE LARGEST GAP, not as the span between the first and last vertex. The
    // first draft did the latter and was VACUOUS: `atan2` wraps to (-PI, PI], so with the
    // gap closed the first and last sample both land on -PI/2 and the span reads as zero,
    // which passed the assertion it was supposed to fail. The mutation
    // `identity-arcs-lose-their-gap-at-one` SURVIVED and is the only reason that was
    // caught -- reading the test did not catch it, and neither did watching it pass.
    expect(largestGap(build('arcs', 0))).toBeGreaterThan((Math.PI * 2) / SEGMENTS * 3);
  });

  it('keeps every slot inside the ring band the shipped ring occupies', () => {
    // A second channel must not become a bigger footprint: the marker occupies exactly the
    // annulus the solid ring already did, so nothing about spacing or overlap changes.
    for (let slot = 0; slot < 4; slot++) {
      const pos = build('arcs', slot).getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        expect(r).toBeGreaterThanOrEqual(IDENTITY_RING_INNER_R - 1e-6);
        expect(r).toBeLessThanOrEqual(IDENTITY_RING_OUTER_R + 1e-6);
      }
    }
  });
});

describe('identity marker: shape (issue #630)', () => {
  it('gives each of the four slots a different outline', () => {
    const sigs = [0, 1, 2, 3].map((s) => outerAngles(build('shape', s)).map((a) => a.toFixed(4)).join(','));
    expect(new Set(sigs).size, 'two slots share an outline').toBe(4);
  });

  it('distinguishes the square from the diamond, which are the same polygon turned 45 degrees', () => {
    // THE PAIR THAT ONLY WORKS BECAUSE THE MARKER IS HELD WORLD-FIXED. Slots 3 and 4 are
    // both 4-gons; all that separates them is a 45 degree offset. If the marker spun with
    // the hull they would be one marker wearing two names for most of every match, which
    // is the failure this candidate would have shipped with had the ring's parenting gone
    // unchecked.
    const square = outerAngles(build('shape', 2));
    const diamond = outerAngles(build('shape', 3));
    expect(square.length, 'both are four-sided').toBe(diamond.length);
    const offset = Math.abs(square[0] - diamond[0]);
    expect(offset).toBeGreaterThan(Math.PI / 4 - 0.01);
    expect(offset).toBeLessThan(Math.PI / 4 + 0.01);
  });

  it('draws slot 1 as a full circle, matching the shipped ring it replaces', () => {
    // The first slot keeps the silhouette players already know; only slots 2-4 depart from
    // it. That is deliberate -- a channel that changes every slot makes the control harder
    // to compare against the default than it needs to be.
    expect(arcRuns(build('shape', 0))).toBe(1);
    expect(outerAngles(build('shape', 0)).length).toBe(SEGMENTS + 1);
  });
});

describe('identity marker: it does not spin with the hull (issue #630)', () => {
  /*
   * THE THING A MOCKUP CANNOT TELL YOU, and the reason this test composes real matrices
   * rather than trusting the sign.
   *
   * The ring is parented to the tank's group, and `view.group.rotation.y = -bodyA` is
   * written every frame. A circular annulus is rotation-invariant, so this never mattered
   * and nothing asserted it. It matters to both candidates: an arc count is readable while
   * spinning, but a square turned 45 degrees IS the diamond.
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
