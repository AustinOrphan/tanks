// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createInputController, InputController } from './input';
import type { Vec2 } from '../sim/types';

// A predictable screenToGround: echoes the client coords as a world point.
const echoGround = (clientX: number, clientY: number): Vec2 => ({ x: clientX, y: clientY });

let controller: InputController | null = null;

afterEach(() => {
  controller?.dispose();
  controller = null;
});

function makeTarget(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function key(type: 'keydown' | 'keyup', k: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { key: k }));
}

describe('createInputController — movement', () => {
  it('maps WASD to axis-aligned move vectors', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    // NORTH IS -Y. Render maps world y to three's z and the camera looks from +z, so
    // increasing y moves down the screen. These assertions used to be the other way
    // round, which is how w-drives-backwards passed the whole suite.
    key('keydown', 'w');
    expect(controller.sample().move).toEqual({ x: 0, y: -1 });

    key('keyup', 'w');
    key('keydown', 's');
    expect(controller.sample().move).toEqual({ x: 0, y: 1 });

    key('keyup', 's');
    key('keydown', 'a');
    expect(controller.sample().move).toEqual({ x: -1, y: 0 });

    key('keyup', 'a');
    key('keydown', 'd');
    expect(controller.sample().move).toEqual({ x: 1, y: 0 });
  });

  it('maps arrow keys identically to WASD', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    key('keydown', 'ArrowUp');
    expect(controller.sample().move).toEqual({ x: 0, y: -1 });
  });

  it('returns an un-normalized diagonal (magnitude ~1.41)', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    key('keydown', 'w');
    key('keydown', 'd');
    const move = controller.sample().move;
    expect(move).toEqual({ x: 1, y: -1 });
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(Math.SQRT2, 6);
  });

  it('cancels opposite keys to zero drift', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    key('keydown', 'a');
    key('keydown', 'd');
    expect(controller.sample().move).toEqual({ x: 0, y: 0 });
  });
});

describe('createInputController — aim', () => {
  it('resolves aim through the injected screenToGround on mouse move', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 42, clientY: 7 }));
    expect(controller.sample().aim).toEqual({ x: 42, y: 7 });
  });

  it('keeps tracking aim over HUD overlays that swallow canvas pointer events', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    // The HUD audio cluster sets pointer-events:auto and sits above the canvas,
    // so a mousemove there never reaches the canvas. Aim is a pure coordinate
    // transform and must not depend on hit-testing.
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 9, bubbles: true }));

    expect(controller.sample().aim).toEqual({ x: 5, y: 9 });
    overlay.remove();
  });
});

describe('createInputController — fire/mine edges', () => {
  it('left-click yields fire=true on exactly one sample, then false', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    expect(controller.sample().fire).toBe(true);
    expect(controller.sample().fire).toBe(false);
  });

  it('Space drops a mine as a one-shot edge', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(controller.sample().mine).toBe(true);
    expect(controller.sample().mine).toBe(false);
  });

  it('right-click drops a mine and suppresses the context menu', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    target.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    expect(controller.sample().mine).toBe(true);

    const ctx = new MouseEvent('contextmenu', { cancelable: true });
    target.dispatchEvent(ctx);
    expect(ctx.defaultPrevented).toBe(true);
  });

  it('a held-down key does not re-trigger the mine edge each sample', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(controller.sample().mine).toBe(true);
    // No keyup dispatched (key still held), but the edge was consumed:
    expect(controller.sample().mine).toBe(false);
  });

  it('browser auto-repeat keydown events do not re-arm the mine edge', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    // Initial physical press: repeat defaults to false.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(controller.sample().mine).toBe(true);

    // Browser auto-repeat fires further keydowns with repeat:true while the
    // key stays held, with no keyup in between. These must NOT re-arm mine.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true }));
    expect(controller.sample().mine).toBe(false);
  });
});

describe('createInputController — focus loss', () => {
  it('clears held keys on window blur so the tank does not drive forever', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    key('keydown', 'w');
    expect(controller.sample().move).toEqual({ x: 0, y: -1 });

    // Alt-tab: the OS delivers the keyup to the *other* window, so we never
    // see it. Without a blur handler 'w' stays in the set permanently.
    window.dispatchEvent(new Event('blur'));
    expect(controller.sample().move).toEqual({ x: 0, y: 0 });
  });

  it('clears held keys when the document becomes hidden', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    key('keydown', 'd');
    expect(controller.sample().move).toEqual({ x: 1, y: 0 });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(controller.sample().move).toEqual({ x: 0, y: 0 });
  });

  it('drops pending fire/mine edges on blur rather than firing them later', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new Event('blur'));

    const s = controller.sample();
    expect(s.fire).toBe(false);
    expect(s.mine).toBe(false);
  });
});

describe('createInputController — HUD control interop', () => {
  it('does not swallow arrow keys aimed at a focused form control', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    const slider = document.createElement('input');
    slider.type = 'range';
    document.body.appendChild(slider);
    slider.focus();

    const ev = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
      bubbles: true,
    });
    slider.dispatchEvent(ev);

    // The slider must keep its default arrow-key behavior...
    expect(ev.defaultPrevented).toBe(false);
    // ...and the keypress must not also drive the tank.
    expect(controller.sample().move).toEqual({ x: 0, y: 0 });

    slider.remove();
  });

  it('does not drop a mine when Space activates a focused button', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();

    const ev = new KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true });
    btn.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(false);
    expect(controller.sample().mine).toBe(false);

    btn.remove();
  });

  it('still drives the tank for keys pressed with nothing focused', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
    window.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(controller.sample().move).toEqual({ x: 0, y: -1 });
  });
});

describe('createInputController — dispose', () => {
  it('stops responding to input after dispose', () => {
    const target = makeTarget();
    const c = createInputController(target, echoGround);

    c.dispose();

    // Post-dispose events must be ignored.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 99, clientY: 99 }));
    window.dispatchEvent(new Event('blur'));

    const s = c.sample();
    expect(s.move).toEqual({ x: 0, y: 0 });
    expect(s.fire).toBe(false);
    expect(s.aim).toEqual({ x: 0, y: 0 });
  });
});

describe('createInputController — focus does not steal the tank', () => {
  it('still drives after the player has used a HUD control', () => {
    // e.target on a KeyboardEvent is the FOCUSED element, and the guard that stops
    // WASD from typing into text fields rejected every interactive element. Clicking
    // the mute button or dragging the volume slider leaves it focused, so every
    // subsequent keypress was discarded and the tank became undriveable until the
    // player happened to click the canvas again.
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    const slider = document.createElement('input');
    slider.type = 'range';
    document.body.appendChild(slider);
    slider.focus();

    // Keys arriving while the slider holds focus, exactly as the browser delivers them.
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    expect(controller.sample().move.y).not.toBe(0);

    slider.remove();
  });

  it('still lets a text field have its keystrokes', () => {
    // The guard exists for a real reason; typing "was" into a field must not drive.
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    const text = document.createElement('input');
    text.type = 'text';
    document.body.appendChild(text);
    text.focus();

    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    expect(controller.sample().move.y).toBe(0);

    text.remove();
  });
});

describe('createInputController — clearing queued presses', () => {
  it('drops a latched mine/fire press without touching held movement', () => {
    // Found in review: a Space pressed while the game is HOTKEY-paused latched here
    // (the driver stops sampling, and only sample() resets the latch) and dropped a
    // mine on the first tick after resume. The blur path was already safe -- window
    // blur calls releaseAll -- but Esc/P pause never cleared anything.
    const input = createInputController(makeTarget(), (x, y) => ({ x, y }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));

    input.clearQueuedPresses();

    const s = input.sample();
    expect(s.mine).toBe(false);
    expect(s.fire).toBe(false);
    // Held movement is NOT cleared: the key is physically still down on resume.
    expect(s.move.y).not.toBe(0);
    input.dispose();
  });

  it('the same press without a clear DOES mine — the latch this exists to drop', () => {
    const input = createInputController(makeTarget(), (x, y) => ({ x, y }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(input.sample().mine).toBe(true);
    input.dispose();
  });
});

// ---- Touch ------------------------------------------------------------------------
//
// jsdom preserves pointerId/pointerType/clientX/clientY on a constructed PointerEvent
// (verified before these were written), so the wiring can be driven faithfully. It does
// NOT implement setPointerCapture, which is one reason the controller tracks by
// pointerId at the window instead.

/** Viewport width the left/right split is measured against. jsdom defaults to 1024. */
const VIEWPORT = 1024;
const LEFT = 200; // comfortably in the driving half
const RIGHT = 800; // comfortably in the aiming half

function touch(
  el: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  opts: { id?: number; x: number; y: number; kind?: string },
): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      pointerId: opts.id ?? 1,
      pointerType: opts.kind ?? 'touch',
      clientX: opts.x,
      clientY: opts.y,
      bubbles: true,
    }),
  );
}

describe('createInputController — touch', () => {
  it('drives from a thumb dragged in the left half', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    touch(target, 'pointerdown', { x: LEFT, y: 300 });
    expect(controller.sample().move, 'a thumb that has not moved is not a direction').toEqual({
      x: 0,
      y: 0,
    });

    // Straight up the screen, past the radius: full speed NORTH, which is -y.
    touch(window, 'pointermove', { x: LEFT, y: 300 - 200 });
    const move = controller.sample().move;
    expect(move.y).toBeCloseTo(-1, 6);
    expect(move.x).toBeCloseTo(0, 6);
  });

  it('stops when the thumb lifts, and when the gesture is cancelled', () => {
    // Both endings matter: pointercancel is what a browser sends when it decides the
    // gesture is a scroll or the app is backgrounded, and it is NOT followed by a
    // pointerup. Handling only `up` leaves the tank driving into a wall.
    for (const ending of ['pointerup', 'pointercancel'] as const) {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      touch(target, 'pointerdown', { x: LEFT, y: 300 });
      touch(window, 'pointermove', { x: LEFT, y: 100 });
      expect(controller.sample().move.y, ending).toBeLessThan(0);

      touch(window, ending, { x: LEFT, y: 100 });
      expect(controller.sample().move, ending).toEqual({ x: 0, y: 0 });
      controller.dispose();
      controller = null;
    }
  });

  it('aims where the right thumb lands, and firing is that same touch', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    const s = controller.sample();
    expect(s.aim).toEqual({ x: RIGHT, y: 250 }); // echoGround passes coords through
    expect(s.fire, 'a tap on the aiming half must shoot').toBe(true);
  });

  it('re-aims on a drag without firing again', () => {
    // Otherwise holding to adjust aim would empty the magazine. Only the initial touch
    // pulls the trigger; sample() clears the latch, so the drag must not re-set it.
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    expect(controller.sample().fire).toBe(true); // consumes the latch

    touch(window, 'pointermove', { x: RIGHT + 40, y: 260 });
    const s = controller.sample();
    expect(s.aim).toEqual({ x: RIGHT + 40, y: 260 });
    expect(s.fire, 'dragging to re-aim fired a second shot').toBe(false);
  });

  it('drives and aims at the same time, with the thumbs interleaved', () => {
    // The whole point of tracking by pointerId. The browser interleaves moves from both
    // thumbs, and a controller keyed on "the last pointer" would have the aim thumb
    // steering the tank.
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    touch(target, 'pointerdown', { id: 1, x: LEFT, y: 300 });
    touch(target, 'pointerdown', { id: 2, x: RIGHT, y: 200 });
    touch(window, 'pointermove', { id: 1, x: LEFT, y: 100 }); // drive north
    touch(window, 'pointermove', { id: 2, x: RIGHT + 10, y: 210 }); // re-aim
    touch(window, 'pointermove', { id: 1, x: LEFT, y: 100 }); // drive again

    const s = controller.sample();
    expect(s.move.y, 'the aiming thumb stole the stick').toBeCloseTo(-1, 6);
    expect(s.aim, 'the driving thumb moved the aim').toEqual({ x: RIGHT + 10, y: 210 });
  });

  it('lets the aim thumb lift without stopping the tank', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    touch(target, 'pointerdown', { id: 1, x: LEFT, y: 300 });
    touch(window, 'pointermove', { id: 1, x: LEFT, y: 100 });
    touch(target, 'pointerdown', { id: 2, x: RIGHT, y: 200 });
    touch(window, 'pointerup', { id: 2, x: RIGHT, y: 200 });

    expect(controller.sample().move.y, 'lifting the aim thumb stopped the tank').toBeLessThan(0);
  });

  it('ignores a mouse pointer, so the desktop path is untouched', () => {
    // pointerdown fires for a mouse too. Without the filter, a left-half CLICK would
    // latch a virtual stick that no mouse movement could ever release.
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    touch(target, 'pointerdown', { x: LEFT, y: 300, kind: 'mouse' });
    touch(window, 'pointermove', { x: LEFT, y: 100, kind: 'mouse' });
    expect(controller.sample().move).toEqual({ x: 0, y: 0 });
  });

  it('releases a held thumb when the tab is hidden', () => {
    // The same failure as a swallowed keyup: switch apps mid-drive and the pointerup is
    // delivered elsewhere, leaving the stick held and the tank driving forever.
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    touch(target, 'pointerdown', { x: LEFT, y: 300 });
    touch(window, 'pointermove', { x: LEFT, y: 100 });
    expect(controller.sample().move.y).toBeLessThan(0);

    window.dispatchEvent(new Event('blur'));
    expect(controller.sample().move).toEqual({ x: 0, y: 0 });
  });

  it('splits on the live viewport width, so a rotation re-splits', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    // x=600 is the AIMING half at 1024 wide...
    touch(target, 'pointerdown', { id: 1, x: 600, y: 200 });
    expect(controller.sample().fire, 'x=600 should aim at 1024 wide').toBe(true);

    // ...and the DRIVING half once the device is turned and the viewport is wider.
    Object.defineProperty(window, 'innerWidth', { value: 2048, configurable: true });
    touch(target, 'pointerdown', { id: 2, x: 600, y: 200 });
    touch(window, 'pointermove', { id: 2, x: 600, y: 20 });
    expect(controller.sample().move.y, 'x=600 should drive at 2048 wide').toBeLessThan(0);
    Object.defineProperty(window, 'innerWidth', { value: VIEWPORT, configurable: true });
  });

  it('ignores the compatibility mouse events a browser synthesises after a touch', () => {
    // MEASURED on a Pixel 5 before this guard: one tap in the AIMING half put two shells
    // in flight (3 of 3 taps), and one tap in the DRIVING half fired a shell at all
    // (3 of 3) -- aimed at the player's own thumb, because the compat `mousemove`
    // reaches the window-bound handler and drags `aim` there. The burst lands ~200ms
    // after touchend, well past the 0.4s fire cooldown.
    //
    // jsdom synthesises none of this, so the sequence is dispatched by hand.
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    touch(window, 'pointerup', { x: RIGHT, y: 250 });
    expect(controller.sample().fire, 'the touch itself must fire').toBe(true);

    // ...and now the browser's compatibility burst for that same tap.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: LEFT, clientY: 90 }));
    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    const after = controller.sample();
    expect(after.fire, 'the compat mousedown fired a second shell').toBe(false);
    expect(after.aim, 'the compat mousemove dragged the aim to the thumb').toEqual({
      x: RIGHT,
      y: 250,
    });
  });

  it('cancels the touch that would synthesise them, which is the deterministic half', () => {
    // The suppression above is a clock, and a clock cannot be the whole answer. This is
    // the mechanism that stops the compat events being generated AT ALL: measured on a
    // Pixel 5, the burst went from ["mousemove@CANVAS","mousedown@CANVAS"] to [].
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    const ev = new PointerEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: RIGHT,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'the touch was not cancelled, so compat events fire').toBe(true);
  });

  it('stops suppressing the mouse once the compat window has passed', () => {
    // Pins the CONSTANT, not just the mechanism. Without advancing the clock the whole
    // window is invisible -- a test that dispatches in the same tick passes with the
    // window set to 1ms, which is how review found this unpinned while the real defect
    // was fully restored.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      touch(target, 'pointerup', { x: RIGHT, y: 100 });
      controller.sample();

      vi.advanceTimersByTime(600); // inside the window
      target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      expect(controller.sample().fire, 'a compat click 600ms later got through').toBe(false);

      vi.advanceTimersByTime(400); // 1000ms total, outside it
      target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      expect(controller.sample().fire, 'a real mouse click was still suppressed').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still serves a real mouse on a device that has never been touched', () => {
    // The other edge: the suppression is a time window, not a "this is a touch device"
    // latch, because a laptop with a touchscreen has both and must keep both.
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 34 }));
    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    const s = controller.sample();
    expect(s.aim).toEqual({ x: 12, y: 34 });
    expect(s.fire).toBe(true);
  });

  it('ignores a second thumb in the driving half rather than handing it the stick', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    touch(target, 'pointerdown', { id: 1, x: LEFT, y: 300 });
    touch(window, 'pointermove', { id: 1, x: LEFT, y: 150 }); // driving north
    touch(target, 'pointerdown', { id: 2, x: LEFT + 20, y: 500 }); // a second left thumb
    touch(window, 'pointermove', { id: 2, x: LEFT + 20, y: 560 }); // pushing SOUTH

    expect(controller.sample().move.y, 'the second thumb stole the stick').toBeLessThan(0);
  });

  it('does not let an unrelated finger lifting cancel the aim thumb', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    touch(target, 'pointerdown', { id: 1, x: RIGHT, y: 200 }); // aim thumb
    controller.sample(); // consume the fire latch
    touch(window, 'pointerup', { id: 9, x: 10, y: 10 }); // some other finger lifts
    touch(window, 'pointermove', { id: 1, x: RIGHT + 30, y: 220 });
    expect(controller.sample().aim, 'the aim thumb was released by another finger').toEqual({
      x: RIGHT + 30,
      y: 220,
    });
  });

  it('removes its pointer listeners on dispose', () => {
    const target = makeTarget();
    const c = createInputController(target, echoGround);
    c.dispose();
    // If pointermove/up survived dispose they would keep mutating a dead controller's
    // state; the observable proxy is that a fresh controller is unaffected by them.
    touch(target, 'pointerdown', { x: LEFT, y: 300 });
    touch(window, 'pointermove', { x: LEFT, y: 100 });
    controller = createInputController(target, echoGround);
    expect(controller.sample().move).toEqual({ x: 0, y: 0 });
  });
});
