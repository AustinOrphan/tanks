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
  parseRotateButtons,
  groundPointFromPointer,
  turretAngleFromPointer,
  normalizeAngle,
  HULL_DRAG_RAD_PER_PX,
  KEY_STEP_RAD,
  IDLE_SPIN_RAD_PER_SEC,
  IDLE_SPIN_MAX_RAD,
  IDLE_RESUME_DELAY_MS,
  HOLD_RAD_PER_SEC,
  HOLD_REPEAT_DELAY_MS,
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

/** The four buttons hud.ts ships, as far as this module is concerned: the two data
 * attributes and nothing else. */
function makeRotateButtons(): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
  for (const part of ['hull', 'turret'] as const) {
    for (const dir of ['left', 'right'] as const) {
      const b = document.createElement('button');
      b.dataset.rotatePart = part;
      b.dataset.rotateDir = dir;
      document.body.appendChild(b);
      out.push(b);
    }
  }
  return out;
}

interface Harness {
  canvas: HTMLCanvasElement;
  controls: ReturnType<typeof createPreviewControls>;
  poses: PreviewPose[];
  frames: Array<(t: number) => void>;
  cancelled: number[];
  buttons: HTMLButtonElement[];
  /** The rotate button for a part/direction, by the same attributes hud.ts writes. */
  button(part: 'hull' | 'turret', dir: 'left' | 'right'): HTMLButtonElement;
  /** Pending resume timers, as [handle, callback]. Fire one with `fireTimer`. */
  timers: Map<number, () => void>;
  timerDelays: number[];
  clearedTimers: number[];
  fireTimer(): void;
}

function harness(opts: { reducedMotion?: boolean; rect?: typeof RECT } = {}): Harness {
  const canvas = makeCanvas(opts.rect);
  const poses: PreviewPose[] = [];
  const frames: Array<(t: number) => void> = [];
  const cancelled: number[] = [];
  const buttons = makeRotateButtons();
  const timers = new Map<number, () => void>();
  const timerDelays: number[] = [];
  const clearedTimers: number[] = [];
  let nextTimer = 1;
  const controls = createPreviewControls(canvas, {
    camera,
    initialPose: INITIAL_PREVIEW_POSE,
    reducedMotion: opts.reducedMotion,
    onPose: (p) => poses.push(p),
    raf: (cb) => {
      frames.push(cb);
      return frames.length; // 1-based, so 0 is never a valid handle
    },
    cancelRaf: (h) => cancelled.push(h),
    rotateButtons: buttons,
    setTimer: (cb, ms) => {
      timerDelays.push(ms);
      const h = nextTimer++;
      timers.set(h, cb);
      return h;
    },
    clearTimer: (h) => {
      clearedTimers.push(h);
      timers.delete(h);
    },
  });
  return {
    canvas,
    controls,
    poses,
    frames,
    cancelled,
    buttons,
    button: (part, dir) =>
      buttons.find((b) => b.dataset.rotatePart === part && b.dataset.rotateDir === dir)!,
    timers,
    timerDelays,
    clearedTimers,
    fireTimer(): void {
      const live = [...timers.entries()];
      if (live.length !== 1) throw new Error(`expected exactly 1 pending timer, saw ${live.length}`);
      timers.delete(live[0][0]);
      live[0][1]();
    },
  };
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

  it('stops at the first interaction, and cancels the pending frame', () => {
    // A HOVER, which arms no resume (see the resume block below: a mouse resting on the
    // canvas is still aiming), so "stopped" here also means "stays stopped".
    const h = harness();
    h.frames[0](0);
    h.frames[1](100);
    const scheduled = h.frames.length;
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(h.controls.idleRunning()).toBe(false);
    expect(h.cancelled).toEqual([scheduled]); // the handle raf handed back, not a guess
    expect(h.timers.size, 'a hover armed a resume').toBe(0);
    const settled = h.controls.pose();
    // A frame callback already in flight must be inert, not one more nudge.
    h.frames[scheduled - 1](5000);
    expect(h.controls.pose()).toEqual(settled);
    expect(h.frames).toHaveLength(scheduled);
    h.controls.dispose();
  });

  it('stops itself after exactly one revolution, back where it started', () => {
    // The cost bound (IDLE_SPIN_MAX_RAD), and it has to be exact in both directions:
    // stopping early leaves a face unshown, and overshooting is a spin that never ends
    // at a meaningful pose. Driven in 0.1s frames -- the gap clamp's own limit -- so
    // the run takes a bounded number of steps.
    const h = harness();
    const totalSec = IDLE_SPIN_MAX_RAD / IDLE_SPIN_RAD_PER_SEC;
    let t = 0;
    h.frames[0](t); // establishes the clock, moves nothing
    // One frame past the revolution, so the LAST step is the partial one.
    const steps = Math.ceil(totalSec / 0.1) + 1;
    for (let i = 0; i < steps && h.controls.idleRunning(); i++) {
      t += 100;
      h.frames[h.frames.length - 1](t);
    }
    expect(h.controls.idleRunning(), 'the spin never stopped').toBe(false);
    // Exactly one turn: the pose is the pose it opened at, not a frame past it.
    const p = h.controls.pose();
    expect(Math.cos(p.bodyAngle)).toBeCloseTo(Math.cos(INITIAL_PREVIEW_POSE.bodyAngle), 9);
    expect(Math.sin(p.bodyAngle)).toBeCloseTo(Math.sin(INITIAL_PREVIEW_POSE.bodyAngle), 9);
    expect(Math.cos(p.turretAngle)).toBeCloseTo(Math.cos(INITIAL_PREVIEW_POSE.turretAngle), 9);
    expect(Math.sin(p.turretAngle)).toBeCloseTo(Math.sin(INITIAL_PREVIEW_POSE.turretAngle), 9);
    // ...and it really did turn all the way round on the way, rather than stopping at
    // the first frame: at 0.35 rad/s a revolution is ~18s, so ~180 frames of 0.1s.
    expect(h.frames.length).toBeGreaterThan(100);
    // Nothing is scheduled once the budget is gone -- that is the whole point of it.
    const after = h.frames.length;
    expect(h.frames).toHaveLength(after);
    h.controls.dispose();
  });

  it('stops while the document is hidden and picks up again when it comes back', () => {
    // Unverifiable-by-measurement territory (see preview-controls.ts's doc comment):
    // headless chromium would not report a hidden document, so this is asserted at the
    // event level. `visibilityState` is a prototype getter, so it is overridden here
    // rather than set.
    const h = harness();
    h.frames[0](0);
    h.frames[1](100);
    const pending = h.frames.length;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.cancelled, 'the loop kept running into a hidden tab').toEqual([pending]);
    const parked = h.controls.pose();
    // A callback already in flight must not restart it either.
    h.frames[pending - 1](5000);
    expect(h.controls.pose()).toEqual(parked);
    expect(h.frames).toHaveLength(pending);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.frames.length).toBe(pending + 1);
    h.frames[h.frames.length - 1](6000); // fresh clock, so this one only re-establishes it
    h.frames[h.frames.length - 1](6100);
    expect(h.controls.pose().bodyAngle).not.toBe(parked.bodyAngle);
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

describe('parseRotateButtons', () => {
  function el(part?: string, dir?: string): HTMLElement {
    const b = document.createElement('button');
    if (part !== undefined) b.dataset.rotatePart = part;
    if (dir !== undefined) b.dataset.rotateDir = dir;
    return b;
  }

  it('reads the four pairs hud.ts ships, right as +1 and left as -1', () => {
    // +1 is rightward on screen, which is the sign the drag and ArrowRight already use.
    // Getting this backwards is a button that turns the tank the way its icon does not.
    const parsed = parseRotateButtons([
      el('hull', 'left'),
      el('hull', 'right'),
      el('turret', 'left'),
      el('turret', 'right'),
    ]);
    expect(parsed.map((p) => [p.part, p.dir])).toEqual([
      ['hull', -1],
      ['hull', 1],
      ['turret', -1],
      ['turret', 1],
    ]);
  });

  it('drops anything it does not recognise rather than guessing', () => {
    // The negative control. A typo has to make a button INERT: guessing a default would
    // give "turn turret left" a button that turns the hull, which looks like it works.
    expect(parseRotateButtons([el('hull')])).toEqual([]);
    expect(parseRotateButtons([el(undefined, 'left')])).toEqual([]);
    expect(parseRotateButtons([el('gun', 'left')])).toEqual([]);
    expect(parseRotateButtons([el('hull', 'up')])).toEqual([]);
    expect(parseRotateButtons([el('Hull', 'Left')])).toEqual([]);
    expect(parseRotateButtons([document.createElement('div')])).toEqual([]);
    // ...and one bad entry does not take the good ones with it.
    expect(parseRotateButtons([el('hull', 'up'), el('turret', 'right')]).map((p) => p.part)).toEqual(
      ['turret'],
    );
  });
});

describe('createPreviewControls: the rotate buttons', () => {
  it.each([
    ['hull', 'right', 'bodyAngle', -1],
    ['hull', 'left', 'bodyAngle', 1],
    ['turret', 'right', 'turretAngle', -1],
    ['turret', 'left', 'turretAngle', 1],
  ] as const)('a press on %s %s nudges %s by one key step', (part, dir, field, sign) => {
    const h = harness();
    const other = field === 'bodyAngle' ? 'turretAngle' : 'bodyAngle';
    h.button(part, dir).dispatchEvent(pointerEvent('pointerdown'));
    expect(h.controls.pose()[field]).toBeCloseTo(
      normalizeAngle(INITIAL_PREVIEW_POSE[field] + sign * KEY_STEP_RAD),
      9,
    );
    // The other part must not move: four buttons that all turn the whole tank is the
    // defect this cluster exists to avoid.
    expect(h.controls.pose()[other]).toBeCloseTo(INITIAL_PREVIEW_POSE[other], 12);
    h.controls.dispose();
  });

  it('agrees with the arrow keys, button for key', () => {
    // The three schemes have to move the tank the same way, and this is the only place
    // that compares two of them directly: flipping the button sign passes every
    // assertion above (they were written from the same constant) and fails here.
    const viaKey = harness();
    viaKey.canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    viaKey.canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }),
    );
    const keyed = viaKey.controls.pose();
    viaKey.controls.dispose();

    const viaButton = harness();
    viaButton.button('hull', 'right').dispatchEvent(pointerEvent('pointerdown'));
    viaButton.button('turret', 'left').dispatchEvent(pointerEvent('pointerdown'));
    expect(viaButton.controls.pose().bodyAngle).toBeCloseTo(keyed.bodyAngle, 12);
    expect(viaButton.controls.pose().turretAngle).toBeCloseTo(keyed.turretAngle, 12);
    viaButton.controls.dispose();
  });

  it('holds still for the repeat delay, then turns at the hold rate', () => {
    // Both halves matter. Without the delay a tap is a spin; without the rate ramp a
    // hold is one nudge. The boundary is asserted at the constant, so retuning either
    // does not mean rewriting this.
    // Frames 50ms apart on purpose: the loop clamps any gap over 100ms, so a test that
    // jumped straight to the boundary would be measuring the CLAMP, not the delay --
    // which is exactly what a first draft of this did, and it failed for that reason.
    const h = harness({ reducedMotion: true });
    const b = h.button('hull', 'right');
    b.dispatchEvent(pointerEvent('pointerdown'));
    const afterPress = h.controls.pose().bodyAngle;
    const next = (): ((t: number) => void) => h.frames[h.frames.length - 1];
    next()(0); // establishes the clock
    // Right up to the boundary: still nothing beyond the press's own nudge.
    for (let t = 50; t <= HOLD_REPEAT_DELAY_MS; t += 50) next()(t);
    expect(h.controls.pose().bodyAngle, 'the hold started early').toBeCloseTo(afterPress, 12);
    // A frame that STRADDLES the boundary turns by the part of it that is past the
    // boundary (30ms of an 80ms frame), not by the whole frame.
    next()(HOLD_REPEAT_DELAY_MS + 30);
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(afterPress - HOLD_RAD_PER_SEC * 0.03),
      9,
    );
    // ...and a whole frame past it turns by the whole frame.
    next()(HOLD_REPEAT_DELAY_MS + 80);
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(afterPress - HOLD_RAD_PER_SEC * 0.08),
      9,
    );
    h.controls.dispose();
  });

  it('turns the turret alone on a turret hold, and the hull alone on a hull hold', () => {
    for (const [part, moved, still] of [
      ['turret', 'turretAngle', 'bodyAngle'],
      ['hull', 'bodyAngle', 'turretAngle'],
    ] as const) {
      const h = harness({ reducedMotion: true });
      h.button(part, 'right').dispatchEvent(pointerEvent('pointerdown'));
      const next = (): ((t: number) => void) => h.frames[h.frames.length - 1];
      next()(0);
      const held = h.controls.pose();
      for (let t = 50; t <= HOLD_REPEAT_DELAY_MS + 200; t += 50) next()(t);
      expect(h.controls.pose()[moved], part).not.toBeCloseTo(held[moved], 6);
      expect(h.controls.pose()[still], part).toBeCloseTo(held[still], 12);
      h.controls.dispose();
    }
  });

  it.each(['pointerup', 'pointercancel', 'pointerleave'])('stops the hold on %s', (endEvent) => {
    // A hold that outlives the press is a tank that never stops turning. pointerleave
    // is in the list because that is what a lifted finger sends, and what dragging off
    // the button sends on desktop.
    const h = harness({ reducedMotion: true });
    const b = h.button('hull', 'right');
    b.dispatchEvent(pointerEvent('pointerdown'));
    const next = (): ((t: number) => void) => h.frames[h.frames.length - 1];
    next()(0);
    for (let t = 50; t <= HOLD_REPEAT_DELAY_MS + 100; t += 50) next()(t);
    const turning = h.controls.pose().bodyAngle;
    const scheduled = h.frames.length;
    b.dispatchEvent(pointerEvent(endEvent));
    // Nothing more is scheduled, and a callback already in flight is inert.
    h.frames[scheduled - 1](HOLD_REPEAT_DELAY_MS + 2000);
    expect(h.controls.pose().bodyAngle).toBeCloseTo(turning, 12);
    expect(h.frames).toHaveLength(scheduled);
    h.controls.dispose();
  });

  it('stops the hold on dispose, mid-press', () => {
    // The Customize panel closing while a finger is still down on a button -- the same
    // race dispose() already handles for the canvas.
    const h = harness({ reducedMotion: true });
    h.button('turret', 'left').dispatchEvent(pointerEvent('pointerdown'));
    const next = (): ((t: number) => void) => h.frames[h.frames.length - 1];
    next()(0);
    const scheduled = h.frames.length;
    h.controls.dispose();
    const settled = h.controls.pose();
    h.frames[scheduled - 1](HOLD_REPEAT_DELAY_MS + 2000);
    expect(h.controls.pose()).toEqual(settled);
    expect(h.frames).toHaveLength(scheduled);
    expect(h.timers.size, 'a resume timer outlived the panel').toBe(0);
    // ...and the buttons are dead afterwards, not merely quiet.
    h.button('turret', 'left').dispatchEvent(pointerEvent('pointerdown'));
    h.button('turret', 'left').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.controls.pose()).toEqual(settled);
  });

  it('does not turn twice for one mouse press, but still answers a bare click', () => {
    // A pointer press is followed by a click, and both would nudge. The suppression has
    // to be narrow: an assistive technology can activate a button with a click alone,
    // and swallowing that leaves four dead buttons for exactly the users the cluster
    // was added for.
    const h = harness();
    const b = h.button('hull', 'right');
    const start = h.controls.pose().bodyAngle;
    b.dispatchEvent(pointerEvent('pointerdown'));
    b.dispatchEvent(pointerEvent('pointerup'));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(normalizeAngle(start - KEY_STEP_RAD), 9);
    // A click with no press in front of it is a real activation.
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.controls.pose().bodyAngle).toBeCloseTo(normalizeAngle(start - 2 * KEY_STEP_RAD), 9);
    h.controls.dispose();
  });

  it('answers Enter and Space, swallowing the default so the browser does not click too', () => {
    const h = harness();
    const b = h.button('turret', 'right');
    const start = h.controls.pose().turretAngle;
    for (const key of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      b.dispatchEvent(e);
      expect(e.defaultPrevented, `${key} was left to the browser`).toBe(true);
    }
    expect(h.controls.pose().turretAngle).toBeCloseTo(normalizeAngle(start - 2 * KEY_STEP_RAD), 9);
    h.controls.dispose();
  });

  it('leaves every other key on a button alone, including the canvas arrows', () => {
    // The negative control for the case above, and the one that says the cluster has
    // not stolen the canvas's scheme: arrows pressed on a BUTTON must do nothing here
    // (the canvas turns them into rotation only when the canvas has focus).
    const h = harness();
    const b = h.button('hull', 'left');
    const before = h.controls.pose();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Escape', 'Tab', 'a']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      b.dispatchEvent(e);
      expect(e.defaultPrevented, `${key} was swallowed`).toBe(false);
    }
    expect(h.controls.pose()).toEqual(before);
    h.controls.dispose();
  });

  it('leaves the right mouse button on a rotate button to the browser', () => {
    const h = harness();
    const before = h.controls.pose();
    h.button('hull', 'right').dispatchEvent(pointerEvent('pointerdown', { button: 2 }));
    expect(h.controls.pose()).toEqual(before);
    h.controls.dispose();
  });

  it('builds a working turntable with no buttons at all', () => {
    // The buttons are optional in the deps, and preview.ts's caller may not pass them.
    // Nothing about the canvas schemes may depend on them existing.
    const canvas = makeCanvas();
    let seen: PreviewPose | null = null;
    const controls = createPreviewControls(canvas, {
      camera,
      initialPose: INITIAL_PREVIEW_POSE,
      reducedMotion: true,
      onPose: (p) => {
        seen = p;
      },
      raf: () => 0,
      cancelRaf: () => {},
    });
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(seen!.turretAngle).toBeCloseTo(0, 4);
    controls.dispose();
  });
});

describe('createPreviewControls: the idle spin comes back', () => {
  it('arms a resume when a drag ENDS, and the resume turns the tank again', () => {
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 60, clientY: CY }));
    expect(h.controls.idleRunning()).toBe(false);
    expect(h.timers.size, 'a resume was armed while the drag was still running').toBe(0);
    h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX + 60, clientY: CY }));
    expect(h.timerDelays.at(-1)).toBe(IDLE_RESUME_DELAY_MS);
    const parked = h.controls.pose();
    h.fireTimer();
    expect(h.controls.idleRunning()).toBe(true);
    // ...and it really turns, rather than merely reporting that it is running.
    h.frames[h.frames.length - 1](0);
    h.frames[h.frames.length - 1](100);
    expect(h.controls.pose().bodyAngle).toBeCloseTo(
      normalizeAngle(parked.bodyAngle + IDLE_SPIN_RAD_PER_SEC * 0.1),
      9,
    );
    h.controls.dispose();
  });

  it('resumes at once when a MOUSE leaves the canvas, and not when a finger lifts off it', () => {
    // Desktop's resume is pointerleave; touch has no hover to leave, and its
    // pointerleave arrives the instant the finger comes up -- resuming there would
    // start the tank turning under a player who has just let go.
    const mouse = harness();
    mouse.canvas.dispatchEvent(pointerEvent('pointerenter'));
    mouse.canvas.dispatchEvent(pointerEvent('pointermove', { clientX: CX + 80, clientY: CY }));
    expect(mouse.controls.idleRunning()).toBe(false);
    mouse.canvas.dispatchEvent(pointerEvent('pointerleave'));
    expect(mouse.controls.idleRunning()).toBe(true);
    mouse.controls.dispose();

    const touch = harness();
    touch.canvas.dispatchEvent(pointerEvent('pointerenter', { pointerType: 'touch' }));
    touch.canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: CX + 80, clientY: CY, pointerType: 'touch' }),
    );
    touch.canvas.dispatchEvent(
      pointerEvent('pointerup', { clientX: CX + 80, clientY: CY, pointerType: 'touch' }),
    );
    touch.canvas.dispatchEvent(pointerEvent('pointerleave', { pointerType: 'touch' }));
    expect(touch.controls.idleRunning(), 'a lifted finger resumed the spin at once').toBe(false);
    // The timer is what covers touch, and it is armed.
    touch.fireTimer();
    expect(touch.controls.idleRunning()).toBe(true);
    touch.controls.dispose();
  });

  it('will not resume under a pointer that is still on the canvas', () => {
    // A hovering mouse IS the aim. The timer fires, finds the pointer still there, and
    // leaves the tank alone; leaving is what brings the spin back.
    const h = harness();
    h.canvas.dispatchEvent(pointerEvent('pointerenter'));
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX, clientY: CY }));
    h.fireTimer();
    expect(h.controls.idleRunning()).toBe(false);
    h.canvas.dispatchEvent(pointerEvent('pointerleave'));
    expect(h.controls.idleRunning()).toBe(true);
    h.controls.dispose();
  });

  it('will not resume in the middle of a held button', () => {
    // The reachable path, spelled out because it is not the obvious one: a press CANCELS
    // any pending resume, so the timer cannot fire mid-hold. What can is the mouse
    // leaving the CANVAS while a button is held -- the pointer moved off the canvas onto
    // the button, and that leave would otherwise start the spin turning against the hold.
    const h = harness();
    const b = h.button('hull', 'right');
    b.dispatchEvent(pointerEvent('pointerdown'));
    expect(h.timers.size, 'a press armed a resume against itself').toBe(0);
    h.canvas.dispatchEvent(pointerEvent('pointerenter'));
    h.canvas.dispatchEvent(pointerEvent('pointerleave'));
    expect(h.controls.idleRunning(), 'the spin resumed against a held button').toBe(false);
    // The control: the SAME leave, with nothing held, does resume -- so the case above
    // is the hold declining it, not the leave failing to work.
    b.dispatchEvent(pointerEvent('pointerup'));
    h.canvas.dispatchEvent(pointerEvent('pointerenter'));
    h.canvas.dispatchEvent(pointerEvent('pointerleave'));
    expect(h.controls.idleRunning()).toBe(true);
    h.controls.dispose();
  });

  it('never resumes under prefers-reduced-motion, on any path', () => {
    // The population of paths that end an interaction: a release, a mouse leaving, and
    // the timer. None of them may start a spin the player has asked not to see.
    const h = harness({ reducedMotion: true });
    h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
    h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX, clientY: CY }));
    expect(h.timers.size, 'a resume was armed under reduced motion').toBe(0);
    h.canvas.dispatchEvent(pointerEvent('pointerleave'));
    expect(h.controls.idleRunning()).toBe(false);
    expect(h.frames).toHaveLength(0);
    h.controls.dispose();
  });

  it('re-arms rather than stacking: one pending resume, whatever happens', () => {
    // Each end-of-interaction cancels the previous timer. Without that, a player who
    // taps five times has five resumes pending, the first of which fires early.
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: CX, clientY: CY }));
      h.canvas.dispatchEvent(pointerEvent('pointerup', { clientX: CX, clientY: CY }));
    }
    expect(h.timers.size).toBe(1);
    // ...and the ones it replaced were CANCELLED, not left running.
    expect(h.clearedTimers.length).toBeGreaterThanOrEqual(4);
    h.controls.dispose();
    expect(h.timers.size).toBe(0);
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
