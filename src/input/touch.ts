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
 * Which half of the viewport a touch landed in.
 *
 * The split is the whole control scheme: left thumb drives, right thumb aims and fires.
 * Taking `width` rather than reading `window.innerWidth` keeps this testable and makes
 * the caller responsible for orientation changes.
 */
export function touchSide(clientX: number, width: number): 'move' | 'aim' {
  return clientX < width / 2 ? 'move' : 'aim';
}
