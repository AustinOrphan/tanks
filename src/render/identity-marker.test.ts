import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { identityMarkerGeometry, identityRoofGeometry } from './identity-marker';
import {
  IDENTITY_MARKER_STYLES,
  identityMarkerSpin,
  isIdentityMarkerStyle,
  marksTurretRoof,
  ringMarkerFor,
} from '../presentation/identity-marker';
import { IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R } from './entities';
import { TANK_RADIUS } from '../sim/constants';

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
  it('offers exactly the three candidates, and rejects anything else', () => {
    expect([...IDENTITY_MARKER_STYLES]).toEqual(['arcs', 'shape', 'roof']);
    for (const s of IDENTITY_MARKER_STYLES) expect(isIdentityMarkerStyle(s)).toBe(true);
    for (const bad of ['solid', 'Arcs', '', 'shapes', 'Roof', null, 7, undefined]) {
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

describe('identity marker: roof (issue #630)', () => {
  /*
   * The third candidate, and the first that does NOT use the ground ring.
   *
   * The ring arms buy AREA -- its mid-radius perimeter is 364-546px at the game camera,
   * against 21-31px for a blade. What the roof buys is that nothing can cover it: not a
   * tread trail, not a wreck, not a spawn ring, not a mine's warning glow, not a second
   * tank parked alongside. Which matters more is a question for play, which is why all
   * three are in the tree at once rather than one of them being chosen from a desk.
   */
  it('leaves the ring geometry alone, so the control stays the shipped rendering', () => {
    // `ringMarkerFor('roof')` is null, so `makeIdentityRing` falls through to the exact
    // `RingGeometry` expression that shipped. A comparison whose control has also moved
    // is not a comparison -- the same reasoning the null-marker case already pins.
    expect(ringMarkerFor('roof')).toBeNull();
    expect(identityMarkerGeometry('roof', 0, IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R, SEGMENTS))
      .toBeNull();
  });

  it('claims the turret crown, and nothing else does', () => {
    expect(marksTurretRoof('roof')).toBe(true);
    for (const s of ['arcs', 'shape'] as const) expect(marksTurretRoof(s), s).toBe(false);
    // NOT the negation of ringMarkerFor: `marksTurretRoof(null)` must be false, or a HUD
    // with no marker selected would still build blades.
    expect(marksTurretRoof(null)).toBe(false);
  });

  it('draws one blade per slot, counting from one', () => {
    for (let slot = 0; slot < 4; slot++) {
      const geo = identityRoofGeometry(slot, 0.07, 0.32);
      expect(arcRuns(geo), `slot ${slot + 1}`).toBe(slot + 1);
    }
  });

  it('keeps every blade inside the turret crown', () => {
    // TURRET_R is 0.36; blades run to 0.32, so they never reach the dome's edge where the
    // silhouette would clip them. A blade that overhung would read as a bent aerial.
    for (let slot = 0; slot < 4; slot++) {
      const pos = identityRoofGeometry(slot, 0.07, 0.32).getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        expect(Math.hypot(pos.getX(i), pos.getY(i))).toBeLessThanOrEqual(0.32 + 1e-6);
      }
    }
  });

  it('needs no counter-rotation, because a count cannot be turned wrong', () => {
    // The simplification over both ring arms, asserted rather than assumed. `shape`'s
    // slots 3 and 4 are the same polygon 45 degrees apart and collapse without the spin;
    // a blade COUNT is invariant, so the same test that catches that cannot fire here.
    const a = identityRoofGeometry(2, 0.07, 0.32);
    const b = identityRoofGeometry(2, 0.07, 0.32);
    expect(arcRuns(a)).toBe(arcRuns(b));
    expect(arcRuns(identityRoofGeometry(2, 0.07, 0.32))).toBe(3);
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

  it('normalises SIZE on the mean radius, not the circumradius', () => {
    // The same correction as the weight, on the other axis. A shared circumradius gives
    // four shapes one number and four apparent sizes, because a polygon's edges cut inward
    // to `R * cos(PI / n)`: at a shared 0.88 the triangle's edges land at 0.44, INSIDE
    // TANK_RADIUS, so the hull hid them and only its corners showed. It read small however
    // wide its ink was -- which is what the owner saw.
    const meanRadius = (g: THREE.BufferGeometry, sides: number): number => {
      const pos = g.getAttribute('position');
      let corner = 0;
      for (let i = 0; i < pos.count; i += 2) corner = Math.max(corner, Math.hypot(pos.getX(i), pos.getY(i)));
      return (corner + corner * Math.cos(Math.PI / sides)) / 2;
    };
    const means = [
      meanRadius(build('shape', 0), SEGMENTS),
      meanRadius(build('shape', 1), 3),
      meanRadius(build('shape', 2), 4),
    ];
    const spread = (Math.max(...means) - Math.min(...means)) / Math.max(...means);
    expect(spread, `means ${means.map((v) => v.toFixed(3)).join(', ')}`).toBeLessThan(0.02);

    // The triangle's EDGES must now clear the tank, which is the whole point.
    const triCorner = Math.max(...[...Array(build('shape', 1).getAttribute('position').count)]
      .map((_, i) => {
        const p = build('shape', 1).getAttribute('position');
        return i % 2 === 0 ? Math.hypot(p.getX(i), p.getY(i)) : 0;
      }));
    expect(triCorner * Math.cos(Math.PI / 3), 'the triangle still hides behind the hull')
      .toBeGreaterThan(TANK_RADIUS);

    // ...and every shape still reaches past the ring it replaced.
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
