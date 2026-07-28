// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { GameHandle } from './game/loop';
import { boot, NO_WEBGL_MESSAGE, type BootDeps } from './boot';

function harness(
  opts: { throwOnStart?: unknown } = {},
): {
  deps: BootDeps;
  root: HTMLElement;
  disposals: number;
  pagehide: Array<{ fn: () => void; opts: { once: boolean } }>;
  errors: unknown[];
  startArgs: Array<[HTMLCanvasElement, HTMLElement]>;
  canvasRoots: HTMLElement[];
  firePagehide(): void;
} {
  const root = document.createElement('div');
  const pagehide: Array<{ fn: () => void; opts: { once: boolean } }> = [];
  const errors: unknown[] = [];
  const startArgs: Array<[HTMLCanvasElement, HTMLElement]> = [];
  const canvasRoots: HTMLElement[] = [];
  const box = { disposals: 0 };

  const deps: BootDeps = {
    root,
    bootCanvas: (r) => {
      canvasRoots.push(r);
      return document.createElement('canvas');
    },
    startGame: (canvas, uiRoot): GameHandle => {
      startArgs.push([canvas, uiRoot]);
      if ('throwOnStart' in opts) throw opts.throwOnStart;
      return {
        dispose(): void {
          box.disposals += 1;
        },
      };
    },
    host: {
      addEventListener(_type, fn, o): void {
        pagehide.push({ fn, opts: o });
      },
    },
    reportError: (e) => errors.push(e),
  };

  return {
    deps,
    root,
    get disposals(): number {
      return box.disposals;
    },
    pagehide,
    errors,
    startArgs,
    canvasRoots,
    firePagehide(): void {
      for (const p of pagehide) p.fn();
    },
  };
}

describe('boot: the happy path', () => {
  it('builds the canvas in the root, and starts the game with both', () => {
    const h = harness();
    boot(h.deps);
    expect(h.canvasRoots).toEqual([h.root]);
    const [canvas, uiRoot] = h.startArgs[0];
    expect(canvas.tagName).toBe('CANVAS');
    expect(uiRoot).toBe(h.root);
  });

  it('registers teardown so the loop and the GL context do not outlive the page', () => {
    // This was once unreachable: nothing ever called dispose, so the frame
    // loop, the window listeners and the GL context leaked on navigation.
    const h = harness();
    boot(h.deps);
    expect(h.pagehide).toHaveLength(1);
    expect(h.disposals).toBe(0);
    h.firePagehide();
    expect(h.disposals).toBe(1);
  });

  it('registers that teardown as a ONE-SHOT', () => {
    // A page can fire pagehide repeatedly going into and out of the bfcache.
    // Without { once: true } the second one disposes an already-disposed game.
    const h = harness();
    boot(h.deps);
    expect(h.pagehide[0].opts).toEqual({ once: true });
  });

  it('does not render the error page when the game starts', () => {
    const h = harness();
    boot(h.deps);
    expect(h.root.textContent).toBe('');
    expect(h.errors).toHaveLength(0);
  });
});

describe('boot: no WebGL', () => {
  it('replaces the page with a readable explanation instead of a blank background', () => {
    const err = new Error('Error creating WebGL context.');
    const h = harness({ throwOnStart: err });
    boot(h.deps);
    expect(h.root.textContent).toBe(NO_WEBGL_MESSAGE);
  });

  it('clears whatever was in the root first, so the message is not appended below it', () => {
    const h = harness({ throwOnStart: new Error('no webgl') });
    h.root.appendChild(document.createElement('canvas'));
    expect(h.root.querySelector('canvas')).not.toBeNull();
    boot(h.deps);
    expect(h.root.querySelector('canvas')).toBeNull();
    expect(h.root.children).toHaveLength(1);
  });

  it('still reports the underlying error, so the reason is not lost', () => {
    const err = new Error('Error creating WebGL context.');
    const h = harness({ throwOnStart: err });
    boot(h.deps);
    expect(h.errors).toEqual([err]);
  });

  it('registers no teardown for a game that never started', () => {
    const h = harness({ throwOnStart: new Error('no webgl') });
    boot(h.deps);
    expect(h.pagehide).toHaveLength(0);
  });

  it('does not rethrow, so a failed start cannot take the module down with it', () => {
    const h = harness({ throwOnStart: new Error('no webgl') });
    expect(() => boot(h.deps)).not.toThrow();
  });

  it('handles a thrown non-Error without crashing the error path itself', () => {
    const h = harness({ throwOnStart: 'a string, not an Error' });
    expect(() => boot(h.deps)).not.toThrow();
    expect(h.errors).toEqual(['a string, not an Error']);
    expect(h.root.textContent).toBe(NO_WEBGL_MESSAGE);
  });
});

describe('boot: the message itself', () => {
  it('names WebGL and offers a way forward', () => {
    // It is the only thing a visitor on an unsupported browser ever sees.
    expect(NO_WEBGL_MESSAGE).toMatch(/WebGL/);
    expect(NO_WEBGL_MESSAGE).toMatch(/another browser|hardware acceleration/);
  });

  it('is styled to fill the viewport rather than sitting in the top-left corner', () => {
    const h = harness({ throwOnStart: new Error('no webgl') });
    boot(h.deps);
    const el = h.root.firstElementChild as HTMLElement;
    expect(el.style.height).toBe('100%');
    expect(el.style.display).toBe('flex');
  });
});

describe('boot: does not touch the global window', () => {
  it('registers its listener on the injected host, not on window', () => {
    // A test that forgot to inject would otherwise silently register on the
    // real window and leak between test files.
    const spy = vi.spyOn(window, 'addEventListener');
    const h = harness();
    boot(h.deps);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
