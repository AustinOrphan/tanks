// Three computes camera matrices and projection on the CPU, so what the camera
// actually frames is testable without a GL context. Nothing checked this before:
// scene.ts builds a WebGLRenderer and so cannot be constructed under vitest, which
// left the framing verifiable only by eye -- and it was wrong by eye for the whole
// vertical slice.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { framedBounds, fitCameraToArea, framedAreaFits, FRAME_MARGIN, VIEW_DIR } from './framing';
import { CURRENT_ARENA, ARENAS, arenaBounds, loadArena } from '../sim/arena';
// The SHIPPED field of view, not a copy: a test that hardcoded 30 would keep passing
// after someone widened the real camera back out, which is the regression this guards.
import { BASE_FOV } from './scene';

const { width: W, height: H } = arenaBounds(CURRENT_ARENA);
const BOUNDARY = CURRENT_ARENA.cellSize;
const TARGET = new THREE.Vector3(W / 2, 0, H / 2);

// Portrait phone through to ultrawide. A fixed camera cannot scroll, so anything
// cropped at any of these is permanently unreachable and unaimable.
//
// 0.42 and 2.39 are the two a phone actually produces that this list was missing:
// 20:9 is the shape of a Pixel 8 / Galaxy S24 held upright, and 21:9 the shape of a
// Sony Xperia held sideways. 0.46 (19.5:9, the iPhone) was already here, and it is the
// wrong end of the range to stop at -- 0.42 needs 9% more camera distance than 0.46 to
// contain the same board, and `fitCameraToArea` does not report failure when its
// bisection bracket runs out: it returns a camera that CROPS. Measured on this tree,
// every combination below fits.
const ASPECTS = [0.42, 0.46, 0.75, 1.0, 1.33, 1.6, 1.78, 2.33, 2.39, 3.0];

/**
 * Every (arena, aspect) pair -- population: 4 shipped arenas x 10 aspects = 40.
 *
 * The sweep used to run against `CURRENT_ARENA` alone, which is one BOARD SHAPE: three
 * of the four shipped arenas are 33x27, and arena-04 (45x33) is the only one that
 * differs. A per-arena refit is exactly what the fit exists to do, so testing it at one
 * shape tested half the function.
 */
const COMBOS: Array<[string, (typeof ARENAS)[number], number]> = ARENAS.flatMap((arena, i) =>
  ASPECTS.map((aspect) => [`arena ${i + 1} @ ${aspect}`, arena, aspect] as [string, typeof arena, number]),
);

/** The camera, and the rect it has to contain, for one arena at one aspect. */
function fitted(
  arena: (typeof ARENAS)[number],
  aspect: number,
): { cam: THREE.PerspectiveCamera; target: THREE.Vector3; width: number; height: number } {
  const bounds = arenaBounds(arena);
  const { width, height } = framedBounds(bounds.width, bounds.height, arena.cellSize);
  const target = new THREE.Vector3(bounds.width / 2, 0, bounds.height / 2);
  // BASE_FOV, not a literal: this sweep spent its whole life validating a 50-degree
  // camera, and when the game moved to 30 it carried on testing the old one. Review
  // caught that it still passes at 30 -- so no live bug -- but it was unasserted.
  const cam = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.1, 1000);
  fitCameraToArea(cam, target, width, height);
  return { cam, target, width, height };
}

function cameraAt(aspect: number): THREE.PerspectiveCamera {
  return fitted(CURRENT_ARENA, aspect).cam;
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
  it.each(COMBOS)('contains the whole arena and its walls, %s', (_label, arena, aspect) => {
    const { cam, target, width, height } = fitted(arena, aspect);
    expect(framedAreaFits(cam, target, width, height, FRAME_MARGIN)).toBe(true);
  });

  it.each(COMBOS)('wastes little screen, %s: the arena fills one axis', (_label, arena, aspect) => {
    // The point of the change. Fitting is trivially satisfiable by standing far
    // enough back, so this pins the other side: at the fitted distance the framed
    // area must nearly touch the viewport edge on its tighter axis.
    const { cam, target, width, height } = fitted(arena, aspect);
    const v = new THREE.Vector3();
    let maxX = 0;
    let maxY = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        v.set(target.x + (sx * width) / 2, 0, target.z + (sz * height) / 2).project(cam);
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

describe('the camera elevation is pinned', () => {
  it('holds the shipped tilt, which nothing else was guarding', () => {
    // `VIEW_DIR` was imported by NO test -- only its sign was asserted anywhere. Review
    // measured that swinging it from 51 to 80 degrees, a near-top-down camera and a
    // different game to look at, passed ALL 1538 tests including this file's own
    // coverage floor. Of integer tilts 30-89 (population 60), 27 survived that floor.
    //
    // Tilt is also the second-strongest lever on coverage after fov, and its optimum is
    // viewport-dependent (more top-down helps 4:3 and hurts 16:9 locally), so it is
    // exactly the kind of constant that gets nudged for one aspect and silently costs
    // another.
    //
    // Be clear about what this is: a TRIPWIRE, not coverage. It re-derives 51.0 from
    // VIEW_DIR and compares it to 51.0, so it asserts no framing property at all -- it
    // makes changing the tilt deliberate, the way constants.test.ts pins the balance
    // scalars. The property test that ought to catch tilt is the coverage floor below,
    // and it demonstrably cannot: 27 of integer tilts 30-89 clear it.
    const elevationDeg = (Math.atan2(VIEW_DIR.y, VIEW_DIR.z) * 180) / Math.PI;
    expect(elevationDeg).toBeCloseTo(51.0, 1);
    // No roll: an x component would tip the board off square to the screen.
    expect(VIEW_DIR.x).toBe(0);
    expect(VIEW_DIR.length()).toBeCloseTo(1, 9);
  });
});

describe('the board actually fills the screen', () => {
  /**
   * Austin, with a Wii Play: Tanks! screenshot for reference: "the play area should take
   * up the full screen (of course no stretching allowed lol) much like it does in Wii
   * play tanks".
   *
   * The old camera left more than half the frame empty -- 48.5% covered at 16:9, 39.9%
   * at a phone's landscape aspect. Two things were spending it: FRAME_MARGIN charged on
   * both sides of both axes, and a 50-degree lens, which converges the board's far edge
   * hard and wastes the two triangles beside it. Neither is a stretch, so neither shows
   * up in any existing assertion -- the board simply sat there being small.
   *
   * This measures the projected AREA of the framed rect as a fraction of the frame,
   * through the same projection the renderer uses, and imports the SHIPPED `BASE_FOV`
   * rather than a copy so that raising the lens back fails here.
   */
  const shoelace = (p: THREE.Vector3[]): number => {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      a += p[i].x * q.y - q.x * p[i].y;
    }
    return Math.abs(a) / 2;
  };

  /** Fraction of the frame the framed rect covers, at one arena and one aspect. */
  const coverage = (arena: (typeof ARENAS)[number], aspect: number): number => {
    const bounds = arenaBounds(arena);
    const framed = framedBounds(bounds.width, bounds.height, arena.cellSize);
    const target = new THREE.Vector3(bounds.width / 2, 0, bounds.height / 2);
    const camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.1, 1000);
    fitCameraToArea(camera, target, framed.width, framed.height);
    const hw = framed.width / 2;
    const hh = framed.height / 2;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sz]) =>
      new THREE.Vector3(target.x + sx * hw, 0, target.z + sz * hh).project(camera),
    );
    // NDC spans [-1, 1] on both axes, so the whole frame has area 4.
    return shoelace(corners) / 4;
  };

  // 16:10 and 4:3 are desktop windows; 2.16 is a phone held sideways, which is the
  // WORST case here because the board is far taller in proportion than the viewport.
  const ASPECTS: Array<[string, number]> = [
    ['16:9', 16 / 9],
    ['16:10', 1.6],
    ['4:3', 4 / 3],
    ['phone landscape', 2.16],
  ];

  it('covers at least 48% of the frame, on every shipped arena at every common aspect', () => {
    // Population: all 4 shipped arenas x 4 aspects = 16, every one checked -- not a
    // sample. The floor sits just under the measured worst case (49.1%, arena-01 on a
    // phone) and comfortably above what the old camera managed anywhere (39.9% there).
    const thin: string[] = [];
    let checked = 0;
    for (const [i, arena] of ARENAS.entries()) {
      for (const [label, aspect] of ASPECTS) {
        checked += 1;
        const f = coverage(arena, aspect);
        if (f < 0.48) thin.push(`arena ${i + 1} @ ${label}: ${(f * 100).toFixed(1)}%`);
      }
    }
    // ARENAS.length pinned outright. `checked === ARENAS.length * ASPECTS.length`
    // below cannot fail from any PRODUCTION change -- both sides move together -- so it
    // is kept only as a loop-integrity check (it would catch a stray `continue` added
    // to this test), and it is this line that carries the production sensitivity: it
    // fails when a level is added, which is exactly when the floor deserves
    // re-measuring.
    expect(ARENAS.length, 'a level was added; re-measure the coverage floor').toBe(4);
    expect(checked).toBe(ARENAS.length * ASPECTS.length);
    expect(thin).toEqual([]);
  });

  it('measures what a phone aspect costs, which is the orientation-lock evidence', () => {
    // Issue #108's actual question: must a mobile build lock landscape? The failure it
    // was filed against -- `fitCameraToArea` returning a cropping camera below aspect
    // ~0.249 (backlog.md) -- does NOT occur at 20:9: the containment sweep above passes
    // at 0.42 on all four arenas. So nothing is unreachable in portrait, and the case
    // for a lock is not correctness.
    //
    // It is this instead, and it is worth having as a number rather than an impression:
    // the same board at 20:9 portrait fills about a fifth of the screen, against about
    // half at the phone-landscape aspect the coverage floor above is measured at. That
    // is a product decision (lock landscape, or accept a small board in portrait), and
    // it is recorded here so it stays measured.
    //
    // A TRIPWIRE, and stated as one: these are upper bounds, so improving portrait
    // framing FAILS this test. That is the intent -- the day it moves is the day the
    // orientation decision is worth re-reading -- not a claim that thin is correct.
    //
    // What it does and does not catch, measured rather than asserted. It FAILS if
    // VIEW_DIR's tilt goes to 80 degrees (portrait rises to 31.3%), if BASE_FOV widens
    // to 50 (21:9 falls to 38.0%) or narrows to 20 (21:9 rises to 54.1% on arena-04).
    // It does NOT fail if FRAME_MARGIN doubles to 0.06 (portrait 19.6%, 21:9 42.0%) --
    // that one is killed by the coverage floor above and by the manifest entry
    // `framing-frame-margin-doubled`. The bands are wide enough to survive a retune and
    // narrow enough to catch a different camera.
    const at = (aspect: number): number[] => ARENAS.map((arena) => coverage(arena, aspect));
    // Population: all 4 shipped arenas, at each of the two aspects issue #108 names.
    const portrait = at(0.42); // 20:9 upright
    const ultrawide = at(2.39); // 21:9 sideways
    expect(portrait).toHaveLength(4);
    for (const f of portrait) {
      expect(f, 'portrait now fills a quarter of the frame -- re-read the orientation decision').toBeLessThan(0.25);
      expect(f).toBeGreaterThan(0.15);
    }
    // 21:9 is the other end and costs far less: it is below the 48% floor the four
    // common aspects hold, but by single digits rather than by half.
    for (const f of ultrawide) {
      expect(f).toBeLessThan(0.5);
      expect(f, '21:9 is no longer the mild case -- the floor above may need re-measuring').toBeGreaterThan(0.4);
    }
    // The contrast is the finding, not either number on its own.
    expect(Math.max(...portrait)).toBeLessThan(Math.min(...ultrawide) / 1.8);
  });

  it('still contains the whole board -- filling the screen must never crop it', () => {
    // The counterweight to the test above: coverage is trivially maximised by flying
    // the camera in until the board overflows the frame. Every corner must stay inside
    // NDC, which is the same property fitCameraToArea solves for, checked here at the
    // shipped fov across the same 16 combinations.
    const cropped: string[] = [];
    for (const [i, arena] of ARENAS.entries()) {
      for (const [label, aspect] of ASPECTS) {
        const bounds = arenaBounds(arena);
        const framed = framedBounds(bounds.width, bounds.height, arena.cellSize);
        const target = new THREE.Vector3(bounds.width / 2, 0, bounds.height / 2);
        const camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.1, 1000);
        fitCameraToArea(camera, target, framed.width, framed.height);
        if (!framedAreaFits(camera, target, framed.width, framed.height, 0)) {
          cropped.push(`arena ${i + 1} @ ${label}`);
        }
      }
    }
    expect(cropped).toEqual([]);
  });
});
