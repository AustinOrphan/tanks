import { describe, it, expect } from 'vitest';
import {
  stickVector,
  touchSide,
  isTap,
  isDoubleTap,
  STICK_RADIUS_PX,
  STICK_DEADZONE,
  TAP_MAX_MS,
  TAP_SLOP_PX,
  DOUBLE_TAP_MAX_MS,
  DOUBLE_TAP_SLOP_PX,
  type TouchSample,
} from './touch';

/** A thumb that landed at the origin and moved by (dx, dy) CSS px. */
const push = (dx: number, dy: number): ReturnType<typeof stickVector> =>
  stickVector({ x: 100, y: 100 }, { x: 100 + dx, y: 100 + dy }, STICK_RADIUS_PX);

const len = (v: { x: number; y: number }): number => Math.hypot(v.x, v.y);

describe('the virtual thumbstick', () => {
  it('is still while the thumb has not left the dead zone', () => {
    // A thumb resting on glass drifts. Without this the tank creeps while the player is
    // only aiming, which reads as the game being possessed rather than as a dead zone.
    // Swept just inside the boundary rather than at one convenient point.
    for (const frac of [0, 0.05, 0.1, STICK_DEADZONE - 0.001]) {
      const v = push(STICK_RADIUS_PX * frac, 0);
      expect(v, `at ${frac} of the radius`).toEqual({ x: 0, y: 0 });
    }
  });

  it('moves as soon as the thumb passes the dead zone, and only then', () => {
    // The discriminating pair: the boundary must SEPARATE the two behaviours. Asserting
    // only the still side would pass on a stick that never moved at all.
    expect(len(push(STICK_RADIUS_PX * (STICK_DEADZONE - 0.001), 0))).toBe(0);
    expect(len(push(STICK_RADIUS_PX * (STICK_DEADZONE + 0.01), 0))).toBeGreaterThan(0);
  });

  it('reaches full speed at the radius and never exceeds it', () => {
    expect(len(push(STICK_RADIUS_PX, 0))).toBeCloseTo(1, 9);
    // Past the radius the thumb has run out of stick, not out of tank: clamp, do not
    // scale. A player dragging to the screen edge must not move faster than one at the
    // radius, or the control has no top and no feel.
    for (const overshoot of [1.5, 3, 20]) {
      expect(len(push(STICK_RADIUS_PX * overshoot, 0)), `${overshoot}x`).toBeCloseTo(1, 9);
    }
  });

  it('starts from a crawl rather than jumping to the dead-zone speed', () => {
    // Without the rescale, the first movement past the dead zone would be 0.18 of full
    // speed -- a lurch. This is what makes the stick feel analogue.
    const justPast = len(push(STICK_RADIUS_PX * (STICK_DEADZONE + 0.005), 0));
    expect(justPast).toBeGreaterThan(0);
    expect(justPast).toBeLessThan(0.05);
  });

  it('sends the tank the way the thumb points, with screen-up as sim-NORTH', () => {
    // The sim's +y is SOUTH on screen, so a thumb pushed UP must give NEGATIVE y. This
    // is the same inversion readMove() applies to W, and it shipped backwards there
    // once: holding w moved the player 65px DOWN a 600px viewport.
    expect(push(0, -STICK_RADIUS_PX).y).toBeCloseTo(-1, 9); // thumb up   -> north
    expect(push(0, STICK_RADIUS_PX).y).toBeCloseTo(1, 9); // thumb down -> south
    expect(push(-STICK_RADIUS_PX, 0).x).toBeCloseTo(-1, 9); // thumb left -> west
    expect(push(STICK_RADIUS_PX, 0).x).toBeCloseTo(1, 9); // thumb right-> east
  });

  it('keeps the direction the thumb actually points on a diagonal', () => {
    // Normalising each axis independently would snap a diagonal to 45 degrees. Push at a
    // 2:1 ratio and the ratio must survive.
    const v = push(STICK_RADIUS_PX * 2, STICK_RADIUS_PX); // clamped, but 2:1
    expect(v.y === 0 ? Infinity : v.x / v.y).toBeCloseTo(2, 6);
    expect(len(v)).toBeCloseTo(1, 9);
  });

  it('is still when the thumb has not moved at all', () => {
    // The zero-distance case divides by the distance; without its guard this is NaN,
    // and a NaN move vector propagates into the sim as a tank that vanishes.
    const v = stickVector({ x: 10, y: 10 }, { x: 10, y: 10 });
    expect(v).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(v.x) || Number.isNaN(v.y)).toBe(false);
  });
});

describe('which thumb is which', () => {
  it('splits the viewport down the middle: left drives, right aims', () => {
    expect(touchSide(0, 800)).toBe('move');
    expect(touchSide(399, 800)).toBe('move');
    expect(touchSide(400, 800)).toBe('aim'); // the midpoint belongs to aim
    expect(touchSide(800, 800)).toBe('aim');
  });

  it('follows the width it is given, so a rotation re-splits', () => {
    // Taking the width as an argument rather than reading window.innerWidth is what
    // makes a landscape/portrait flip correct instead of leaving the split at the old
    // midpoint -- where the driving thumb would suddenly be aiming.
    expect(touchSide(500, 800)).toBe('aim');
    expect(touchSide(500, 1600)).toBe('move');
  });
});

describe('telling a tap from a drag', () => {
  const sample = (o: Partial<TouchSample> = {}): TouchSample => ({
    downAt: 1000,
    upAt: 1100,
    from: { x: 300, y: 400 },
    to: { x: 300, y: 400 },
    ...o,
  });

  it('accepts a brief touch that stayed put', () => {
    expect(isTap(sample())).toBe(true);
  });

  it('rejects a touch held too long -- that is a thumb resting to aim, not a trigger', () => {
    expect(isTap(sample({ upAt: 1000 + TAP_MAX_MS }))).toBe(true); // the boundary is a tap
    expect(isTap(sample({ upAt: 1000 + TAP_MAX_MS + 1 }))).toBe(false);
  });

  it('rejects a touch that travelled -- that is a drag, and under stick it is aiming', () => {
    // Swept across the boundary rather than sampled at one convenient distance.
    expect(isTap(sample({ to: { x: 300 + TAP_SLOP_PX, y: 400 } }))).toBe(true);
    expect(isTap(sample({ to: { x: 300 + TAP_SLOP_PX + 1, y: 400 } }))).toBe(false);
    // Diagonal: the slop is a RADIUS, not a per-axis budget. 9+9 is inside 12 per axis
    // but 12.7 away, so a per-axis check would wrongly accept it.
    expect(isTap(sample({ to: { x: 309, y: 409 } }))).toBe(false);
  });
});

describe('telling a double-tap from a re-aim', () => {
  const at = (downAt: number, x: number, y: number): TouchSample => ({
    downAt,
    upAt: downAt + 60,
    from: { x, y },
    to: { x, y },
  });

  it('accepts two quick taps in the same place', () => {
    expect(isDoubleTap(at(1000, 300, 400), at(1200, 300, 400))).toBe(true);
  });

  it('REJECTS two quick taps in different places -- that is someone re-aiming', () => {
    // The whole reason double-tap is safe where a single tap is not. Without the
    // distance test, adjusting aim twice in quick succession would fire a shell -- the
    // exact defect this control scheme was reworked to remove.
    expect(isDoubleTap(at(1000, 300, 400), at(1200, 300 + DOUBLE_TAP_SLOP_PX, 400))).toBe(true);
    expect(isDoubleTap(at(1000, 300, 400), at(1200, 300 + DOUBLE_TAP_SLOP_PX + 1, 400))).toBe(
      false,
    );
    expect(isDoubleTap(at(1000, 300, 400), at(1200, 500, 700))).toBe(false);
  });

  it('rejects a second tap that came too late', () => {
    // Measured from the FIRST tap's release, not its press: a long first tap must not
    // eat the window a player can feel.
    const first = at(1000, 300, 400); // released at 1060
    expect(isDoubleTap(first, at(1060 + DOUBLE_TAP_MAX_MS, 300, 400))).toBe(true);
    expect(isDoubleTap(first, at(1060 + DOUBLE_TAP_MAX_MS + 1, 300, 400))).toBe(false);
  });

  it('rejects when either half was a drag rather than a tap', () => {
    const dragged: TouchSample = { downAt: 1000, upAt: 1060, from: { x: 300, y: 400 }, to: { x: 380, y: 400 } };
    expect(isDoubleTap(dragged, at(1200, 300, 400)), 'a drag then a tap').toBe(false);
    expect(isDoubleTap(at(1000, 300, 400), { ...at(1200, 300, 400), to: { x: 380, y: 400 } }), 'a tap then a drag').toBe(false);
  });

  it('has nothing to complete when there is no previous tap', () => {
    expect(isDoubleTap(null, at(1000, 300, 400))).toBe(false);
  });
});
