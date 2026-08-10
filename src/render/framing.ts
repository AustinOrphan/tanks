import * as THREE from 'three';

/**
 * Camera framing maths, kept OUT of scene.ts on purpose.
 *
 * scene.ts constructs a WebGLRenderer, which needs a real GL context and so
 * cannot be built under vitest -- which is why it had no test file and why the
 * framing was never checked by anything but eye. Everything here touches only a
 * PerspectiveCamera and plain vectors, both of which Three computes on the CPU,
 * so `framing.test.ts` can assert what is actually on screen.
 */

/**
 * What the camera must always contain: the playable area PLUS the ring of
 * boundary walls `loadArena` puts one cell OUTSIDE it.
 *
 * Sizing anything to the playable area alone leaves the walls hanging over the
 * clear colour; sizing it larger than this leaves a strip of ground visible
 * beyond the walls, which reads as a detached sliver of felt floating below the
 * arena. The shipped build had exactly that: a 10% margin (2.2 units) against a
 * boundary ring 2.0 thick, overhanging by 0.2 on every side.
 */
export function framedBounds(
  worldWidth: number,
  worldHeight: number,
  boundary: number,
): { width: number; height: number } {
  return { width: worldWidth + boundary * 2, height: worldHeight + boundary * 2 };
}

/** Camera offset direction from its target. ~51 degrees above the ground plane. */
export const VIEW_DIR = new THREE.Vector3(0, 1.05, 0.85).normalize();

/**
 * Fraction of the half-viewport left empty around the framed area. Small, because
 * this is a fixed camera with no scrolling: slack here is dead screen for the
 * whole game. The HUD is drawn over the canvas in its corners, so a little is
 * still wanted.
 *
 * 0.06 -> 0.03: the margin is charged on BOTH sides of BOTH axes, so 0.06 was
 * spending 12% of the frame's width and height -- about 11% of its area -- on empty
 * felt. 0.03 still clears the HUD's top strip: measured at 16:9 the board's top edge
 * sits below the "Lives / Enemies / Level" line, which is what the margin is for.
 */
export const FRAME_MARGIN = 0.03;

const _corner = new THREE.Vector3();

/**
 * True when every corner of the `width` x `height` rect centred on `target` (on
 * the ground plane) projects inside the viewport, leaving `margin` of the
 * half-extent clear on each side.
 *
 * The camera must already have its matrices updated for the current position.
 */
export function framedAreaFits(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  width: number,
  height: number,
  margin: number,
): boolean {
  const hw = width / 2;
  const hh = height / 2;
  const limit = 1 - margin;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      _corner.set(target.x + sx * hw, 0, target.z + sz * hh).project(camera);
      if (Math.abs(_corner.x) > limit || Math.abs(_corner.y) > limit) return false;
    }
  }
  return true;
}

/**
 * Place the camera along VIEW_DIR at the CLOSEST distance that still contains the
 * whole framed area. Mutates the camera's position and matrices.
 *
 * Solved numerically rather than in closed form: with a tilted camera the ground
 * rect projects to a trapezium whose worst corner swaps between the near and far
 * pair depending on aspect, and "fits" is monotonic in distance, so a bisection
 * is both shorter and harder to get subtly wrong than the trigonometry.
 *
 * Fitting DISTANCE rather than widening the fov is what keeps the arena large.
 * The previous code held distance fixed at a hand-picked multiple of the arena
 * span and widened the fov on narrow viewports; the multiple left ~35% of the
 * vertical frustum unused at 16:10, which is why the board looked small. The fit
 * brings that residual down to ~26% on the same rect.
 */
export function fitCameraToArea(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  width: number,
  height: number,
  margin: number = FRAME_MARGIN,
): void {
  const span = Math.max(width, height);
  let lo = span * 0.05; // certainly too close to contain it
  // Far enough for every viewport the game is played at, but NOT validated: below
  // about aspect 0.249 nothing in the bracket fits, and the fallback below returns a
  // camera that crops the board. That floor MOVED with the long lens -- it was 0.147
  // at fov 50 / margin 0.06 -- because a narrower lens needs more distance and runs
  // out of bracket sooner. Both figures bisected against this function; the 0.147
  // reproduces the number this comment carried before, which is what says the probe
  // is measuring the right thing. Still far below any real window: 0.249 is a
  // ~500px-wide viewport on a 2160-tall portrait panel.
  let hi = span * 8;

  const place = (d: number): void => {
    camera.position.copy(target).addScaledVector(VIEW_DIR, d);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
  };

  // 40 halvings takes the bracket to well under a millionth of a unit.
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    place(mid);
    if (framedAreaFits(camera, target, width, height, margin)) hi = mid;
    else lo = mid;
  }
  // hi is the last distance known to fit -- unless no midpoint ever fit, in which
  // case hi is still the untested initial bracket and this camera crops.
  place(hi);
}
