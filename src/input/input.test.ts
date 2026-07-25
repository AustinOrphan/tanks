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

    target.dispatchEvent(new MouseEvent('mousemove', { clientX: 42, clientY: 7 }));
    expect(controller.sample().aim).toEqual({ x: 42, y: 7 });
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
});

describe('createInputController — dispose', () => {
  it('stops responding to input after dispose', () => {
    const target = makeTarget();
    const c = createInputController(target, echoGround);

    c.dispose();

    // Post-dispose events must be ignored.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    target.dispatchEvent(new MouseEvent('mousemove', { clientX: 99, clientY: 99 }));

    const s = c.sample();
    expect(s.move).toEqual({ x: 0, y: 0 });
    expect(s.fire).toBe(false);
    expect(s.aim).toEqual({ x: 0, y: 0 });
  });
});
