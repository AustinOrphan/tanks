import { describe, it, expect } from 'vitest';
import {
  IDENTITY_MARKER_STYLES, isIdentityMarkerStyle, MARKER_VARIANTS,
  markerVariant, shapeOutlineFor, polygonAngles, identityMarkerSpin,
} from './identity-marker';

/**
 * The SHARED TABLE (issue #778). These values used to be private to
 * `render/identity-marker.ts`, where one consumer could not disagree with itself. Two now
 * read them -- the arena ring and the HUD stock strip -- so what each slot wears is a
 * contract rather than an implementation detail, and this file is where that contract is
 * pinned. `render/identity-marker.test.ts` and `game/hud.match.test.ts` each assert their
 * own side follows it; a slot that moved here without both following would fail there.
 */
describe('identity markers: the shared per-slot table (issue #778)', () => {
  it('wraps every slot into a variant, including negative ones', () => {
    // `n % m` keeps the sign of the dividend in JavaScript, so a negative slot would index
    // off the front of every table here. The negative cases are the whole point of the
    // helper -- a plain `%` passes the first four and fails these.
    expect([0, 1, 2, 3].map(markerVariant)).toEqual([0, 1, 2, 3]);
    expect([4, 5, 6, 7].map(markerVariant), 'a fifth slot wraps').toEqual([0, 1, 2, 3]);
    expect([-1, -2, -3, -4].map(markerVariant), 'a negative slot wraps forward').toEqual([3, 2, 1, 0]);
    for (const slot of [-9, -1, 0, 3, 4, 17]) {
      const v = markerVariant(slot);
      expect(v, `slot ${slot} out of range`).toBeGreaterThanOrEqual(0);
      expect(v, `slot ${slot} out of range`).toBeLessThan(MARKER_VARIANTS);
    }
  });

  it('gives the four slots four DIFFERENT outlines -- the property the style exists for', () => {
    const seen = [0, 1, 2, 3].map((s) => JSON.stringify(shapeOutlineFor(s)));
    expect(new Set(seen).size, 'two slots share an outline').toBe(4);
    expect(shapeOutlineFor(0)).toEqual({ kind: 'circle' });
    expect(shapeOutlineFor(1)).toEqual({ kind: 'polygon', sides: 3, rotation: -Math.PI / 2 });
    expect(shapeOutlineFor(2)).toEqual({ kind: 'polygon', sides: 4, rotation: -Math.PI / 4 });
    expect(shapeOutlineFor(3)).toEqual({ kind: 'star', points: 6 });
    expect(shapeOutlineFor(4), 'a fifth slot wraps to the first').toEqual(shapeOutlineFor(0));
  });

  it('keeps the square a SQUARE, which is the collision the starburst was added to remove', () => {
    // Slot 3's rotation is load-bearing and is not free to normalise to 0. At `-PI/4` the
    // corners sit on the diagonals and the EDGES are flat to the screen; at 0 the corners
    // sit on the axes and it becomes the diamond slot 4 used to be -- one polygon wearing
    // two names. Asserted as "no vertex on an axis", which fails for the diamond and
    // passes for the square, rather than by quoting the rotation back at itself.
    const square = shapeOutlineFor(2);
    expect(square.kind).toBe('polygon');
    if (square.kind !== 'polygon') return;
    for (const a of polygonAngles(square.sides, square.rotation)) {
      const offAxis = Math.min(
        ...[0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI].map((axis) => Math.abs(a - axis)),
      );
      expect(offAxis, `a vertex sits on an axis at ${a} -- this is the diamond`).toBeGreaterThan(0.1);
    }
  });

  it('walks a polygon once, in order, from its stated rotation', () => {
    const angles = polygonAngles(3, -Math.PI / 2);
    expect(angles).toHaveLength(3);
    expect(angles[0], 'the first vertex is the rotation itself').toBeCloseTo(-Math.PI / 2, 12);
    // Evenly spaced and going round exactly once: a step of `2PI/sides` and no more.
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i] - angles[i - 1], `step ${i}`).toBeCloseTo((2 * Math.PI) / 3, 12);
    }
    expect(polygonAngles(4, 0)).toHaveLength(4);
    expect(polygonAngles(48, 0), 'the ring tessellates through the same helper').toHaveLength(48);
  });

  it('keeps the style vocabulary to `shape`, and rejects the deleted styles', () => {
    // Issue #1023 deleted `arcs` and `roof`, so `?dev=1&identityMarker=arcs` is rejected like
    // any unknown value. Spelled literally on both sides, because a loop over the production
    // list cannot see a member it has gained or lost.
    expect([...IDENTITY_MARKER_STYLES]).toEqual(['shape']);
    expect(isIdentityMarkerStyle('shape')).toBe(true);
    for (const s of ['arcs', 'roof', '', 'shapes', 'ring', 'none']) {
      expect(isIdentityMarkerStyle(s), s).toBe(false);
    }
    expect(identityMarkerSpin(1.23), 'the counter-rotation is the body angle').toBe(1.23);
  });
});
