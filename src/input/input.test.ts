// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createInputController, InputController } from './input';
import {
  AIM_PROJECTION_UNITS,
  AIM_GRID,
  STICK_RADIUS_PX,
  STICK_DEADZONE,
  FIRE_MODES,
  TAP_MAX_MS,
  DOUBLE_TAP_MAX_MS,
  DOUBLE_TAP_SLOP_PX,
} from './touch';
import { deadzoneVector, type GamepadLike } from './gamepad';
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

describe('createInputController — gamepad', () => {
  function fakePad(overrides: Partial<{ axes: number[]; buttons: boolean[] }> = {}): GamepadLike {
    const axes = overrides.axes ?? [0, 0, 0, 0];
    const pressedFlags = overrides.buttons ?? [];
    return {
      axes,
      buttons: Array.from({ length: Math.max(pressedFlags.length, 2) }, (_, i) => ({
        pressed: pressedFlags[i] ?? false,
      })),
    };
  }

  it('is completely inert with the flag off, even with a fully-active fake pad present', () => {
    // The "nothing is on unless dev is present" rule (devflags.ts), mirrored here: the
    // gamepad option must gate the merge itself, not just whether a real pad exists.
    // Fully active on purpose -- stick deflected AND a button down -- so a guard that
    // silently fails open (e.g. an accidentally-inverted `if`) cannot hide behind a fake
    // pad that was too quiet to move anything.
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ axes: [1, 1, 0, 0], buttons: [true, true] })];
    controller = createInputController(target, echoGround, { gamepad: false, getGamepads });

    key('keydown', 'd');
    const s = controller.sample();
    expect(s.move).toEqual({ x: 1, y: 0 }); // keyboard only -- gamepad move ignored
    expect(s.fire).toBe(false); // gamepad fire ignored
    expect(s.mine).toBe(false); // gamepad mine ignored
    expect(controller.gamepadConnected()).toBe(false); // the reader was never even built
  });

  it('drives move from the left stick once it clears the dead zone', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ axes: [1, 0, 0, 0] })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    expect(controller.sample().move).toEqual(deadzoneVector(1, 0));
  });

  it('leaves move on the keyboard while the stick sits inside the dead zone', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ axes: [0.05, 0.05, 0, 0] })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    key('keydown', 'd');
    expect(controller.sample().move).toEqual({ x: 1, y: 0 });
  });

  it('gamepad move beats keyboard once outside the dead zone -- the documented precedence', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ axes: [0, 1, 0, 0] })]; // pure +y
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    key('keydown', 'd'); // keyboard says +x
    const move = controller.sample().move;
    expect(move.x).toBe(0); // keyboard's x lost
    expect(move.y).toBeGreaterThan(0); // gamepad's y won
  });

  it('the touch stick still beats the gamepad, unchanged from touch-vs-keyboard precedence', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ axes: [1, 0, 0, 0] })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    // Left-half pointerdown starts the driving stick, dragged straight down (pure +y).
    target.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 80 }),
    );
    // The gamepad's stick is pure +x. If the gamepad won this slot, x would be
    // positive; it stays 0, and y (touch's own axis) is what comes through instead --
    // proof touch, not the gamepad, produced this value.
    const move = controller.sample().move;
    expect(move.x).toBe(0);
    expect(move.y).toBeGreaterThan(0);
  });

  it('an in-flight touch aim thumb beats the gamepad right stick, mirroring the move rule', () => {
    // Review finding on this PR: MOVE had touch > gamepad, AIM did not -- a deflected
    // right stick silently overwrote a live touch aim gesture every tick. The guard is
    // aimPointer, the same in-flight marker the touch scheme itself tracks. Breaks if
    // sample() writes gp.aim without the aimPointer === null check.
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ axes: [0, 0, 1, 0] })]; // right stick pure +x
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });
    controller.setTouchScheme('stick');
    controller.setPlayerPosition({ x: 0, y: 0 });

    touch(target, 'pointerdown', { x: RIGHT, y: 200 }); // aim thumb lands
    touch(window, 'pointermove', { x: RIGHT, y: 400 }); // pushed straight DOWN (+y)
    const aim = controller.sample().aim;
    // Touch pushed +y, the gamepad +x. If the gamepad won, x would be +AIM_PROJECTION_UNITS.
    expect(aim.x).toBeCloseTo(0, 6);
    expect(aim.y).toBeCloseTo(AIM_PROJECTION_UNITS, 6);
  });

  it('a deflected right stick beats mouse aim, and releasing it hands aim straight back', () => {
    // The DECISION, pinned: gamepad-vs-mouse aim is stick-wins-while-deflected --
    // holding a stick off centre is as deliberate as a touch gesture, and unlike the
    // touch thumb there is no discrete in-flight marker to arbitrate with. The moment
    // the stick recentres, gp.aim goes null and the next mouse move owns aim again.
    // Breaks if the gamepad write is dropped, or if a centred stick keeps overwriting.
    const target = makeTarget();
    let axes = [0, 0, 1, 0];
    const getGamepads = (): GamepadLike[] => [fakePad({ axes })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });
    controller.setPlayerPosition({ x: 0, y: 0 });

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 42, clientY: 7 }));
    const deflected = controller.sample().aim;
    expect(deflected.x).toBeCloseTo(AIM_PROJECTION_UNITS, 6); // stick won
    axes = [0, 0, 0, 0]; // stick released
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 42, clientY: 7 }));
    expect(controller.sample().aim).toEqual({ x: 42, y: 7 }); // mouse owns aim again
  });

  it('projects aim from the right stick, at AIM_PROJECTION_UNITS from the player position', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ axes: [0, 0, 1, 0] })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });
    controller.setPlayerPosition({ x: 3, y: 3 });

    const aim = controller.sample().aim;
    expect(aim.x).toBeCloseTo(3 + AIM_PROJECTION_UNITS, 6);
    expect(aim.y).toBeCloseTo(3, 6);
  });

  it('holds the last aim while the right stick is centred, exactly as touch does', () => {
    const target = makeTarget();
    let axes = [0, 0, 1, 0];
    const getGamepads = (): GamepadLike[] => [fakePad({ axes })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });
    controller.setPlayerPosition({ x: 0, y: 0 });

    const first = controller.sample().aim;
    axes = [0, 0, 0, 0]; // stick released, back to centre
    const second = controller.sample().aim;
    expect(second).toEqual(first);
  });

  it('fires on the tick the button transitions down, not on every tick it is held', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ buttons: [true, false] })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    expect(controller.sample().fire).toBe(true);
    expect(controller.sample().fire).toBe(false);
    expect(controller.sample().fire).toBe(false);
  });

  it('mines on its own button, independent of fire, same edge rule', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad({ buttons: [false, true] })];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    const s = controller.sample();
    expect(s.mine).toBe(true);
    expect(s.fire).toBe(false);
    expect(controller.sample().mine).toBe(false);
  });

  it('gamepad fire ORs with keyboard/mouse rather than replacing them -- a mouse click still fires', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad()]; // connected, nothing pressed
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    expect(controller.sample().fire).toBe(true);
  });

  it('gamepadConnected() reflects the reader without needing a sample() call to notice', () => {
    const target = makeTarget();
    let connected = false;
    const getGamepads = (): GamepadLike[] => (connected ? [fakePad()] : []);
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    expect(controller.gamepadConnected()).toBe(false);
    connected = true;
    controller.sample(); // the reader only advances on poll, which happens inside sample()
    expect(controller.gamepadConnected()).toBe(true);
  });

  it('tolerates getGamepads() returning [] or holes of null forever, without throwing', () => {
    const target = makeTarget();
    const getGamepads = (): (GamepadLike | null)[] => [null, null, null, null];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });

    expect(() => {
      for (let i = 0; i < 5; i++) controller!.sample();
    }).not.toThrow();
    expect(controller.gamepadConnected()).toBe(false);
  });

  it('defaults to reading the real navigator when no getGamepads override is given', () => {
    // jsdom has no Gamepad API by default (spiked for issue #114), so this proves the
    // production default path is exactly as tolerant as the injected-fake path above.
    const target = makeTarget();
    controller = createInputController(target, echoGround, { gamepad: true });
    expect(() => controller!.sample()).not.toThrow();
    expect(controller.gamepadConnected()).toBe(false);
  });

  it('disposes without error, even though it registers no listeners of its own', () => {
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [fakePad()];
    const c = createInputController(target, echoGround, { gamepad: true, getGamepads });
    expect(() => c.dispose()).not.toThrow();
    controller = null;
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

describe('createInputController — touch: fire is a separate deliberate action', () => {
  // Aiming and firing used to be the same gesture: touching the right half both aimed
  // and fired. Playtest feedback -- re-aiming with the turret near a wall put a shell
  // into it, and the ricochet came back into the player's own tank -- is why they were
  // split. These pin the split itself; the schemes' own aiming behaviour is below.

  it('touching the right half does not fire, under either scheme', () => {
    // Population: both entries TOUCH_SCHEMES actually lists, not just the default.
    for (const scheme of ['stick', 'point'] as const) {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setTouchScheme(scheme);

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      expect(controller.sample().fire, `${scheme}: pointerdown fired`).toBe(false);

      touch(window, 'pointermove', { x: RIGHT + 40, y: 260 });
      expect(controller.sample().fire, `${scheme}: dragging to re-aim fired`).toBe(false);

      touch(window, 'pointerup', { x: RIGHT + 40, y: 260 });
      expect(controller.sample().fire, `${scheme}: lifting the thumb fired`).toBe(false);

      controller.dispose();
      controller = null;
    }
  });

  it('pressFire() latches a shot as a one-shot edge, the touch button\'s only path in', () => {
    // This is what the on-screen Fire button calls (hud.ts's onFireTap -> loop.ts).
    // Same latch as the mouse and keyboard paths: sample() consumes it exactly once.
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    controller.pressFire();
    expect(controller.sample().fire).toBe(true);
    expect(controller.sample().fire).toBe(false);
  });
});

describe('createInputController — touch: point scheme', () => {
  it('unprojects where the right thumb lands, exactly as the mouse does', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('point');

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    expect(controller.sample().aim).toEqual({ x: RIGHT, y: 250 }); // echoGround passes coords through
  });

  it('re-aims on a drag, tracking the thumb exactly, without ever firing', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('point');

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    controller.sample();

    touch(window, 'pointermove', { x: RIGHT + 40, y: 260 });
    const s = controller.sample();
    expect(s.aim).toEqual({ x: RIGHT + 40, y: 260 });
    expect(s.fire, 'dragging to re-aim fired').toBe(false);
  });

  it('does not let an unrelated finger lifting cancel the aim thumb', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('point');
    touch(target, 'pointerdown', { id: 1, x: RIGHT, y: 200 }); // aim thumb
    controller.sample();
    touch(window, 'pointerup', { id: 9, x: 10, y: 10 }); // some other finger lifts
    touch(window, 'pointermove', { id: 1, x: RIGHT + 30, y: 220 });
    expect(controller.sample().aim, 'the aim thumb was released by another finger').toEqual({
      x: RIGHT + 30,
      y: 220,
    });
  });

  it('lifting the aim thumb does not recentre the turret', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('point');

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    const aimed = controller.sample().aim;
    expect(aimed).toEqual({ x: RIGHT, y: 250 });

    touch(window, 'pointerup', { x: RIGHT, y: 250 });
    expect(controller.sample().aim, 'lifting the thumb recentred the aim').toEqual(aimed);
  });
});

describe('createInputController — touch: stick scheme', () => {
  it('is the default scheme', () => {
    // touchIndicator().scheme is the only externally observable reading of the internal
    // default; setTouchScheme has never been called on this controller.
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    expect(controller.touchIndicator().scheme).toBe('stick');
  });

  it('projects the aim exactly AIM_PROJECTION_UNITS from the player, in the pushed direction', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('stick'); // explicit, though it is also the default
    controller.setPlayerPosition({ x: 5, y: -3 });

    touch(target, 'pointerdown', { x: RIGHT, y: 200 });
    // Push straight right, well past the dead zone and the stick's own radius.
    touch(window, 'pointermove', { x: RIGHT + 200, y: 200 });
    const aim = controller.sample().aim;
    expect(aim.x).toBeCloseTo(5 + AIM_PROJECTION_UNITS, 6);
    expect(aim.y).toBeCloseTo(-3, 6);

    // A diagonal push changes the DIRECTION but must land the same reach from the
    // player -- the projection distance is constant regardless of how hard the thumb
    // is thrown, which is the property AIM_PROJECTION_UNITS exists to guarantee.
    // Precision loosened from 6dp to 1dp by AIM_GRID's arrival: aim.x/aim.y are now each
    // independently snapped to a 0.01 grid, so a diagonal's distance from the player can
    // be off by up to sqrt(2) * AIM_GRID/2 ~= 0.00707 (measured here: 0.000959) -- well
    // inside 1dp's 0.05 tolerance, which a real projection bug (off by whole units, not
    // grid noise) would still fail.
    touch(window, 'pointermove', { x: RIGHT + 200, y: 400 });
    const aim2 = controller.sample().aim;
    expect(Math.hypot(aim2.x - 5, aim2.y - -3)).toBeCloseTo(AIM_PROJECTION_UNITS, 1);
  });

  it('holds the last aim inside the dead zone rather than snapping it away', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setPlayerPosition({ x: 0, y: 0 }); // scheme defaults to 'stick'

    touch(target, 'pointerdown', { x: RIGHT, y: 200 });
    // Well past the dead zone: establishes a real aim in the +x direction.
    touch(window, 'pointermove', { x: RIGHT + 30, y: 200 });
    const established = controller.sample().aim;
    expect(established.x).toBeGreaterThan(0);

    // Back inside the dead zone (STICK_DEADZONE * STICK_RADIUS_PX ~= 10px of travel).
    // The mutation this guards: applyAimGesture snapping `aim` to {0,0} or to the
    // player position whenever the throw reads as "no direction".
    const insideDeadZone = STICK_DEADZONE * STICK_RADIUS_PX - 2;
    touch(window, 'pointermove', { x: RIGHT + insideDeadZone, y: 200 });
    expect(
      controller.sample().aim,
      'the dead zone snapped the aim instead of holding it',
    ).toEqual(established);
  });

  it('lifting the aim thumb does not recentre the turret', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setPlayerPosition({ x: 0, y: 0 });

    touch(target, 'pointerdown', { x: RIGHT, y: 200 });
    touch(window, 'pointermove', { x: RIGHT + 200, y: 200 });
    const aimed = controller.sample().aim;
    expect(aimed.x).toBeGreaterThan(0);

    touch(window, 'pointerup', { x: RIGHT + 200, y: 200 });
    expect(controller.sample().aim, 'lifting the thumb recentred the turret').toEqual(aimed);
  });
});

describe('createInputController — touch: switching scheme mid-gesture', () => {
  it('drops the in-flight gesture, and a fresh touch immediately uses the new scheme', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setPlayerPosition({ x: 0, y: 0 }); // default scheme is 'stick'

    touch(target, 'pointerdown', { id: 5, x: RIGHT, y: 200 });
    touch(window, 'pointermove', { id: 5, x: RIGHT + 200, y: 200 }); // full deflection, +x
    const beforeSwitch = controller.sample().aim;
    expect(beforeSwitch.x).toBeCloseTo(AIM_PROJECTION_UNITS, 6); // from player (0,0)

    controller.setTouchScheme('point');

    // The SAME finger, still down and still moving -- but the pointer id it held
    // belonged to the dropped 'stick' gesture, so this move must now be ignored.
    touch(window, 'pointermove', { id: 5, x: RIGHT + 300, y: 200 });
    expect(
      controller.sample().aim,
      'the old gesture kept steering the aim after the scheme switched',
    ).toEqual(beforeSwitch);

    // A FRESH touch, though, is read under the NEW scheme immediately.
    touch(target, 'pointerdown', { id: 6, x: 600, y: 300 });
    expect(controller.sample().aim).toEqual({ x: 600, y: 300 }); // point: unprojected 1:1
  });
});

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
    controller.setTouchScheme('point'); // isolates the split from the aim maths
    // x=600 is the AIMING half at 1024 wide...
    touch(target, 'pointerdown', { id: 1, x: 600, y: 200 });
    expect(controller.sample().aim, 'x=600 should aim at 1024 wide').toEqual({ x: 600, y: 200 });

    // ...and the DRIVING half once the device is turned and the viewport is wider.
    Object.defineProperty(window, 'innerWidth', { value: 2048, configurable: true });
    touch(target, 'pointerdown', { id: 2, x: 600, y: 200 });
    touch(window, 'pointermove', { id: 2, x: 600, y: 20 });
    expect(controller.sample().move.y, 'x=600 should drive at 2048 wide').toBeLessThan(0);
    Object.defineProperty(window, 'innerWidth', { value: VIEWPORT, configurable: true });
  });

  it('ignores the compatibility mouse events a browser synthesises after a touch', () => {
    // MEASURED on a Pixel 5 before this guard existed (when touching still fired): one
    // tap in the AIMING half put two shells in flight (3 of 3 taps), and one tap in the
    // DRIVING half fired a shell at all (3 of 3) -- aimed at the player's own thumb,
    // because the compat `mousemove` reaches the window-bound handler and drags `aim`
    // there. The burst lands ~200ms after touchend, well past the 0.4s fire cooldown.
    // In BUTTON mode touch never fires on its own, so this isolates the thing under
    // test -- compat-event suppression -- from FireMode's tap/double-tap gestures, which
    // have their own dedicated tests below and are the one deliberate way a bare touch
    // now fires. A compat `mousedown` reaching the fire latch would still be a second,
    // accidental path in regardless of mode.
    //
    // jsdom synthesises none of this, so the sequence is dispatched by hand.
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('point');
    controller.setFireMode('button');

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    touch(window, 'pointerup', { x: RIGHT, y: 250 });
    expect(controller.sample().fire, 'touch aiming fired in button mode').toBe(false);

    // ...and now the browser's compatibility burst for that same tap.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: LEFT, clientY: 90 }));
    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    const after = controller.sample();
    expect(after.fire, 'the compat mousedown fired a shell').toBe(false);
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

  it('a thumb lifted while PAUSED does not fire on resume', () => {
    // The repo already fixed this once for the keyboard -- a Space pressed while
    // hotkey-paused dropped a mine on the first tick after resume, which is why
    // clearQueuedPresses exists. The touch gesture state added for fire modes was not
    // covered by it.
    //
    // The window-level pointer listeners keep running while paused, but the driver stops
    // calling sample(), so a `fire` latched during the pause sits unconsumed until the
    // first sample() AFTER resume -- a shot with no touch behind it, aimed wherever the
    // turret happened to be left. That is the very defect this whole rework removes,
    // arriving through a different door.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('tap');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      controller.clearQueuedPresses(); // exactly what loop.ts does on pause
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 }); // thumb lifts while paused

      expect(controller.sample().fire, 'a shot leaked across the pause').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tap from BEFORE a pause cannot pair with one after it', () => {
    // The double-tap half of the same leak: a completed tap primes the pair, the pause
    // does not clear it, and the player's first re-aiming tap after resume completes a
    // double they never made.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('double');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 }); // one tap, before the pause
      controller.sample();

      controller.clearQueuedPresses(); // pause
      vi.advanceTimersByTime(100);

      touch(target, 'pointerdown', { x: RIGHT, y: 250 }); // one fresh tap after resume
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });

      expect(controller.sample().fire, 'a stale tap paired across the pause').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tap fires ONCE, even with the compat mouse burst behind it', () => {
    // Review found this combination covered by two separate tests but never together:
    // one proves compat events are suppressed under `button` mode, the other proves a
    // tap fires -- neither proves a tap fires exactly once when the browser's synthesised
    // burst lands ~200ms later. Against a shell cap of 5, a doubled shot is expensive.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('tap');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(60);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire, 'the tap did not fire').toBe(true);

      vi.advanceTimersByTime(200); // the compat burst's usual delay
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: RIGHT, clientY: 250 }));
      target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      expect(controller.sample().fire, 'the compat burst fired a second shell').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('firing still works on the NEXT gesture after a pause voided one', () => {
    // The void is per-gesture, not a latch. Without the reset on the next press, a
    // single pause would kill tap-to-fire for the rest of the session -- silently, since
    // the button would still work and nothing else would look wrong. Mutation-proven:
    // removing the reset passes every other test in this file.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('tap');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      controller.clearQueuedPresses(); // pause, mid-gesture
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire, 'the voided gesture fired').toBe(false);

      // ...and now a gesture the player makes with the game actually running.
      vi.advanceTimersByTime(600);
      touch(target, 'pointerdown', { id: 2, x: RIGHT, y: 250 });
      vi.advanceTimersByTime(60);
      touch(window, 'pointerup', { id: 2, x: RIGHT, y: 250 });
      expect(controller.sample().fire, 'firing never recovered after the pause').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a thumb held across a pause still steers on resume', () => {
    // The other edge, and the reason the gesture is VOIDED rather than released: the
    // thumb is still physically on the glass. Dropping the pointer would leave the
    // turret unsteerable until the player lifted and replaced it -- the same mistake as
    // releasing a movement key that is still held, which clearQueuedPresses documents
    // that it deliberately does not do.
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setFireMode('tap');
    controller.setTouchScheme('point');

    touch(target, 'pointerdown', { x: RIGHT, y: 250 });
    controller.clearQueuedPresses(); // pause
    touch(window, 'pointermove', { x: RIGHT + 40, y: 300 }); // still dragging on resume

    const s = controller.sample();
    expect(s.aim, 'the held thumb stopped steering after a pause').toEqual({
      x: RIGHT + 40,
      y: 300,
    });
    expect(s.fire, 'the voided gesture still fired').toBe(false);
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

// ---- Fire modes ---------------------------------------------------------------------
//
// FireMode picks how the AIM thumb pulls the trigger (touch.ts). Fake timers control the
// gaps `isTap`/`isDoubleTap` measure via performance.now(), so the tap/drag and
// same-tick/double-tap boundaries are exercised honestly rather than at whatever gap the
// real clock happens to produce between synchronous dispatches.

describe('createInputController — fire modes: button', () => {
  it('a tap on the aim side fires nothing', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('button');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50); // well inside TAP_MAX_MS: a clean tap
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire, 'a tap fired in button mode').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createInputController — fire modes: tap', () => {
  it('a tap fires exactly once', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('tap'); // also the default, set explicitly for clarity

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire).toBe(true);
      expect(controller.sample().fire, 'the fire edge did not consume itself').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a drag does not fire -- that is aiming, not a tap', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('tap');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      // Travels well past TAP_SLOP_PX before release: a drag, not a tap.
      touch(window, 'pointermove', { x: RIGHT + 100, y: 250 });
      touch(window, 'pointerup', { x: RIGHT + 100, y: 250 });
      expect(controller.sample().fire, 'a drag fired').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a touch held too long does not fire either -- that is a thumb resting to aim', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('tap');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(TAP_MAX_MS + 1);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createInputController — fire modes: double', () => {
  it('a single tap fires nothing', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('double');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two quick taps in the SAME place fire once', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('double');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire, 'the first tap alone fired').toBe(false);

      vi.advanceTimersByTime(DOUBLE_TAP_MAX_MS - 50); // still inside the pairing window
      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(controller.sample().fire, 'the completed double-tap did not fire').toBe(true);

      // A completed double does not begin the next one: a THIRD tap right after must not
      // pair with the second half of the one that just fired.
      vi.advanceTimersByTime(50);
      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(
        controller.sample().fire,
        'a third tap paired with the already-completed double',
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two quick taps in DIFFERENT places fire nothing -- the reason double-tap is safe where a single tap is not', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('double');

      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      controller.sample();

      vi.advanceTimersByTime(50); // well inside DOUBLE_TAP_MAX_MS
      // Well past DOUBLE_TAP_SLOP_PX: a re-aim, not a second half of the same double.
      touch(target, 'pointerdown', { x: RIGHT + DOUBLE_TAP_SLOP_PX + 20, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT + DOUBLE_TAP_SLOP_PX + 20, y: 250 });
      expect(
        controller.sample().fire,
        'two taps in different places fired -- re-aiming must never shoot',
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createInputController — fire modes: pointercancel', () => {
  it('never fires, in any mode', () => {
    // Population: every mode FIRE_MODES actually lists ('button' trivially never fires
    // from the aim side at all; included anyway so the sweep is honest about what it
    // covers rather than skipping the mode where the assertion cannot fail).
    for (const mode of FIRE_MODES) {
      vi.useFakeTimers({ toFake: ['performance'] });
      try {
        const target = makeTarget();
        controller = createInputController(target, echoGround);
        controller.setFireMode(mode);

        touch(target, 'pointerdown', { x: RIGHT, y: 250 });
        vi.advanceTimersByTime(50);
        touch(window, 'pointercancel', { x: RIGHT, y: 250 });
        expect(controller.sample().fire, mode).toBe(false);
      } finally {
        vi.useRealTimers();
        controller?.dispose();
        controller = null;
      }
    }
  });

  it('does not leave a half-tap primed to pair with the next one, in double mode', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('double');

      // A tap that would otherwise prime the pairing, but it is CANCELLED.
      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointercancel', { x: RIGHT, y: 250 });
      controller.sample();

      // A real tap, quickly after, in the same spot: if the cancelled touch had
      // survived as `lastAimTap`, this would complete a double and fire.
      vi.advanceTimersByTime(50);
      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(
        controller.sample().fire,
        'the cancelled touch stayed primed and paired with the next tap',
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createInputController — fire modes: switching mid-gesture', () => {
  it('drops a pending half-double on a mode switch', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode('double');

      // First half of what would become a double-tap.
      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      controller.sample();

      // Switched away and back, still inside the pairing window -- setFireMode clears
      // the half-tap on any actual change, including a round trip.
      controller.setFireMode('button');
      controller.setFireMode('double');

      vi.advanceTimersByTime(50); // still well inside DOUBLE_TAP_MAX_MS
      touch(target, 'pointerdown', { x: RIGHT, y: 250 });
      vi.advanceTimersByTime(50);
      touch(window, 'pointerup', { x: RIGHT, y: 250 });
      expect(
        controller.sample().fire,
        'the pre-switch half survived and completed a double',
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createInputController — aim quantization', () => {
  // The one boundary all four producers converge into a single InputState: quantizeAim
  // is applied inside sample()'s return, so a universal fix rather than a per-producer
  // one is what these tests are proving.
  function isGridAligned(v: number): boolean {
    const n = v / AIM_GRID;
    return Math.abs(n - Math.round(n)) < 1e-6;
  }

  it('collapses two mouse positions inside the same grid cell to the same point', () => {
    // A ground projection fine enough that a 1px client delta is well under AIM_GRID/2
    // (0.005) in world units -- exactly the gap quantization exists to close. Raw,
    // pre-quantization these are two distinct floats (1.001 vs 1.002); this fails today.
    const fineGround = (clientX: number, clientY: number): Vec2 => ({
      x: clientX / 1000,
      y: clientY / 1000,
    });
    const target = makeTarget();
    controller = createInputController(target, fineGround);

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1001, clientY: 2001 }));
    const first = controller.sample().aim;
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1002, clientY: 2002 }));
    const second = controller.sample().aim;

    expect(second).toEqual(first);
  });

  it('snaps mouse aim to an exact multiple of AIM_GRID', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 42.567, clientY: -13.333 }));
    const aim = controller.sample().aim;
    expect(isGridAligned(aim.x), `x=${aim.x}`).toBe(true);
    expect(isGridAligned(aim.y), `y=${aim.y}`).toBe(true);
  });

  it('snaps touch point-scheme aim to an exact multiple of AIM_GRID', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('point');
    touch(target, 'pointerdown', { x: RIGHT + 0.567, y: 250.333 });
    const aim = controller.sample().aim;
    expect(isGridAligned(aim.x), `x=${aim.x}`).toBe(true);
    expect(isGridAligned(aim.y), `y=${aim.y}`).toBe(true);
  });

  it('snaps touch stick-scheme aim to an exact multiple of AIM_GRID', () => {
    // A diagonal push: dir/len * AIM_PROJECTION_UNITS on a 45-degree ratio is never
    // grid-aligned by construction, unlike the axis-aligned pushes pinned elsewhere in
    // this file.
    const target = makeTarget();
    controller = createInputController(target, echoGround);
    controller.setTouchScheme('stick');
    controller.setPlayerPosition({ x: 5, y: -3 });
    touch(target, 'pointerdown', { x: RIGHT, y: 200 });
    touch(window, 'pointermove', { x: RIGHT + 200, y: 400 });
    const aim = controller.sample().aim;
    expect(isGridAligned(aim.x), `x=${aim.x}`).toBe(true);
    expect(isGridAligned(aim.y), `y=${aim.y}`).toBe(true);
  });

  it('snaps gamepad aim to an exact multiple of AIM_GRID', () => {
    // Same diagonal-push shape, on the right stick.
    const target = makeTarget();
    const getGamepads = (): GamepadLike[] => [{ axes: [0, 0, 1, 1], buttons: [] }];
    controller = createInputController(target, echoGround, { gamepad: true, getGamepads });
    controller.setPlayerPosition({ x: 0, y: 0 });
    const aim = controller.sample().aim;
    expect(isGridAligned(aim.x), `x=${aim.x}`).toBe(true);
    expect(isGridAligned(aim.y), `y=${aim.y}`).toBe(true);
  });
});

describe('createInputController — fire modes: the FIRE button always works', () => {
  it('pressFire() latches a shot in every mode', () => {
    // Population: every mode FIRE_MODES actually lists. The whole design point of
    // FireMode is that these are ADDED gestures, never a replacement for the button.
    for (const mode of FIRE_MODES) {
      const target = makeTarget();
      controller = createInputController(target, echoGround);
      controller.setFireMode(mode);

      controller.pressFire();
      expect(controller.sample().fire, mode).toBe(true);
      expect(controller.sample().fire, `${mode}: did not consume the edge`).toBe(false);

      controller.dispose();
      controller = null;
    }
  });
});
