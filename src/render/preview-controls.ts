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
 * - **Four buttons under the canvas turn the hull and the turret**, with hold-to-repeat.
 *   Arrows rather than a slider: a slider is a linear control for a circular quantity,
 *   so it needs artificial endpoints, wraps badly at 0/360 and eats width in a 260px
 *   panel. They exist for three reasons, in order of weight. TOUCH: press-aim is
 *   imprecise on a canvas this small and there is no hover to fall back on.
 *   DISCOVERABILITY: the idle spin says "I am alive", not "you can drive me", and it
 *   stopped exactly when someone approached. ACCESSIBILITY: a real `<button>` is
 *   focusable and announced, where the canvas reads one label and then reports nothing
 *   as it turns.
 * - **Arrow keys turn the hull; Shift+Arrow turns the turret.** The panel is reachable
 *   by keyboard, so the preview must not be mouse-only. Left/Right and NOT Up/Down,
 *   for two reasons that survive scrutiny: Up/Down scroll the DOCUMENT, so swallowing
 *   them on a focused canvas takes page scrolling away from the keyboard user in order
 *   to spell a yaw with a key that does not mean yaw; and Left/Right already means
 *   "turn" here, since it is what the drag does. (An earlier version of this comment
 *   justified it by saying the Customize pane itself scrolls. It does not -- the only
 *   `overflow-y: auto` in hud.css is on the achievements list -- so that premise was
 *   wrong even though the conclusion holds.) Shift is the modifier because it reads as
 *   "the same rotation, other part"; it is the less guessable half of the scheme,
 *   which is why hud.css shows a hint the moment the canvas takes focus.
 * - **An idle spin** turns the whole tank slowly so it advertises that it is live
 *   before anything is touched, and stops at the first interaction -- a preview that
 *   keeps drifting under a player who is trying to look at one face is worse than one
 *   that never moved. It RESUMES, which it did not use to: immediately when a mouse
 *   leaves the canvas, and otherwise `IDLE_RESUME_DELAY_MS` after the last interaction
 *   ended (touch has no leave event, so the timer is what covers a phone). It never
 *   resumes while a pointer is still over the canvas, because a hovering mouse IS the
 *   aim. Suppressed entirely under `prefers-reduced-motion`.
 *
 *   **The spin is capped at one revolution** (`IDLE_SPIN_MAX_RAD`), which is a cost
 *   decision with a measurement behind it, not a taste one. Each drawn frame of it is a
 *   full `entities.sync` + `renderer.render`; on a box with no GPU (chromium under
 *   `--use-gl=swiftshader`, tools/gl/idle-cost.mjs) that costs ~32ms of renderer
 *   main-thread task time per frame, and the loop then runs flat out at ~31fps and
 *   saturates the thread: 9993ms of TaskDuration in 10.01s wall, against 1.7ms for the
 *   same preview with the spin suppressed and 75.3ms for a bare rAF loop that draws
 *   nothing. The JS half is negligible either way -- the rAF callback itself measures
 *   0.211ms mean / 0.6ms p95. So the expense is the DRAWING, and the only lever that
 *   bounds it on the machines where it is expensive is drawing fewer frames in total.
 *   A frame-rate cap was considered and rejected on the same numbers: capping at 30fps
 *   does nothing on a box that can only reach 31, and is unnecessary on a box with a
 *   GPU. One revolution shows every face of the model and then stops, which is the whole
 *   job of the spin. A resume starts a fresh revolution, so the bound is per
 *   interaction rather than absolute -- an untouched panel can no longer render forever,
 *   which is what auto-resume would otherwise have made permanent.
 *
 *   **It also stops while the document is hidden.** Browsers are widely understood to
 *   withhold rendering opportunities from a hidden document, which would make this
 *   redundant -- but it could NOT be verified here: headless chromium kept reporting
 *   `document.visibilityState === 'visible'` with another tab in front and kept firing
 *   frames (97 in 3000ms), so the measurement says nothing either way. An unverified
 *   assumption is not a reason to leave a self-restarting render loop unbounded.
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
 * How far one run of the idle spin turns before it stops on its own: exactly one
 * revolution, which at `IDLE_SPIN_RAD_PER_SEC` takes ~18s.
 *
 * A COST bound, argued from the measurement in this file's doc comment, not a feel
 * choice -- though one revolution happens to be the meaningful stopping point too,
 * since by then the model has been shown from every side and the tank is back at the
 * pose it started from.
 */
export const IDLE_SPIN_MAX_RAD = 2 * Math.PI;

/**
 * How long after an interaction ENDS the idle spin comes back, when nothing else has
 * brought it back first.
 *
 * FEEL, not measurement. Long enough that letting go of a drag for a moment does not
 * start the tank turning under the hand that was just on it; short enough that a phone
 * player who put the panel down sees it come alive again rather than assuming they
 * broke it. Desktop rarely waits this long: a mouse leaving the canvas resumes at once.
 */
export const IDLE_RESUME_DELAY_MS = 4000;

/**
 * How fast a held rotate button turns its part. ~92 deg/s: a full turn in about four
 * seconds, which is slow enough to stop where you meant to and fast enough that
 * bringing the far side round is not a chore.
 *
 * FEEL, not measurement, and pinned only through the constant -- `preview-controls.test.ts`
 * asserts the hold maths in terms of it.
 */
export const HOLD_RAD_PER_SEC = 1.6;

/**
 * How long a rotate button must be held before it starts repeating. Below this a press
 * is one `KEY_STEP_RAD` nudge and nothing more, which is what makes the same button
 * serve both "turn it a little" and "spin it round".
 */
export const HOLD_REPEAT_DELAY_MS = 300;

/** Which part of the tank a rotate button turns. */
export type RotatePart = 'hull' | 'turret';

/**
 * A rotate button, resolved from its markup. `dir` is +1 for the button that turns the
 * tank to the RIGHT on screen -- the same sign and the same direction as ArrowRight and
 * as a rightward drag, so the three schemes cannot disagree.
 */
export interface RotateButton {
  readonly el: HTMLElement;
  readonly part: RotatePart;
  readonly dir: 1 | -1;
}

/**
 * Read `data-rotate-part` / `data-rotate-dir` off the HUD's buttons.
 *
 * Anything it does not recognise is DROPPED rather than guessed at: a typo in the markup
 * leaves a button inert, which `hud.test.ts` catches by pinning the four attribute pairs
 * the pane ships. Guessing would leave a "turn turret left" button turning the hull.
 */
export function parseRotateButtons(els: Iterable<HTMLElement>): RotateButton[] {
  const out: RotateButton[] = [];
  for (const el of els) {
    const part = el.dataset.rotatePart;
    const dir = el.dataset.rotateDir;
    if (part !== 'hull' && part !== 'turret') continue;
    if (dir !== 'left' && dir !== 'right') continue;
    out.push({ el, part, dir: dir === 'right' ? 1 : -1 });
  }
  return out;
}

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
  // Defence in depth, and known to be redundant rather than assumed to be needed: an
  // unlaid-out canvas divides by zero, which gives an Infinity ndc, a NaN ray and a
  // missed plane, so the `!hit` return below already covers it. Measured -- deleting
  // this line leaves the whole test file green. It stays because "no layout box" is a
  // different fact about the world from "the ray went above the horizon", and reading
  // it off a NaN two functions later is not obvious to anyone.
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
  /** The HUD's four rotate buttons. Optional so every existing caller and test still
   * builds a working turntable without them -- the canvas schemes do not depend on
   * them. Parsed with `parseRotateButtons`, so an unrecognised one is inert, not wrong. */
  readonly rotateButtons?: Iterable<HTMLElement>;
  /** Injected so the resume delay can be driven exactly in a test rather than waited
   * out. Whatever schedules must be cancellable by `clearTimer`, and `dispose` cancels
   * it: a timer that outlives the panel is the new leak this feature could introduce. */
  readonly setTimer?: (cb: () => void, ms: number) => number;
  readonly clearTimer?: (handle: number) => void;
}

export interface PreviewControls {
  /** The live pose. The caller owns the rendering; this is the read-back. */
  pose(): PreviewPose;
  /** Whether the idle spin is turning the tank right now -- the same question
   * `wantsFrame()` asks of it, so it cannot drift from what the loop is doing. False
   * while the player is interacting, false once this run of the spin has used up
   * `IDLE_SPIN_MAX_RAD`, and false while the document is hidden. It comes back on its
   * own in the first two cases (see this file's doc comment) and on `visibilitychange`
   * in the third. */
  idleRunning(): boolean;
  /** Removes every listener it added, on the canvas AND on the rotate buttons AND on
   * the document, and cancels any pending frame and any pending resume timer. Safe
   * twice. */
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

/** A rotate button held down. `heldSec` accumulates across frames rather than being
 * differenced against a wall clock, so the repeat delay is measured in the same
 * (clamped) time the rotation itself is. */
interface Hold {
  readonly part: RotatePart;
  readonly dir: 1 | -1;
  heldSec: number;
}

export function createPreviewControls(
  canvas: HTMLCanvasElement,
  deps: PreviewControlsDeps,
): PreviewControls {
  const raf = deps.raf ?? ((cb: (t: number) => void) => window.requestAnimationFrame(cb));
  const cancelRaf = deps.cancelRaf ?? ((h: number) => window.cancelAnimationFrame(h));
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h: number) => window.clearTimeout(h));
  const buttons = parseRotateButtons(deps.rotateButtons ?? []);

  let bodyAngle = deps.initialPose.bodyAngle;
  let turretAngle = deps.initialPose.turretAngle;
  let lastBody = bodyAngle;
  let lastTurret = turretAngle;

  let drag: Drag | null = null;
  let idle = !deps.reducedMotion;
  /** Radians left in THIS run of the spin -- see IDLE_SPIN_MAX_RAD. */
  let idleBudget = IDLE_SPIN_MAX_RAD;
  let hold: Hold | null = null;
  let resumeTimer: number | null = null;
  /** A pointer is over the canvas. A hovering mouse IS the aim, so the spin must not
   * come back underneath it -- desktop's resume is `pointerleave`, not the timer. */
  let pointerInside = false;
  /** Set by the RELEASE of a rotate-button press, so the compatibility `click` that
   * follows it does not turn the tank a second time. See onButtonUp and onButtonClick. */
  let suppressClick = false;
  /** The pointer currently pressing a rotate button, so a release that belongs to some
   * other pointer cannot arm the suppression above. */
  let pressedPointerId: number | null = null;
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

  function hidden(): boolean {
    // Read live rather than cached at construction: the panel can be opened in a tab
    // that is already in the background.
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  /** Whether anything wants frames right now. THE one place that decides, so a held
   * button and the idle spin cannot each think the other owns the loop. */
  function wantsFrame(): boolean {
    if (disposed) return false;
    if (hold) return true;
    return idle && !hidden();
  }

  /** Bring the scheduled frame into line with `wantsFrame()`. Idempotent, so every
   * state change can just call it. */
  function syncFrame(): void {
    if (wantsFrame()) {
      if (frameHandle === null) frameHandle = raf(frame);
    } else {
      cancelFrame();
    }
  }

  function cancelResume(): void {
    if (resumeTimer === null) return;
    clearTimer(resumeTimer);
    resumeTimer = null;
  }

  /** An interaction has STARTED (or is continuing): the spin stops, and no resume is
   * pending while it lasts. */
  function stopIdle(): void {
    cancelResume();
    if (idle) {
      idle = false;
      syncFrame();
    }
  }

  function canResume(): boolean {
    return !disposed && !deps.reducedMotion && !drag && !hold && !pointerInside;
  }

  function resumeIdle(): void {
    cancelResume();
    if (idle || !canResume()) return;
    idle = true;
    // A fresh revolution, and a fresh clock: the gap since the last frame is not a gap
    // in the animation.
    idleBudget = IDLE_SPIN_MAX_RAD;
    lastFrameMs = null;
    syncFrame();
  }

  /** An interaction has ENDED. Deliberately NOT called from a hover: a mouse resting on
   * the canvas is still aiming, and desktop gets its resume from `pointerleave`. */
  function armResume(): void {
    cancelResume();
    if (disposed || deps.reducedMotion) return;
    resumeTimer = setTimer(() => {
      resumeTimer = null;
      resumeIdle();
    }, IDLE_RESUME_DELAY_MS);
  }

  function frame(nowMs: number): void {
    frameHandle = null;
    if (!wantsFrame()) return;
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
    if (hold) stepHold(dt);
    else stepIdleSpin(dt);
    emit();
    syncFrame();
  }

  function stepIdleSpin(dt: number): void {
    // Never overshoot the revolution: the last frame of a run turns by whatever is
    // left, so the spin stops at the pose it started from rather than a frame past it.
    const step = Math.min(IDLE_SPIN_RAD_PER_SEC * dt, idleBudget);
    idleBudget -= step;
    // Hull AND turret together: the idle spin is a turntable showing the whole model,
    // not a demonstration of independence -- that is what the controls are for.
    bodyAngle = normalizeAngle(bodyAngle + step);
    turretAngle = normalizeAngle(turretAngle + step);
    // One revolution done: stop, and wait for the next interaction to earn another.
    if (idleBudget <= 0) idle = false;
  }

  function stepHold(dt: number): void {
    if (!hold) return;
    hold.heldSec += dt;
    // The part of THIS frame that falls after the repeat delay -- so the ramp starts
    // exactly at HOLD_REPEAT_DELAY_MS however long the frames happen to be, rather than
    // at the first frame boundary past it.
    const active = Math.min(dt, hold.heldSec - HOLD_REPEAT_DELAY_MS / 1000);
    if (active <= 0) return;
    turn(hold.part, hold.dir, HOLD_RAD_PER_SEC * active);
  }

  /** Turn one part. `dir` +1 is rightward on screen, matching ArrowRight and a rightward
   * drag: entities.ts writes `rotation.y = -bodyAngle`, so a rightward turn SUBTRACTS. */
  function turn(part: RotatePart, dir: 1 | -1, rad: number): void {
    if (part === 'hull') bodyAngle = normalizeAngle(bodyAngle - dir * rad);
    else turretAngle = normalizeAngle(turretAngle - dir * rad);
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
    // Unconditional, and BEFORE the id check: a release is the end of an interaction
    // whether or not it ends a drag of ours -- including the release that ends a
    // press-to-aim tap, which arms no drag worth cancelling.
    armResume();
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Symmetric with the capture above: never had it, nothing to release.
    }
  };

  const onPointerEnter = (): void => {
    pointerInside = true;
  };

  /** Desktop's resume: the mouse has left the canvas, so nothing is being aimed and the
   * spin can come straight back. Restricted to a MOUSE on purpose -- a touch pointer
   * fires `pointerleave` the instant the finger lifts, which would resume the spin
   * before the player had taken their hand away. Touch waits out `armResume`. */
  const onPointerLeave = (e: PointerEvent): void => {
    pointerInside = false;
    if (e.pointerType === 'mouse') resumeIdle();
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
    // A key press has no release worth waiting for, so it is its own end: hold a key
    // down and the OS repeat keeps pushing the resume back one press at a time.
    armResume();
    emit();
  };

  /** One nudge, the same size an arrow key gives -- so a tap on a button and a tap on
   * the key that does the same thing move the tank by the same amount. */
  function nudge(b: RotateButton): void {
    stopIdle();
    turn(b.part, b.dir, KEY_STEP_RAD);
    emit();
  }

  const onButtonDown = (b: RotateButton, e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A new activation starts clean. Nothing here ARMS the suppression -- only the
    // release that a click can actually follow does, in onButtonUp.
    suppressClick = false;
    pressedPointerId = e.pointerId;
    nudge(b);
    hold = { part: b.part, dir: b.dir, heldSec: 0 };
    // The repeat delay is measured from the press, so the hold clock starts here rather
    // than inheriting whatever the idle spin last stamped -- without this, pressing a
    // button while the spin is running pre-loads `heldSec` with up to a whole clamped
    // frame and the ramp begins early. (Press-to-ramp is therefore HOLD_REPEAT_DELAY_MS
    // plus one frame: the frame that re-establishes the clock has dt 0 by design.)
    lastFrameMs = null;
    syncFrame();
  };

  /**
   * Every way a hold can end: release, cancel, or the pointer leaving the button --
   * which is how a real button behaves, and which is also what a lifted finger sends.
   * Called with no hold in progress it does nothing but re-arm the resume, which is
   * harmless and is what a release outside the button should do anyway.
   *
   * It is also the ONLY place `suppressClick` is armed, and only on a `pointerup` from
   * the pointer that pressed -- which is exactly the event a compatibility `click`
   * follows. Arming it at press time instead is the defect this shape exists to avoid:
   * a press that ends off the button sends no click, so the flag stuck on and swallowed
   * the NEXT bare click, killing the assistive-technology path the cluster exists for.
   */
  const onButtonUp = (e: PointerEvent): void => {
    hold = null;
    if (e.type === 'pointerleave') {
      // The hold is over, but the pointer may come back and release ON the button, and
      // that release does produce a click -- so the press is still live for the purpose
      // of suppression. Not cleared here, and cleared by the next press regardless.
    } else {
      suppressClick = e.type === 'pointerup' && pressedPointerId === e.pointerId;
      pressedPointerId = null;
    }
    syncFrame();
    armResume();
  };

  const onButtonKey = (b: RotateButton, e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // The browser would otherwise synthesise a click from this, turning the tank twice;
    // Space would also scroll the page. OS key repeat supplies the repeat, exactly as it
    // does for the canvas's own arrow keys.
    //
    // preventDefault is the WHOLE suppression on this path. Setting `suppressClick` here
    // as well is what broke it: no click ever arrives to consume the flag, so the next
    // bare click -- an assistive technology's -- was swallowed instead.
    e.preventDefault();
    nudge(b);
    armResume();
  };

  /** The fallback path, and the reason `onButtonUp` arms `suppressClick`: an assistive
   * technology can activate a button by dispatching `click` alone, with no pointer or
   * key event to be seen. Ignoring click entirely would leave those users with four dead
   * buttons; handling it unconditionally would double every mouse press. */
  const onButtonClick = (b: RotateButton): void => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    nudge(b);
    armResume();
  };

  /** Every listener this controller owns, as [target, type, fn], so dispose removes
   * exactly what was added -- including the per-button handlers, which are bound
   * closures and so cannot be re-derived at teardown. */
  const listeners: Array<[EventTarget, string, EventListener]> = [
    [canvas, 'pointerdown', onPointerDown as EventListener],
    [canvas, 'pointermove', onPointerMove as EventListener],
    [canvas, 'pointerup', onPointerEnd as EventListener],
    [canvas, 'pointercancel', onPointerEnd as EventListener],
    [canvas, 'pointerenter', onPointerEnter as EventListener],
    [canvas, 'pointerleave', onPointerLeave as EventListener],
    [canvas, 'keydown', onKeyDown as EventListener],
  ];
  for (const b of buttons) {
    listeners.push(
      [b.el, 'pointerdown', ((e: PointerEvent) => onButtonDown(b, e)) as EventListener],
      [b.el, 'pointerup', onButtonUp as EventListener],
      [b.el, 'pointercancel', onButtonUp as EventListener],
      [b.el, 'pointerleave', onButtonUp as EventListener],
      [b.el, 'keydown', ((e: KeyboardEvent) => onButtonKey(b, e)) as EventListener],
      [b.el, 'click', (() => onButtonClick(b)) as EventListener],
    );
  }
  // The spin must not run while the document is hidden -- see this file's doc comment
  // for why this is not left to the browser. Registered even under reduced motion: it
  // costs nothing and keeps the teardown symmetric.
  const onVisibility = (): void => {
    if (hidden()) cancelFrame();
    else {
      // A fresh clock, not merely a fresh frame. The time spent hidden is not time the
      // animation ran, and without this the first frame back differences against the
      // stamp from before the tab went away -- a clamped 0.1s jump, which is a visible
      // step at the moment the player looks at it again.
      lastFrameMs = null;
      syncFrame();
    }
  };
  if (typeof document !== 'undefined') {
    listeners.push([document, 'visibilitychange', onVisibility]);
  }
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn);

  syncFrame();

  return {
    pose(): PreviewPose {
      return { bodyAngle, turretAngle };
    },
    idleRunning(): boolean {
      // Deliberately the same expression the loop schedules on, rather than a second
      // one that agrees by inspection: this used to read `idle && !disposed`, which
      // said "running" for a hidden document that was drawing nothing, and its own doc
      // comment said otherwise. Review caught the contradiction.
      return idle && !disposed && !hidden();
    },
    dispose(): void {
      disposed = true;
      idle = false;
      hold = null;
      cancelFrame();
      cancelResume();
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    },
  };
}
