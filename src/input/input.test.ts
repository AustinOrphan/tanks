// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
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

    key('keydown', 'w');
    expect(controller.sample().move).toEqual({ x: 0, y: 1 });

    key('keyup', 'w');
    key('keydown', 's');
    expect(controller.sample().move).toEqual({ x: 0, y: -1 });

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
    expect(controller.sample().move).toEqual({ x: 0, y: 1 });
  });

  it('returns an un-normalized diagonal (magnitude ~1.41)', () => {
    const target = makeTarget();
    controller = createInputController(target, echoGround);

    key('keydown', 'w');
    key('keydown', 'd');
    const move = controller.sample().move;
    expect(move).toEqual({ x: 1, y: 1 });
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
    expect(controller.sample().move).toEqual({ x: 0, y: 1 });

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
    expect(controller.sample().move).toEqual({ x: 0, y: 1 });
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
