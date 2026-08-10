/**
 * The Customize preview's interaction layer: hull yaw and turret aim, driven by
 * pointer, keyboard and an idle spin.
 *
 * Kept OUT of preview.ts for exactly the reason framing.ts is kept out of scene.ts:
 * preview.ts constructs a `WebGLRenderer`, which vitest cannot do, so anything left
 * inside it can only ever be tested by eye or in the browser harness. Everything here
 * touches a `PerspectiveCamera`, a `DOMRect` and plain numbers -- all of which three
 * computes on the CPU -- so `preview-controls.test.ts` asserts the real angles against
 * the REAL production camera (`createPreviewCamera`, exported from preview.ts for that
 * purpose), not against a stand-in.
 *
 * THE CONTROL SCHEME, and why:
 *
 * - **Drag horizontally -> the HULL turns.** Turntable, the convention every model
 *   viewer uses, so it needs no teaching. Horizontal only: the camera's pitch is fixed
 *   by `fitCameraToArea`, and letting a vertical drag orbit it would fight the framing
 *   the preview exists to keep predictable.
 * - **The pointer aims the TURRET.** This is the part that makes the panel read like
 *   the game rather than like a model viewer: on desktop the game aims the turret at
 *   the mouse through `screenToGround`, and this unprojects the pointer onto the same
 *   y=0 ground plane in exactly the same way (see `groundPointFromPointer`, which
 *   mirrors renderer.ts's `screenToGround` line for line apart from its miss
 *   behaviour).
 * - **Touch has no hover**, so a non-mouse pointer aims the turret on each PRESS and
 *   then rotates the hull as it drags. Deliberately NOT "the turret follows the
 *   finger": glueing the aim to the finger would leave a touch player unable to turn
 *   the hull without dragging the gun round with it, which is the one thing this panel
 *   is meant to show can be done separately. Tap to aim, drag to turn.
 * - **Arrow keys turn the hull; Shift+Arrow turns the turret.** The panel is reachable
 *   by keyboard, so the preview must not be mouse-only. Left/Right and NOT Up/Down:
 *   the Customize pane scrolls vertically (`hud.css` gives it `touch-action: pan-y`
 *   for the same reason), and swallowing Up/Down on a focused canvas would take page
 *   scrolling away from the keyboard user to spell a yaw with a key that does not mean
 *   yaw. Shift is the modifier because it reads as "the same rotation, other part".
 * - **An idle spin** turns the whole tank slowly so it advertises that it is live
 *   before anything is touched, and stops PERMANENTLY at the first interaction --
 *   a preview that keeps drifting under a player who is trying to look at one face is
 *   worse than one that never moved. Suppressed entirely under
 *   `prefers-reduced-motion`.
 *
 * Both rotations are independent by construction: `bodyAngle` and `turretAngle` are
 * separate absolute world angles here, and the turret's is handed to the renderer
 * absolute, which is what `entities.ts` expects (it subtracts the body angle itself --
 * see the composition bug documented on `view.turret.rotation.y`, and the 8-case table
 * in entities.test.ts that pins it). A hull drag therefore leaves the gun pointing
 * where it was pointing, exactly as driving does in game.
 */
import * as THREE from 'three';

export interface PreviewPose {
  /** Hull heading, absolute world angle, sim convention (+x is 0, +y is +pi/2). */
  readonly bodyAngle: number;
  /** Gun heading, absolute world angle -- NOT relative to the hull. */
  readonly turretAngle: number;
}

/**
 * Radians of hull yaw per pixel of horizontal drag.
 *
 * FEEL, not measurement: 0.012 puts a little under a half-turn (~179 degrees) across
 * the 260px `.hud-preview` canvas, which is enough to bring any face round in one
 * comfortable drag without the tank spinning out from under a small movement. Nothing
 * pins the value; `preview-controls.test.ts` asserts the drag maths in terms of the
 * constant, so retuning it does not mean rewriting tests.
 */
export const HULL_DRAG_RAD_PER_PX = 0.012;

/** Radians per keydown for both the hull and the turret. 7.5 degrees: key repeat turns
 * a held arrow into a smooth spin, and a single press is still a visible nudge. */
export const KEY_STEP_RAD = Math.PI / 24;

/** Idle spin rate. ~18s for a full turn: present, but not something that pulls the eye
 * while the player is reading the swatches below. */
export const IDLE_SPIN_RAD_PER_SEC = 0.35;

/**
 * How close to the tank's own centre the unprojected pointer has to be before the aim
 * is IGNORED rather than followed, in world units.
 *
 * The turret angle is `atan2` of the ground point about the tank's origin, which is
 * undefined at the origin and wildly unstable just around it -- a pointer resting on
 * the hull would otherwise swing the gun through large angles for one pixel of
 * movement. 0.12 is a little over a tenth of the 1x1 hull, so the dead zone sits well
 * inside the model.
 */
export const TURRET_AIM_DEAD_RADIUS = 0.12;

/** Wrap to [-pi, pi) -- both ends map to -pi, which is the half-open convention this
 * expression falls out with and is measured in the tests rather than assumed. Keeps a
 * long drag or a held arrow from accumulating without bound, which nothing downstream
 * would notice but which makes every angle this module reports comparable. */
export function normalizeAngle(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

/** The subset of DOMRect this module needs -- so a test can hand it a plain object,
 * and so it is obvious that nothing else about the element is read. */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const _raycaster = new THREE.Raycaster();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();

/**
 * Unproject a client-space point onto the y=0 ground plane, in SIM coordinates.
 *
 * The same maths as renderer.ts's `screenToGround` -- ndc from the canvas rect, a ray
 * through the camera, intersect the ground, then three's (x, z) to sim's (x, y). The
 * one deliberate difference is the miss: the game falls back to the arena centre
 * because the aim has to be *somewhere*, while here a miss means "no answer" and the
 * caller keeps the turret where it was.
 *
 * A miss is reachable in production, not theoretical: `setPointerCapture` keeps
 * delivering pointermove while a drag runs OFF the canvas, and far enough above the
 * canvas the ray passes above the horizon and never meets the plane.
 *
 * `updateMatrixWorld` is not optional here. preview.ts renders through its own
 * renderer, which updates the camera as a side effect of drawing, but the first
 * pointer event can arrive before any draw has moved it.
 */
export function groundPointFromPointer(
  camera: THREE.PerspectiveCamera,
  rect: RectLike,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (rect.width === 0 || rect.height === 0) return null;
  _ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  camera.updateMatrixWorld();
  _raycaster.setFromCamera(_ndc, camera);
  const hit = _raycaster.ray.intersectPlane(_groundPlane, _hit);
  if (!hit) return null;
  // three (x, z) -> sim (x, y), exactly as screenToGround does.
  return { x: _hit.x, y: _hit.z };
}

/**
 * The turret heading that aims at `clientX/clientY`, or null when there is no sensible
 * answer -- the ray missed the ground plane, the canvas has no layout box, or the
 * point landed inside `TURRET_AIM_DEAD_RADIUS` of the tank itself. Null means "leave
 * the turret alone", never "aim at zero".
 */
export function turretAngleFromPointer(
  camera: THREE.PerspectiveCamera,
  rect: RectLike,
  clientX: number,
  clientY: number,
): number | null {
  const p = groundPointFromPointer(camera, rect, clientX, clientY);
  if (!p) return null;
  if (Math.hypot(p.x, p.y) < TURRET_AIM_DEAD_RADIUS) return null;
  return Math.atan2(p.y, p.x);
}

export interface PreviewControlsDeps {
  /** The camera the preview draws through -- the pointer is unprojected through THIS,
   * so a re-fit on resize is picked up with no further wiring. */
  readonly camera: THREE.PerspectiveCamera;
  readonly initialPose: PreviewPose;
  /** Called only when the pose ACTUALLY changes, so the caller can treat it as a
   * redraw request without filtering. */
  readonly onPose: (pose: PreviewPose) => void;
  /** True to suppress the idle spin entirely. preview.ts passes
   * `prefers-reduced-motion`; injected rather than read here so a test can drive both
   * branches without touching matchMedia. */
  readonly reducedMotion?: boolean;
  readonly raf?: (cb: (t: number) => void) => number;
  readonly cancelRaf?: (handle: number) => void;
}

export interface PreviewControls {
  /** The live pose. The caller owns the rendering; this is the read-back. */
  pose(): PreviewPose;
  /** False once the player has touched the preview -- the idle spin is over for the
   * life of this controller. */
  idleRunning(): boolean;
  /** Removes every listener it added and cancels any pending frame. Safe twice. */
  dispose(): void;
}

/** The drag in progress. `aims` is fixed at press time from the pointer type: a mouse
 * keeps aiming the turret as it moves (it is the same hover-aim the game uses), a
 * finger does not (see this file's doc comment). */
interface Drag {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startBodyAngle: number;
  readonly aims: boolean;
}

export function createPreviewControls(
  canvas: HTMLCanvasElement,
  deps: PreviewControlsDeps,
): PreviewControls {
  const raf = deps.raf ?? ((cb: (t: number) => void) => window.requestAnimationFrame(cb));
  const cancelRaf = deps.cancelRaf ?? ((h: number) => window.cancelAnimationFrame(h));

  let bodyAngle = deps.initialPose.bodyAngle;
  let turretAngle = deps.initialPose.turretAngle;
  let lastBody = bodyAngle;
  let lastTurret = turretAngle;

  let drag: Drag | null = null;
  let idle = !deps.reducedMotion;
  let frameHandle: number | null = null;
  let lastFrameMs: number | null = null;
  let disposed = false;

  function emit(): void {
    if (bodyAngle === lastBody && turretAngle === lastTurret) return;
    lastBody = bodyAngle;
    lastTurret = turretAngle;
    deps.onPose({ bodyAngle, turretAngle });
  }

  function cancelFrame(): void {
    if (frameHandle === null) return;
    cancelRaf(frameHandle);
    frameHandle = null;
  }

  /** The first interaction ends the idle spin for good. Not a pause: a preview that
   * resumes drifting a moment after the player stops moving is the behaviour this is
   * written to avoid. */
  function stopIdle(): void {
    if (!idle) return;
    idle = false;
    cancelFrame();
  }

  function frame(nowMs: number): void {
    frameHandle = null;
    if (disposed || !idle) return;
    // The first frame has no previous timestamp to difference against, and a tab
    // restored from the background hands back a huge one -- clamped so neither
    // teleports the tank.
    const dt = lastFrameMs === null ? 0 : Math.min((nowMs - lastFrameMs) / 1000, 0.1);
    lastFrameMs = nowMs;
    if (dt === 0) {
      // Nothing moved, so nothing is repainted -- and, less obviously, `normalizeAngle`
      // is not run over an unchanged angle, which would perturb it in the last bits and
      // make a redraw out of a frame that had no reason to draw.
      frameHandle = raf(frame);
      return;
    }
    const step = IDLE_SPIN_RAD_PER_SEC * dt;
    // Hull AND turret together: the idle spin is a turntable showing the whole model,
    // not a demonstration of independence -- that is what the controls are for.
    bodyAngle = normalizeAngle(bodyAngle + step);
    turretAngle = normalizeAngle(turretAngle + step);
    emit();
    frameHandle = raf(frame);
  }

  function aimAt(clientX: number, clientY: number): void {
    const a = turretAngleFromPointer(deps.camera, canvas.getBoundingClientRect(), clientX, clientY);
    if (a === null) return;
    turretAngle = a;
  }

  const onPointerDown = (e: PointerEvent): void => {
    // Secondary mouse buttons belong to the browser's own menu, not to the turntable.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopIdle();
    drag = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startBodyAngle: bodyAngle,
      aims: e.pointerType === 'mouse',
    };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Not every environment implements pointer capture (jsdom does not for an id it
      // never saw arrive). Losing it costs a drag that leaves the canvas, not the
      // feature, so it must not take the press down with it.
    }
    // preventDefault below suppresses the implicit focus, and the keyboard scheme is
    // worth nothing if clicking the preview does not focus it.
    canvas.focus();
    // A drag on a canvas is otherwise a text selection on desktop; touch is already
    // handled by `touch-action: none` in hud.css.
    e.preventDefault();
    aimAt(e.clientX, e.clientY);
    emit();
  };

  const onPointerMove = (e: PointerEvent): void => {
    stopIdle();
    if (drag && drag.pointerId === e.pointerId) {
      // Drag RIGHT turns the near face of the tank to the right, which is what a
      // turntable does. entities.ts writes `rotation.y = -bodyAngle` and the camera
      // sits on +z (framing.ts's VIEW_DIR), so the near surface follows +x as
      // rotation.y grows -- hence bodyAngle falls as the drag moves right.
      const dx = e.clientX - drag.startClientX;
      bodyAngle = normalizeAngle(drag.startBodyAngle - dx * HULL_DRAG_RAD_PER_PX);
      if (drag.aims) aimAt(e.clientX, e.clientY);
    } else if (e.pointerType === 'mouse') {
      // Hover: the desktop game's aim, unchanged.
      aimAt(e.clientX, e.clientY);
    }
    emit();
  };

  const onPointerEnd = (e: PointerEvent): void => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Symmetric with the capture above: never had it, nothing to release.
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (dir === 0) return;
    stopIdle();
    // Same sign as the drag: ArrowRight turns the near face right.
    if (e.shiftKey) turretAngle = normalizeAngle(turretAngle - dir * KEY_STEP_RAD);
    else bodyAngle = normalizeAngle(bodyAngle - dir * KEY_STEP_RAD);
    // Arrow keys otherwise scroll the Customize pane out from under the control that
    // is using them, AND reach input.ts's window-level keydown, which drives the tank.
    e.preventDefault();
    e.stopPropagation();
    emit();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('keydown', onKeyDown);

  if (idle) frameHandle = raf(frame);

  return {
    pose(): PreviewPose {
      return { bodyAngle, turretAngle };
    },
    idleRunning(): boolean {
      return idle && !disposed;
    },
    dispose(): void {
      disposed = true;
      idle = false;
      cancelFrame();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerEnd);
      canvas.removeEventListener('pointercancel', onPointerEnd);
      canvas.removeEventListener('keydown', onKeyDown);
    },
  };
}
