// Three computes camera matrices and projection on the CPU, so what the camera
// actually frames is testable without a GL context. Nothing checked this before:
// scene.ts builds a WebGLRenderer and so cannot be constructed under vitest, which
// left the framing verifiable only by eye -- and it was wrong by eye for the whole
// vertical slice.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { framedBounds, fitCameraToArea, framedAreaFits, FRAME_MARGIN } from './framing';
import { CURRENT_ARENA, arenaBounds, loadArena } from '../sim/arena';

const { width: W, height: H } = arenaBounds(CURRENT_ARENA);
const BOUNDARY = CURRENT_ARENA.cellSize;
const TARGET = new THREE.Vector3(W / 2, 0, H / 2);

// Portrait phone through to ultrawide. A fixed camera cannot scroll, so anything
// cropped at any of these is permanently unreachable and unaimable.
const ASPECTS = [0.46, 0.75, 1.0, 1.33, 1.6, 1.78, 2.33, 3.0];

function cameraAt(aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000);
  const { width, height } = framedBounds(W, H, BOUNDARY);
  fitCameraToArea(cam, TARGET, width, height);
  return cam;
}

describe('framedBounds', () => {
  it('covers the playable area plus the boundary ring exactly', () => {
    // The ring is one cell thick and sits OUTSIDE play, so the framed area is two
    // rings wider and taller than the board. Larger than this and a strip of ground
    // shows beyond the walls; smaller and the walls hang over the clear colour.
    // BOUNDARY (= CURRENT_ARENA.cellSize) is now 2/3, was 2, so the ring adds
    // 2 * 2/3 = 4/3 per axis rather than the old flat 4. Written as the literal
    // fraction `4/3`, not `BOUNDARY * 2`, so this still fails if framedBounds'
    // multiplier or sign drifts -- referencing BOUNDARY here would just restate
    // framedBounds' own body, the tautology the next test's comment warns against.
    expect(framedBounds(W, H, BOUNDARY)).toEqual({ width: W + 4 / 3, height: H + 4 / 3 });
  });

  it('matches the outer extent of the arena walls it has to cover', () => {
    // Derived from the walls THEMSELVES, by reading the AABBs loadArena actually
    // builds. Restating `W + BOUNDARY * 2` here -- as this test used to -- only
    // re-derives framedBounds' own body, so it could not fail; it left the ring
    // thickness free to drift away from what the camera frames.
    const { walls } = loadArena(CURRENT_ARENA);
    const minX = Math.min(...walls.map((w) => w.aabb.minX));
    const maxX = Math.max(...walls.map((w) => w.aabb.maxX));
    const minY = Math.min(...walls.map((w) => w.aabb.minY));
    const maxY = Math.max(...walls.map((w) => w.aabb.maxY));

    const { width, height } = framedBounds(W, H, BOUNDARY);
    // `maxX - minX` (computed as `(W + t) - (-t)`) and framedBounds' own
    // `W + t * 2` are mathematically identical, and were bit-for-bit equal at the
    // old cellSize (2, exactly representable in binary). At 2/3 -- inexact in
    // binary -- the two expressions round differently in the last bit: measured
    // 23.333333333333332 vs 23.333333333333336, a difference of ~3.55e-15 (a few
    // ULPs on a value of this magnitude), not a geometry drift. toBeCloseTo(_, 12)
    // tolerates ~5e-13, four orders of magnitude looser than the actual gap.
    expect(width).toBeCloseTo(maxX - minX, 12);
    expect(height).toBeCloseTo(maxY - minY, 12);
  });

  it('scales with the boundary it is given, not with the shipped arena', () => {
    // The shipped cellSize is 2, so `W + BOUNDARY * 2` and a hardcoded `W + 4` are
    // the same number: every other assertion in this file still passes if the body
    // ignores its `boundary` argument outright. Only a different boundary sees that.
    expect(framedBounds(10, 8, 3)).toEqual({ width: 16, height: 14 });
    expect(framedBounds(10, 8, 0)).toEqual({ width: 10, height: 8 });
  });
});

describe('camera framing', () => {
  it.each(ASPECTS)('contains the whole arena and its walls at aspect %s', (aspect) => {
    const cam = cameraAt(aspect);
    const { width, height } = framedBounds(W, H, BOUNDARY);
    expect(framedAreaFits(cam, TARGET, width, height, FRAME_MARGIN)).toBe(true);
  });

  it.each(ASPECTS)('wastes little screen at aspect %s: the arena fills one axis', (aspect) => {
    // The point of the change. Fitting is trivially satisfiable by standing far
    // enough back, so this pins the other side: at the fitted distance the framed
    // area must nearly touch the viewport edge on its tighter axis.
    const cam = cameraAt(aspect);
    const { width, height } = framedBounds(W, H, BOUNDARY);
    const v = new THREE.Vector3();
    let maxX = 0;
    let maxY = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        v.set(TARGET.x + (sx * width) / 2, 0, TARGET.z + (sz * height) / 2).project(cam);
        maxX = Math.max(maxX, Math.abs(v.x));
        maxY = Math.max(maxY, Math.abs(v.y));
      }
    }
    // One axis is the binding constraint and must sit right at the margin.
    expect(Math.max(maxX, maxY)).toBeGreaterThan(1 - FRAME_MARGIN - 0.01);
    expect(Math.max(maxX, maxY)).toBeLessThanOrEqual(1 - FRAME_MARGIN + 1e-6);
  });

  it('pulls BACK for a narrower viewport rather than cropping', () => {
    const wide = cameraAt(1.78).position.length();
    const narrow = cameraAt(0.75).position.length();
    expect(narrow).toBeGreaterThan(wide);
  });

  it('looks at the arena centre from above and behind', () => {
    const cam = cameraAt(1.6);
    expect(cam.position.x).toBeCloseTo(TARGET.x, 6); // centred on the board
    expect(cam.position.y).toBeGreaterThan(0); // above the ground
    expect(cam.position.z).toBeGreaterThan(TARGET.z); // and behind it
  });

  it('is a real fit, not a constant: a bigger arena moves the camera back', () => {
    // Guards the whole function against being reduced to a hardcoded position --
    // the failure mode of the code it replaces.
    const small = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1000);
    fitCameraToArea(small, TARGET, 10, 10);
    const large = new THREE.PerspectiveCamera(50, 1.6, 0.1, 1000);
    fitCameraToArea(large, TARGET, 100, 100);
    expect(large.position.distanceTo(TARGET)).toBeGreaterThan(
      small.position.distanceTo(TARGET) * 5,
    );
  });
});
