// @vitest-environment jsdom
//
// The Customize preview's interaction layer, tested against the REAL production camera
// (`createPreviewCamera`, the one `createTankPreview` draws through) rather than a
// stand-in built to look like it -- a stand-in would keep passing after FOV or
// PREVIEW_AREA_W moved and left the real aim pointing somewhere else.
//
// No WebGL is needed for any of this: a PerspectiveCamera, a raycaster and a DOMRect
// are all CPU maths. That is the whole reason preview-controls.ts is a separate file
// from preview.ts, which builds a WebGLRenderer and so can only be exercised in
// tools/gl/harness.ts.
import { describe, it, expect, vi } from 'vitest';
import {
  createPreviewControls,
  groundPointFromPointer,
  turretAngleFromPointer,
  normalizeAngle,
  HULL_DRAG_RAD_PER_PX,
  KEY_STEP_RAD,
  IDLE_SPIN_RAD_PER_SEC,
  TURRET_AIM_DEAD_RADIUS,
  type PreviewPose,
} from './preview-controls';
import { createPreviewCamera, INITIAL_PREVIEW_POSE } from './preview';
import * as THREE from 'three';

/** The shipped `.hud-preview` box (hud.css), placed at a NON-zero page offset on
 * purpose: a rect whose left/top are 0 cannot tell "subtracts the offset" from
 * "ignores the offset". */
const RECT = { left: 100, top: 50, width: 260, height: 190 };
const CX = RECT.left + RECT.width / 2;
const CY = RECT.top + RECT.height / 2;

const camera = createPreviewCamera(RECT.width / RECT.height);

function makeCanvas(rect = RECT): HTMLCanvasElement {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  // jsdom has no layout, so getBoundingClientRect is all zeros -- which the production
  // code correctly reads as "no layout box" and refuses to aim through. Supplying the
  // shipped box is what lets these assertions be about the maths.
  c.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }) as DOMRect;
  return c;
}

/** jsdom ships no PointerEvent constructor, so the pointer fields are attached to a
 * real MouseEvent. `bubbles` is real and load-bearing: the stopPropagation checks
 * below listen on `window`. */
function pointerEvent(
  type: string,
  opts: {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    pointerType?: string;
    button?: number;
  } = {},
): PointerEvent {
  const e = new MouseEvent(type, {
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    button: opts.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, 'pointerId', { value: opts.pointerId ?? 1 });
  Object.defineProperty(e, 'pointerType', { value: opts.pointerType ?? 'mouse' });
  return e as unknown as PointerEvent;
}

interface Harness {
  canvas: HTMLCanvasElement;
  controls: ReturnType<typeof createPreviewControls>;
  poses: PreviewPose[];
  animates: Array<{ dt: number; pose: PreviewPose }>;
  frames: Array<(t: number) => void>;
  cancelled: number[];
}

function harness(opts: { reducedMotion?: boolean; rect?: typeof RECT } = {}): Harness {
  const canvas = makeCanvas(opts.rect);
  const poses: PreviewPose[] = [];
  const animates: Array<{ dt: number; pose: PreviewPose }> = [];
  const frames: Array<(t: number) => void> = [];
  const cancelled: number[] = [];
  const controls = createPreviewControls(canvas, {
    camera,
    initialPose: INITIAL_PREVIEW_POSE,
    reducedMotion: opts.reducedMotion,
    onPose: (p) => poses.push(p),
    onAnimate: (dt, pose) => animates.push({ dt, pose }),
    raf: (cb) => {
      frames.push(cb);
      return frames.length; // 1-based, so 0 is never a valid handle
    },
    cancelRaf: (h) => cancelled.push(h),
  });
  return { canvas, controls, poses, animates, frames, cancelled };
}

describe('normalizeAngle', () => {
  it('wraps into [-pi, pi)', () => {
    // Half-open at -pi: both ends of the turn come back as -pi. Measured, not chosen --
    // nothing downstream distinguishes the two, and stating the range the expression
    // actually has is worth more than asserting the one that reads nicer.
    expect(normalizeAngle(0)).toBeCloseTo(0, 12);
    expect(normalizeAngle(Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(normalizeAngle(-Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(normalizeAngle(2 * Math.PI + 0.5)).toBeCloseTo(0.5, 12);
    expect(normalizeAngle(-2 * Math.PI - 0.5)).toBeCloseTo(-0.5, 12);
  });

  it('keeps the wrapped angle pointing the same way, over a full sweep', () => {
    // Population: 801 angles, -40..+40 radians in 0.1 steps -- about six and a half
    // turns each way, which is more than any drag or held arrow accumulates.
    // Deletion of the wrap leaves this passing (an unwrapped angle points the same
    // way); it is the RANGE assertion that dies. Both are here on purpose.
    let worstRange = 0;
    for (let i = -400; i <= 400; i++) {
      const a = i * 0.1;
      const n = normalizeAngle(a);
      expect(Math.cos(n)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(n)).toBeCloseTo(Math.sin(a), 9);
      worstRange = Math.max(worstRange, Math.abs(n));
    }
    expect(worstRange).toBeLessThanOrEqual(Math.PI + 1e-12);
  });
});

describe('groundPointFromPointer: the same unprojection the game aims through', () => {
  it('maps the canvas centre to the tank itself', () => {
    // The preview frames the tank on the origin (fitCameraToArea's target), so the
    // centre pixel IS the tank. Fails if the ndc maths drops the rect offset: the
    // centre would then unproject to somewhere off the model.
    const p = groundPointFromPointer(camera, RECT, CX, CY);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(0, 6);
    expect(p!.y).toBeCloseTo(0, 6);
  });

  it('subtracts the canvas page offset', () => {
    // The SAME client point against two rects that differ only in origin must give
    // two different ground points -- and each rect's own centre must give the origin.
    const shifted = { ...RECT, left: RECT.left + 300, top: RECT.top + 200 };
    const here = groundPointFromPointer(camera, RECT, CX, CY)!;
    const there = groundPointFromPointer(camera, shifted, CX, CY)!;
    expect(Math.hypot(there.x - here.x, there.y - here.y)).toBeGreaterThan(0.5);
    const thereCentre = groundPointFromPointer(
      camera,
      shifted,
      shifted.left + shifted.width / 2,
      shifted.top + shifted.height / 2,
    )!;
    expect(thereCentre.x).toBeCloseTo(0, 6);
    expect(thereCentre.y).toBeCloseTo(0, 6);
  });

  it('does not swap the ground axes', () => {
    // three (x, z) -> sim (x, y). Screen-right is +x and screen-DOWN is +y in sim
    // terms, because the camera looks down the +z side of the board (framing.ts's
    // VIEW_DIR). Returning {x: hit.z, y: hit.x} instead flips both of these.
    const right = groundPointFromPointer(camera, RECT, CX + 60, CY)!;
    expect(right.x).toBeGreaterThan(0.2);
    expect(right.y).toBeCloseTo(0, 6);
    const down = groundPointFromPointer(camera, RECT, CX, CY + 60)!;
    expect(down.y).toBeGreaterThan(0.2);
    expect(down.x).toBeCloseTo(0, 6);
  });

  it('works against a camera whose world matrix has not been flushed', () => {
    // The reason `updateMatrixWorld` is in the function rather than assumed of the
    // caller. `lookAt` writes the quaternion and leaves matrixWorld stale, and the
    // first pointer event can land before any render has flushed it. Removing that
    // one line makes this case unproject through an identity matrix and miss by
    // more than a whole tank.
    const stale = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.05, 100);
    stale.position.copy(camera.position);
    stale.lookAt(0, 0, 0);
    stale.updateProjectionMatrix();
    const p = groundPointFromPointer(stale, RECT, CX, CY);
    expect(p).not.toBeNull();
    expect(Math.hypot(p!.x, p!.y)).toBeLessThan(0.01);
  });

  it('returns null when the canvas has no layout box', () => {
    // A hidden or unlaid-out canvas -- which is what jsdom reports for EVERY element,
    // and what the panel's canvas reports before its first layout.
    //
    // State what this does and does not pin. Deleting the explicit `rect.width === 0`
    // guard leaves it GREEN (measured): dividing by zero gives an Infinity ndc, which
    // makes a NaN ray, which misses the plane, which is already null. So this is not a
    // guard-coverage check. What it pins is the CONTRACT -- no answer means null,
    // never a fallback point -- and that does fail: making the miss return {0, 0} the
    // way renderer.ts's screenToGround returns the arena centre kills the horizon case
    // below, and kills this one too once the redundant guard goes with it.
    expect(groundPointFromPointer(camera, { left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toBeNull();
  });

  it('returns null when the ray passes above the horizon', () => {
    // Reachable in production, not decorative: setPointerCapture keeps delivering
    // pointermove while a drag runs off the top of the canvas. The camera sits about
    // 51 degrees above the ground with a 50-degree lens, so the horizon is roughly
    // 0.8 canvas-heights above the top edge; -400 is comfortably past it.
    //
    // This is the case that fails if the miss ever grows a fallback point.
    expect(groundPointFromPointer(camera, RECT, CX, RECT.top - 400)).toBeNull();
  });
});

describe('turretAngleFromPointer', () => {
  it('aims at the pointer in sim angle convention', () => {
    // +x is 0, +y (screen-down) is +pi/2 -- the same convention Tank.turretAngle uses.
    //
    // Compared as a DIRECTION, not as a number, and the pi case is why: the left-of-
    // centre point sits on the x axis, so its z is a float residual whose SIGN decides
    // whether atan2 answers +pi or -pi. An earlier draft asserted `toBeCloseTo(PI)` and
    // passed only because the residual happened to come out positive at this camera
    // distance -- moving the camera flipped it to -pi and failed the case for a reason
    // that had nothing to do with what the case is about. entities.test.ts compares
    // cos/sin for exactly this hazard; so does this now.
    const aims = (dx: number, dy: number, expected: number): void => {
      const a = turretAngleFromPointer(camera, RECT, CX + dx, CY + dy)!;
      expect(Math.cos(a)).toBeCloseTo(Math.cos(expected), 4);
      expect(Math.sin(a)).toBeCloseTo(Math.sin(expected), 4);
    };
    aims(80, 0, 0);
    aims(-80, 0, Math.PI);
    aims(0, 60, Math.PI / 2);
    aims(0, -60, -Math.PI / 2);
  });

  it('refuses to aim inside the dead radius, at exactly the radius the constant names', () => {
    // Swept along the centre row, population: offsets 0..40px right of centre in 1px
    // steps. The first offset that answers must be the first that clears
    // TURRET_AIM_DEAD_RADIUS in world units, and the one before it must not.
    let first = -1;
    for (let dx = 0; dx <= 40; dx++) {
      if (turretAngleFromPointer(camera, RECT, CX + dx, CY) !== null) {
        first = dx;
        break;
      }
    }
    expect(first).toBeGreaterThan(0); // dead centre must NOT answer
    const at = groundPointFromPointer(camera, RECT, CX + first, CY)!;
    const before = groundPointFromPointer(camera, RECT, CX + first - 1, CY)!;
    expect(Math.hypot(at.x, at.y)).toBeGreaterThanOrEqual(TURRET_AIM_DEAD_RADIUS);
    expect(Math.hypot(before.x, before.y)).toBeLessThan(TURRET_AIM_DEAD_RADIUS);
  });

  it('returns null where the ground point is null', () => {
    expect(turretAngleFromPointer(camera, RECT, CX, RECT.top - 400)).toBeNull();
  });
});

describe('createPreviewControls: the hull turntable', () => {
  it('turns the hull by exactly the drag distance times the rate', () => {
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 100, clientY: CY }));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.bodyAngle - 100 * HULL_DRAG_RAD_PER_PX),
      9,
    );
    h.controls.dispose();
  });

  it('measures the drag from the press, not from the previous move', () => {
    // An incremental (last-move-to-this-move) implementation drifts under a
    // move-back-to-start gesture; an absolute one returns to exactly where it began.
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    for (const x of [CX + 30, CX + 70, CX - 20, CX]) {
      h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: x, clientY: CY }));
    }
    expect(h.controls.pose().bodyAngle).toBeCloseTo(INITIAL_PREVIEW_POSE.bodyAngle, 9);
    h.controls.dispose();
  });

  it('ignores moves from a second pointer mid-drag', () => {
    // A second finger landing on the panel must not teleport the hull: its clientX is
    // differenced against the FIRST pointer's press position if the id is not checked.
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY, pointerId: 1 }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 40, clientY: CY, pointerId: 1 }));
    const after = h.controls.pose().bodyAngle;
    h.canvas.dispatchEvent(
      pointerEvent('pointermove', { clientX: CX + 400, clientY: CY, pointerId: 2, pointerType: 'touch' }),
    );
    expect(h.controls.pose().bodyAngle).toBeCloseTo(after, 12);
    h.controls.dispose();
  });

  it('stops turning the hull once the pointer is released', () => {
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 40, clientY: CY }));
    const held = h.controls.pose().bodyAngle;
    h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX + 40, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 120, clientY: CY }));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(held, 12);
    h.controls.dispose();
  });

  it('ends the drag on pointercancel too', () => {
    // The browser takes the pointer away (a system gesture, a call arriving) and
    // never sends pointerup. Without this the hull stays glued to the next move.
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 40, clientY: CY }));
    const held = h.controls.pose().bodyAngle;
    h.canvas.dispatchEvent(pointerEvent('pointercancel', { clientX: CX + 40, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 120, clientY: CY }));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(held, 12);
    h.controls.dispose();
  });

  it('leaves the right mouse button to the browser', () => {
    const h = harness();
    const before = h.controls.pose();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX + 90, clientY: CY, button: 2 }));
    expect(h.controls.pose()).toEqual(before);
    // ...and no drag was armed, so a following move only hovers.
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 90, clientY: CY }));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(before.bodyAngle, 12);
    h.controls.dispose();
  });
});

describe('createPreviewControls: the turret aims independently of the hull', () => {
  it('follows a hovering mouse without moving the hull', () => {
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.controls.pose().turretAngle).toBeCloseTo(0, 4);
    expect(h.controls.pose().bodyAngle).toBeCloseTo(INITIAL_PREVIEW_POSE.bodyAngle, 12);
    h.controls.dispose();
  });

  it('reports the turret angle ABSOLUTE, not relative to the hull', () => {
    // The bug entities.ts records and its 8-case table pins, one layer up: if this
    // module ever hands back a hull-relative angle, the barrel comes out at
    // bodyAngle + turretAngle. Here the hull is dragged a long way and the gun is
    // then aimed at a known world direction; the reported angle must be that world
    // direction, with no trace of the hull in it.
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 120, clientY: CY }));
    const body = h.controls.pose().bodyAngle;
    h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX + 120, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX, clientY: CY + 70 }));
    expect(h.controls.pose().turretAngle).toBeCloseTo(Math.PI / 2, 4);
    // And the drag really did move the hull somewhere else, or the line above would
    // hold for a relative angle too.
    expect(Math.abs(normalizeAngle(body - Math.PI / 2))).toBeGreaterThan(0.5);
    expect(h.controls.pose().bodyAngle).toBeCloseTo(body, 12);
    h.controls.dispose();
  });

  it('keeps the gun pointing where it pointed while the hull turns under it', () => {
    // Gameplay's rule: driving does not swing the gun. A non-mouse pointer is used
    // because a mouse drag is also a hover, and the hover is the aim.
    const h = harness();
    h.canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: CX + 80, clientY: CY, pointerType: 'touch' }),
    );
    const aimed = h.controls.pose().turretAngle;
    expect(aimed).toBeCloseTo(0, 4);
    h.canvas.dispatchEvent(
      pointerEvent('pointermove', { clientX: CX - 60, clientY: CY + 40, pointerType: 'touch' }),
    );
    expect(h.controls.pose().turretAngle).toBeCloseTo(aimed, 12);
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.bodyAngle + 140 * HULL_DRAG_RAD_PER_PX),
      9,
    );
    h.controls.dispose();
  });

  it('aims on each touch PRESS, since touch has no hover', () => {
    const h = harness();
    h.canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: CX + 80, clientY: CY, pointerType: 'touch' }),
    );
    expect(h.controls.pose().turretAngle).toBeCloseTo(0, 4);
    h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX + 80, clientY: CY, pointerType: 'touch' }));
    h.canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: CX, clientY: CY + 70, pointerType: 'touch' }),
    );
    expect(h.controls.pose().turretAngle).toBeCloseTo(Math.PI / 2, 4);
    h.controls.dispose();
  });

  it('reads the camera live, so a resize re-fit is picked up with no rewiring', () => {
    // preview.ts's resize() re-fits the SAME camera object in place (fitCameraToArea
    // mutates it), and the controls were handed that object. Caching anything derived
    // from it at construction -- a projection matrix, a units-per-pixel scale -- would
    // leave the aim pointing at where the tank used to be after the window resized.
    // Proven by moving the camera underneath a live controls instance: the answer for
    // the SAME screen point has to move with it.
    const own = createPreviewCamera(RECT.width / RECT.height);
    const canvas = makeCanvas();
    let seen: PreviewPose | null = null;
    const controls = createPreviewControls(canvas, {
      camera: own,
      initialPose: INITIAL_PREVIEW_POSE,
      reducedMotion: true,
      onPose: (p) => {
        seen = p;
      },
      raf: () => 0,
      cancelRaf: () => {},
    });
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 70, clientY: CY - 40 }));
    const before = seen!.turretAngle;
    // A quarter turn about the tank: the same pixel now looks at a different patch of
    // ground, so the same event must give a different aim.
    own.position.set(own.position.z, own.position.y, -own.position.x);
    own.lookAt(0, 0, 0);
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 71, clientY: CY - 40 }));
    const after = seen!.turretAngle;
    expect(Math.abs(normalizeAngle(after - before))).toBeGreaterThan(0.5);
    controls.dispose();
  });

  it('leaves the turret alone when the pointer is on the tank itself', () => {
    // The dead radius, through the real event path: a hover at dead centre must not
    // snap the gun to atan2(0, 0) == 0.
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    const aimed = h.controls.pose().turretAngle;
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX, clientY: CY }));
    expect(h.controls.pose().turretAngle).toBeCloseTo(aimed, 12);
    h.controls.dispose();
  });
});

describe('createPreviewControls: keyboard', () => {
  function key(k: string, shift = false): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true });
  }

  it('turns the hull with the arrow keys, in the same direction as the drag', () => {
    const h = harness();
    h.canvas.dispatchEvent(key('ArrowRight'));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.bodyAngle - KEY_STEP_RAD),
      9,
    );
    expect(h.controls.pose().turretAngle).toBeCloseTo(INITIAL_PREVIEW_POSE.turretAngle, 12);
    h.canvas.dispatchEvent(key('ArrowLeft'));
    h.canvas.dispatchEvent(key('ArrowLeft'));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.bodyAngle + KEY_STEP_RAD),
      9,
    );
    h.controls.dispose();
  });

  it('turns the turret with shift held, leaving the hull still', () => {
    const h = harness();
    h.canvas.dispatchEvent(key('ArrowRight', true));
    expect(h.controls.pose().turretAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.turretAngle - KEY_STEP_RAD),
      9,
    );
    expect(h.controls.pose().bodyAngle).toBeCloseTo(INITIAL_PREVIEW_POSE.bodyAngle, 12);
    h.controls.dispose();
  });

  it('swallows the arrows so they neither scroll the pane nor drive the tank', () => {
    // input.ts binds keydown on `window`, and the Customize pane scrolls. Both are
    // reached by bubbling, so both are stopped here or not at all.
    const h = harness();
    const seenAtWindow: string[] = [];
    const spy = (e: Event): void => void seenAtWindow.push((e as KeyboardEvent).key);
    window.addEventListener('keydown', spy);
    const e = key('ArrowRight');
    h.canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(seenAtWindow).toEqual([]);
    window.removeEventListener('keydown', spy);
    h.controls.dispose();
  });

  it('lets every other key through untouched', () => {
    // The negative control for the case above: swallowing the whole key stream would
    // break Escape, Tab and the game's own bindings while the panel is open.
    const h = harness();
    const seenAtWindow: string[] = [];
    const spy = (e: Event): void => void seenAtWindow.push((e as KeyboardEvent).key);
    window.addEventListener('keydown', spy);
    const before = h.controls.pose();
    for (const k of ['ArrowUp', 'ArrowDown', 'Escape', 'Tab', 'a', ' ']) {
      const e = key(k);
      h.canvas.dispatchEvent(e);
      expect(e.defaultPrevented, `${k} was swallowed`).toBe(false);
    }
    expect(seenAtWindow).toEqual(['ArrowUp', 'ArrowDown', 'Escape', 'Tab', 'a', ' ']);
    expect(h.controls.pose()).toEqual(before);
    window.removeEventListener('keydown', spy);
    h.controls.dispose();
  });
});

describe('createPreviewControls: the idle spin', () => {
  it('turns the whole tank, hull and turret together', () => {
    const h = harness();
    expect(h.controls.idleRunning()).toBe(true);
    expect(h.frames).toHaveLength(1);
    h.frames[0](1000); // first frame only establishes the clock
    expect(h.controls.pose()).toEqual(INITIAL_PREVIEW_POSE);
    h.frames[1](1050); // 50ms, comfortably inside the 100ms gap clamp below
    const p = h.controls.pose();
    expect(p.bodyAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.bodyAngle + IDLE_SPIN_RAD_PER_SEC * 0.05),
      9,
    );
    // Together, not independently: the idle spin is a turntable, so the gun stays
    // where it sits relative to the hull.
    expect(normalizeAngle(p.turretAngle - p.bodyAngle)).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.turretAngle - INITIAL_PREVIEW_POSE.bodyAngle),
      9,
    );
    h.controls.dispose();
  });

  it('clamps a long gap so a backgrounded tab does not teleport the tank', () => {
    const h = harness();
    h.frames[0](0);
    h.frames[1](60_000); // a minute in another tab
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.bodyAngle + IDLE_SPIN_RAD_PER_SEC * 0.1),
      9,
    );
    h.controls.dispose();
  });

  it('stops for good at the first interaction, and cancels the pending frame', () => {
    const h = harness();
    h.frames[0](0);
    h.frames[1](100);
    const scheduled = h.frames.length;
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.controls.idleRunning()).toBe(false);
    expect(h.cancelled).toEqual([scheduled]); // the handle raf handed back, not a guess
    const settled = h.controls.pose();
    // A frame callback already in flight must be inert, not one more nudge.
    h.frames[scheduled - 1](5000);
    expect(h.controls.pose()).toEqual(settled);
    expect(h.frames).toHaveLength(scheduled);
    h.controls.dispose();
  });

  it.each([
    ['a key press', (c: HTMLCanvasElement) => c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))],
    ['a press', (c: HTMLCanvasElement) => c.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }))],
    ['a hover', (c: HTMLCanvasElement) => c.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 50, clientY: CY }))],
  ])('%s ends it', (_label, act) => {
    const h = harness();
    act(h.canvas);
    expect(h.controls.idleRunning()).toBe(false);
    h.controls.dispose();
  });

  it('never starts under prefers-reduced-motion', () => {
    const h = harness({ reducedMotion: true });
    expect(h.frames).toHaveLength(0);
    expect(h.controls.idleRunning()).toBe(false);
    // ...and the controls still work, which is the point of suppressing only the spin.
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.controls.pose().turretAngle).toBeCloseTo(0, 4);
    h.controls.dispose();
  });
});

describe('createPreviewControls: the animated-skin clock', () => {
  /** Get past the idle spin, the way a player does, so what is left is the skin's own
   * loop and nothing else. */
  function interacted(): Harness {
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.controls.idleRunning()).toBe(false);
    return h;
  }

  it('runs a loop of its own once an animated skin is worn, and hands it real seconds', () => {
    // Without this the panel has no clock at all after the first interaction: the
    // preview's only other redraws are pose changes and restyles, neither of which is
    // time passing. `flow` was frozen in the panel that sells it.
    const h = interacted();
    const before = h.frames.length;
    h.controls.setAnimating(true);
    expect(h.controls.animating()).toBe(true);
    expect(h.frames.length).toBe(before + 1); // a frame really was scheduled
    h.frames[before](1000); // establishes the clock; credits no time
    expect(h.animates).toHaveLength(0);
    h.frames[before + 1](1050);
    expect(h.animates).toHaveLength(1);
    expect(h.animates[0].dt).toBeCloseTo(0.05, 9);
    h.controls.dispose();
  });

  it('clamps a backgrounded tab, so returning to it does not jump the scroll', () => {
    const h = interacted();
    h.controls.setAnimating(true);
    const i = h.frames.length - 1;
    h.frames[i](0);
    h.frames[i + 1](60_000); // a minute in another tab
    expect(h.animates[0].dt).toBeCloseTo(0.1, 9); // the same clamp the spin uses
    h.controls.dispose();
  });

  it('asks for ONE repaint per frame while the spin is also running, not two', () => {
    // Both behaviours want the frame. Firing onPose as well would draw the same
    // 260x190 canvas twice per frame for as long as an untouched panel shows `flow`.
    const h = harness();
    h.controls.setAnimating(true);
    expect(h.controls.idleRunning()).toBe(true);
    h.frames[0](0);
    h.frames[1](50);
    expect(h.animates).toHaveLength(1);
    expect(h.poses).toHaveLength(0);
    // ...and the spin still turned the tank: the pose came through onAnimate instead.
    expect(h.animates[0].pose.bodyAngle).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE.bodyAngle + IDLE_SPIN_RAD_PER_SEC * 0.05),
      9,
    );
    h.controls.dispose();
  });

  it('starts ONE loop, not a second one, when the skin joins the spin', () => {
    // The test above pins that `onPose` and `onAnimate` do not BOTH fire on a frame. It
    // does not pin that there is one frame to fire on. `startFrames`' re-entrancy guard
    // is what makes that true, and it was unpinned: `if (disposed || frameHandle !==
    // null) return` -> `if (disposed) return` passed this whole file, 1740 of 1742 vitest
    // cases (2 skipped -- the gate BEFORE this test existed) and all 50 GL checks.
    //
    // The live path reaches it: loop.ts calls `preview.setStyle` when Customize opens,
    // while the idle spin already has a frame pending, so `setAnimating(true)` would
    // schedule a SECOND rAF callback -- and each callback reschedules itself, so it is
    // two parallel loops for the rest of the session for anyone wearing `flow`.
    const h = harness(); // the idle spin already scheduled frames[0]
    expect(h.frames).toHaveLength(1);
    h.controls.setAnimating(true);
    expect(h.frames).toHaveLength(1); // hung on the running loop; 2 without the guard
    h.controls.dispose();
  });

  it('keeps the loop alive when the interaction ends the spin', () => {
    // The two stopping conditions really are separate: `stopIdle` cancels the pending
    // frame when nothing else needs it, and must NOT when the skin does. Asserted on
    // `cancelled` rather than on later frames firing, because the fake raf will happily
    // invoke a callback the production code cancelled -- a real browser would not, so
    // an "it kept animating" assertion passes against the very bug it is aimed at.
    const h = harness();
    h.controls.setAnimating(true);
    h.frames[0](0);
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.controls.idleRunning()).toBe(false);
    expect(h.cancelled).toEqual([]); // the frame the skin still needs was left alone
    const i = h.frames.length - 1;
    h.frames[i](50);
    h.frames[i + 1](100);
    expect(h.animates.length).toBeGreaterThan(0);
    const spun = h.animates[h.animates.length - 1].pose.bodyAngle;
    h.frames[h.frames.length - 1](150);
    // Still repainting, and the hull is NOT turning any more.
    expect(h.animates[h.animates.length - 1].pose.bodyAngle).toBe(spun);
    h.controls.dispose();
  });

  it('stops for good when a static skin is picked, leaving no loop behind', () => {
    const h = interacted();
    h.controls.setAnimating(true);
    const scheduled = h.frames.length;
    h.controls.setAnimating(false);
    expect(h.controls.animating()).toBe(false);
    expect(h.cancelled).toContain(scheduled); // the handle raf handed back, not a guess
    // A callback the browser had already committed to must be inert.
    h.frames[scheduled - 1](5000);
    expect(h.animates).toHaveLength(0);
    expect(h.frames).toHaveLength(scheduled);
    h.controls.dispose();
  });

  it('picking a static skin does not take the idle spin down with it', () => {
    const h = harness();
    h.controls.setAnimating(true);
    h.controls.setAnimating(false);
    expect(h.controls.idleRunning()).toBe(true);
    // On `cancelled`, for the same reason as above: the fake raf still invokes a
    // callback the production code cancelled, so firing frames cannot see this.
    expect(h.cancelled).toEqual([]);
    h.frames[h.frames.length - 1](0);
    h.frames[h.frames.length - 1](50);
    expect(h.poses).toHaveLength(1); // the spin is still turning it
    h.controls.dispose();
  });

  it('re-enabling drops the stale timestamp instead of crediting the whole gap', () => {
    // The loop can sit stopped for minutes between two skin picks. Differencing against
    // the timestamp it stopped on would hand the skin the entire gap in one frame.
    const h = interacted();
    h.controls.setAnimating(true);
    let i = h.frames.length - 1;
    h.frames[i](1000);
    h.frames[i + 1](1050);
    h.controls.setAnimating(false);
    h.controls.setAnimating(true);
    i = h.frames.length - 1;
    h.frames[i](600_000); // ten minutes later
    expect(h.animates).toHaveLength(1); // that frame only re-established the clock
    h.frames[i + 1](600_050);
    expect(h.animates[1].dt).toBeCloseTo(0.05, 9);
    h.controls.dispose();
  });

  it('still animates under prefers-reduced-motion, where the idle spin does not', () => {
    // THE DECISION, and it is a decision rather than an oversight: the spin is motion
    // the panel invents, the scroll is what the skin IS -- and the game scrolls it in
    // play whatever the media query says. Suppressing it here would make the preview
    // misrepresent the thing being chosen.
    const h = harness({ reducedMotion: true });
    expect(h.frames).toHaveLength(0);
    h.controls.setAnimating(true);
    expect(h.frames).toHaveLength(1);
    h.frames[0](0);
    h.frames[1](50);
    expect(h.animates).toHaveLength(1);
    // ...and the pose is untouched: no spin was smuggled in with it.
    expect(h.animates[0].pose).toEqual(INITIAL_PREVIEW_POSE);
    h.controls.dispose();
  });

  it('schedules nothing more after dispose, however the skin was left', () => {
    const h = interacted();
    h.controls.setAnimating(true);
    const scheduled = h.frames.length;
    h.controls.dispose();
    expect(h.controls.animating()).toBe(false);
    expect(h.cancelled).toContain(scheduled);
    h.frames[scheduled - 1](5000);
    expect(h.frames).toHaveLength(scheduled);
    expect(h.animates).toHaveLength(0);
    h.controls.dispose();
  });
});

describe('createPreviewControls: it reports changes, and only changes', () => {
  it('does not call back on construction', () => {
    const h = harness();
    expect(h.poses).toEqual([]);
    h.controls.dispose();
  });

  it('calls back once per real change and stays silent on a repeat', () => {
    // onPose is a redraw request. A hover that lands on the same ground point twice
    // (a mouse resting while the OS repeats a move) must not repaint.
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.poses).toHaveLength(1);
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.poses).toHaveLength(1);
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 81, clientY: CY }));
    expect(h.poses).toHaveLength(2);
    expect(h.poses[1]).toEqual(h.controls.pose());
    h.controls.dispose();
  });
});

describe('createPreviewControls: teardown', () => {
  it('removes every listener it added', () => {
    // Paired by type AND by function identity: `removeEventListener` with a different
    // function is a silent no-op, which a count-only check would call clean.
    const canvas = makeCanvas();
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const realAdd = canvas.addEventListener.bind(canvas);
    const realRemove = canvas.removeEventListener.bind(canvas);
    canvas.addEventListener = ((t: string, f: unknown, o?: unknown) => {
      added.push([t, f]);
      return realAdd(t, f as EventListener, o as boolean);
    }) as typeof canvas.addEventListener;
    canvas.removeEventListener = ((t: string, f: unknown, o?: unknown) => {
      removed.push([t, f]);
      return realRemove(t, f as EventListener, o as boolean);
    }) as typeof canvas.removeEventListener;

    const controls = createPreviewControls(canvas, {
      camera,
      initialPose: INITIAL_PREVIEW_POSE,
      onPose: () => {},
      raf: () => 1,
      cancelRaf: () => {},
    });
    expect(added.length).toBeGreaterThan(0);
    controls.dispose();
    expect(removed).toEqual(added);
  });

  it('goes quiet after dispose, on every input it listens for', () => {
    // The behavioural half: the Customize panel closes while a finger is still down,
    // and anything that still fires is drawing into a disposed renderer.
    const h = harness();
    h.controls.dispose();
    const settled = h.controls.pose();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 100, clientY: CY + 40 }));
    h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX + 100, clientY: CY + 40 }));
    h.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(h.poses).toEqual([]);
    expect(h.controls.pose()).toEqual(settled);
    expect(h.controls.idleRunning()).toBe(false);
  });

  it('cancels the pending idle frame', () => {
    const h = harness();
    expect(h.frames).toHaveLength(1);
    h.controls.dispose();
    expect(h.cancelled).toEqual([1]);
  });

  it('is safe to call twice', () => {
    const h = harness();
    h.controls.dispose();
    expect(() => h.controls.dispose()).not.toThrow();
    expect(h.cancelled).toEqual([1]); // and does not double-cancel a stale handle
  });

  it('focuses the canvas on press, so the keyboard scheme is reachable by clicking it', () => {
    // preventDefault on pointerdown suppresses the implicit focus a click would give.
    const h = harness();
    const spy = vi.spyOn(h.canvas, 'focus');
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    h.controls.dispose();
  });

  it('cancels the press default, so a drag is not a text selection', () => {
    // This existed as an UNCHECKED claim: `onPointerDown` calls preventDefault, the
    // comment beside it explains that `canvas.focus()` is there to compensate for the
    // focus it suppresses, and deleting it passed every case. Review found it, which is
    // the second time this file has needed the same lesson -- a call whose consequence
    // another line exists to undo is exactly the one that has to be asserted.
    //
    // What it stops: on desktop, dragging across a canvas begins a document text
    // selection, which then follows the pointer over the swatches below and highlights
    // the panel while the tank turns. (Touch is already covered by `touch-action: none`
    // in hud.css, which has its own check.)
    const h = harness();
    const press = pointerEvent('pointerdown', { clientX: CX, clientY: CY });
    h.canvas.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    // The negative control, and the reason this is not just "preventDefault is called":
    // a press the controls DECLINE (the right mouse button) must be left to the browser
    // entirely, default included, or the context menu stops opening over the preview.
    const right = pointerEvent('pointerdown', { clientX: CX, clientY: CY, button: 2 });
    h.canvas.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(false);
    h.controls.dispose();
  });
});
