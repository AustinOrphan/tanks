import type { Vec2 } from '../sim/types';

/**
 * The virtual thumbstick's maths, kept pure so it can be tested without a DOM.
 *
 * The stick is FLOATING, not fixed: it appears wherever the thumb lands rather than at a
 * painted spot on the screen. A fixed stick has to be found by eye before the round can
 * start, and on a phone the thumb is already resting somewhere by the time the player
 * looks down.
 */

/**
 * How far (CSS px) the thumb must travel from where it landed before the tank moves at
 * full speed. Feel, not measurement -- deliberately small, because the sim takes a
 * direction and a magnitude, and a long throw makes a tank that turns like a truck.
 */
export const STICK_RADIUS_PX = 56;

/**
 * Travel under which the stick reads as "no input at all".
 *
 * Not decoration: a thumb resting on glass drifts by a pixel or two, and without this a
 * player who is only aiming would find the tank creeping. Expressed as a fraction of the
 * radius so retuning the radius does not silently retune the dead zone with it.
 */
export const STICK_DEADZONE = 0.18;

/**
 * The move vector for a thumb that landed at `origin` and is now at `current`.
 *
 * Returns sim-space, which is NOT screen space: the sim's +y is SOUTH on screen (the
 * render maps world y to three's z with the camera at +z looking back), so a thumb pushed
 * UP the screen must produce a NEGATIVE y. This is the same inversion `readMove` applies
 * to W, and getting it backwards drove the tank away from the thumb.
 *
 * The magnitude is clamped to 1 and rescaled so the dead zone does not cost range: at
 * exactly the dead-zone edge the tank is stationary, and at `STICK_RADIUS_PX` it is at
 * full speed, with the span between mapped smoothly rather than jumping to 0.18.
 */
export function stickVector(origin: Vec2, current: Vec2, radius = STICK_RADIUS_PX): Vec2 {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { x: 0, y: 0 };

  const throwFraction = Math.min(1, dist / radius);
  if (throwFraction <= STICK_DEADZONE) return { x: 0, y: 0 };

  // Rescale (deadzone..1] onto (0..1] so the first movement past the dead zone is a
  // crawl rather than a lurch to 18% speed.
  const magnitude = (throwFraction - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  return { x: (dx / dist) * magnitude, y: (dy / dist) * magnitude };
}

/**
 * Where the player's thumbs are, in CLIENT pixels, for drawing them back on screen.
 *
 * Deliberately NOT part of `InputState`. The sim consumes InputState and replays are
 * exact functions of it, so screen-space pixels must never enter that shape. This lives
 * here, beside the stick maths, so the input layer and the HUD share one definition
 * rather than each describing the thumbs their own way.
 */
export interface TouchIndicator {
  /** The driving thumb: where it landed, and where it is now. */
  stick: { originX: number; originY: number; x: number; y: number } | null;
  /**
   * The aiming thumb. Under `point` this is the spot the turret is being sent to; under
   * `stick` it is a second thumbstick, and `origin` is where it landed.
   */
  aim: { originX: number; originY: number; x: number; y: number } | null;
  /** Which scheme is live, so the HUD draws a crosshair or a second stick. */
  scheme: TouchScheme;
  /** True once any touch has been seen, so touch-only affordances can appear on demand. */
  used: boolean;
}

/**
 * How the right thumb expresses aim.
 *
 * NEITHER scheme fires. That is the point of having them at all: aiming and firing used
 * to be one gesture, so re-aiming while the turret faced a nearby wall put a shell into
 * it -- and with ricochets and friendly fire, into the player's own tank. Firing is a
 * separate deliberate button in both.
 *
 * - `point`: the turret is sent to the world spot under the thumb. Precise for picking a
 *   target, but the fingertip covers the very thing it is choosing.
 * - `stick`: a second floating thumbstick; the turret faces the direction it is pushed.
 *   Nothing is occluded, and it expresses an ANGLE -- which is what this game is
 *   actually played in, since shells are banked off walls rather than aimed at tanks.
 */
export type TouchScheme = 'point' | 'stick';

export const TOUCH_SCHEMES: readonly TouchScheme[] = ['stick', 'point'];

/**
 * How far in front of the tank the aim stick projects its target point.
 *
 * `InputState.aim` is a world POINT, so a direction has to become one. Only the
 * DIRECTION of the offset matters -- the turret slews toward the point either way -- so
 * this just needs to be far enough that floating-point noise near the tank cannot swing
 * the angle. Well beyond any arena's diagonal.
 */
export const AIM_PROJECTION_UNITS = 100;

/**
 * How the right thumb pulls the trigger.
 *
 * The FIRE button exists in every mode -- these ADD a gesture, they never replace it.
 * That is deliberate: a gesture can be missed or mistimed, and a game with a shell cap
 * and friendly-fire ricochets needs one way to shoot that cannot be ambiguous.
 *
 * - `button`: the button alone. Nothing on the aim side ever fires.
 * - `tap`: a tap on the aim side fires. Instant and unambiguous UNDER `stick`, where a
 *   tap has no aiming meaning because the stick only aims while dragged. Under `point`
 *   a tap IS the aim gesture, so this combination reproduces the original defect --
 *   re-aiming at a wall shoots into it. Offered anyway, because it is the crispest
 *   option on the default scheme and the pairing is the player's to make.
 * - `double`: two taps in the same place fire. Safe under BOTH schemes, because a
 *   re-aim is a single tap somewhere new and cannot accumulate into a shot.
 */
export type FireMode = 'button' | 'tap' | 'double';

export const FIRE_MODES: readonly FireMode[] = ['tap', 'double', 'button'];

/**
 * Longest a touch can last and still count as a tap rather than a drag. A thumb placed
 * to aim and held rests far longer than this.
 *
 * FEEL, not measurement, and it fails CLOSED on purpose: a tap that misses the window
 * simply does not fire, and the FIRE button is always there. The opposite failure -- a
 * deliberate aim-hold read as a shot -- is the defect this whole scheme rework exists to
 * remove, so the window stays tight.
 *
 * Known residual, measured rather than assumed: the timestamps come from
 * `performance.now()` when the main thread HANDLES the event, not when the finger moved.
 * Probing the shipped bundle, a 90ms scripted tap was seen as 205ms under load -- inside
 * the window, but not by much. On a busier device a real tap could exceed it and quietly
 * do nothing. If that shows up in play, raise this before reaching for anything cleverer;
 * under `stick` a stationary touch has no aiming meaning, so a longer window is cheap
 * there. Under `point` it is not, because a hold IS the aim.
 */
export const TAP_MAX_MS = 250;

/** How far a touch may wander and still be a tap. Fingers are not styluses. */
export const TAP_SLOP_PX = 12;

/** Longest gap between two taps for the second to complete a double. */
export const DOUBLE_TAP_MAX_MS = 300;

/**
 * How far apart two taps may land and still be one double-tap.
 *
 * THE LOAD-BEARING HALF of double-tap detection, and the reason it is safe where a
 * single tap is not. Two quick taps in the SAME place mean "fire". Two quick taps in
 * DIFFERENT places mean someone is re-aiming -- and reading that as a shot is exactly
 * the defect this whole scheme rework exists to remove. Time alone cannot tell them
 * apart.
 */
export const DOUBLE_TAP_SLOP_PX = 40;

/** A completed touch, as the tap detectors need to see it. */
export interface TouchSample {
  /** performance.now() at pointerdown / pointerup. */
  downAt: number;
  upAt: number;
  from: Vec2;
  to: Vec2;
}

/** True if this touch was a tap -- brief, and it stayed put. */
export function isTap(t: TouchSample): boolean {
  if (t.upAt - t.downAt > TAP_MAX_MS) return false;
  return Math.hypot(t.to.x - t.from.x, t.to.y - t.from.y) <= TAP_SLOP_PX;
}

/**
 * True if `now` completes a double-tap begun by `previous`.
 *
 * Measured from the previous tap's RELEASE to this one's PRESS: the gap a player feels
 * is between the taps, not between their starts, and timing from the starts would let a
 * long first tap eat the whole window.
 */
export function isDoubleTap(previous: TouchSample | null, now: TouchSample): boolean {
  if (previous === null || !isTap(previous) || !isTap(now)) return false;
  if (now.downAt - previous.upAt > DOUBLE_TAP_MAX_MS) return false;
  return Math.hypot(now.from.x - previous.from.x, now.from.y - previous.from.y) <=
    DOUBLE_TAP_SLOP_PX;
}

/**
 * Which half of the viewport a touch landed in.
 *
 * The split is the whole control scheme: left thumb drives, right thumb aims and fires.
 * Taking `width` rather than reading `window.innerWidth` keeps this testable and makes
 * the caller responsible for orientation changes.
 */
export function touchSide(clientX: number, width: number): 'move' | 'aim' {
  return clientX < width / 2 ? 'move' : 'aim';
}
