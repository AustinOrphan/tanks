// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { GameHandle } from './game/loop';
import type { VersusConfig } from './game/versus-config';
import { boot, NO_WEBGL_MESSAGE, type BootDeps } from './boot';

type StartArgs = [
  HTMLCanvasElement,
  HTMLElement,
  { config: VersusConfig } | null,
  (config: VersusConfig) => void,
];

function harness(
  opts: { throwOnStart?: unknown } = {},
): {
  deps: BootDeps;
  root: HTMLElement;
  disposals: number;
  /**
   * Which fake handle (by construction order, 0-based) each `dispose()` call
   * belongs to -- a stale `const`-captured handle disposes the SAME id twice
   * instead of advancing to the next one, which a bare count (`disposals`) cannot
   * tell apart from correct behavior. See the "versus session reboot" suite below.
   */
  disposedIds: number[];
  pagehide: Array<(e: { persisted: boolean }) => void>;
  removed: Array<(e: { persisted: boolean }) => void>;
  errors: unknown[];
  startArgs: StartArgs[];
  canvasRoots: HTMLElement[];
  canvases: HTMLCanvasElement[];
  firePagehide(persisted?: boolean): void;
} {
  const root = document.createElement('div');
  const pagehide: Array<(e: { persisted: boolean }) => void> = [];
  const removed: Array<(e: { persisted: boolean }) => void> = [];
  const errors: unknown[] = [];
  const startArgs: StartArgs[] = [];
  const canvasRoots: HTMLElement[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const disposedIds: number[] = [];
  let nextId = 0;
  const box = { disposals: 0 };

  const deps: BootDeps = {
    root,
    bootCanvas: (r) => {
      canvasRoots.push(r);
      // Mirrors render/canvas.ts's real bootCanvas: appended into the root, not just
      // handed back -- so a reboot's "the dead canvas was removed" assertion has a
      // real DOM relationship to check.
      const canvas = document.createElement('canvas');
      r.appendChild(canvas);
      canvases.push(canvas);
      return canvas;
    },
    startGame: (canvas, uiRoot, versus, requestVersusSession): GameHandle => {
      startArgs.push([canvas, uiRoot, versus, requestVersusSession]);
      if ('throwOnStart' in opts) throw opts.throwOnStart;
      const id = nextId++;
      return {
        dispose(): void {
          box.disposals += 1;
          disposedIds.push(id);
        },
      };
    },
    host: {
      addEventListener(_type, fn): void {
        pagehide.push(fn);
      },
      removeEventListener(_type, fn): void {
        removed.push(fn);
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
    disposedIds,
    pagehide,
    removed,
    errors,
    startArgs,
    canvasRoots,
    canvases,
    firePagehide(persisted = false): void {
      for (const p of pagehide) p({ persisted });
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

  it('does NOT dispose when the page is only going into the bfcache', () => {
    // persisted=true means FROZEN, not destroyed: the page comes back intact,
    // rAF and all. Disposing here is what left a dead canvas behind the Back
    // button. The old `{ once: true }` did not help -- it only stopped a second
    // dispose, having already run the damaging first one.
    const h = harness();
    boot(h.deps);
    h.firePagehide(true);
    expect(h.disposals).toBe(0);
  });

  it('still disposes on a real unload', () => {
    const h = harness();
    boot(h.deps);
    h.firePagehide(false);
    expect(h.disposals).toBe(1);
  });

  it('survives a bfcache round trip and still tears down afterwards', () => {
    // The sequence the bug actually produced: freeze, restore, then eventually
    // leave for real. All three must behave.
    const h = harness();
    boot(h.deps);
    h.firePagehide(true);   // into the cache
    h.firePagehide(true);   // and again -- a page can bounce in and out
    expect(h.disposals).toBe(0);
    h.firePagehide(false);  // finally navigating away
    expect(h.disposals).toBe(1);
  });

  it('unregisters itself once it has really torn down', () => {
    // Self-removal replaces `{ once: true }`, which would have burned the
    // registration on the first bfcache entry and left a real unload with no
    // teardown at all.
    const h = harness();
    boot(h.deps);
    expect(h.removed).toHaveLength(0);
    h.firePagehide(false);
    expect(h.removed).toEqual([h.pagehide[0]]);
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

describe('boot: versus session reboot', () => {
  const CONFIG_A: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'random', stock: 3, friendlyFire: false };
  const CONFIG_B: VersusConfig = { mode: 'teams', players: 4, arenaId: 'arena-01', stock: 5, friendlyFire: true };

  it('boots the first session with no versus config, and hands it a requestVersusSession', () => {
    const h = harness();
    boot(h.deps);
    const [, , versus, requestVersusSession] = h.startArgs[0];
    expect(versus).toBeNull();
    expect(typeof requestVersusSession).toBe('function');
  });

  it('requesting a versus session disposes the old handle exactly once and starts a new one with the config', () => {
    // Fails if: requestVersusSession forgets to dispose the outgoing handle
    // (disposedIds would stay []) or disposes it twice (disposedIds would read
    // [0, 0]). Fails on a rebuilt lookalike config too, since `.config` is checked
    // by IDENTITY (toBe), not deep equality.
    const h = harness();
    boot(h.deps);
    const requestVersusSession = h.startArgs[0][3];
    requestVersusSession(CONFIG_A);
    expect(h.disposedIds).toEqual([0]);
    expect(h.startArgs).toHaveLength(2);
    expect(h.startArgs[1][2]).not.toBeNull();
    expect(h.startArgs[1][2]!.config).toBe(CONFIG_A);
  });

  it('a second request disposes the SECOND handle, not the first -- the stale-capture control', () => {
    // The bug this whole suite exists to catch: a `const game = deps.startGame(...)`
    // capture (this module's shape before this task) would dispose handle #0 again
    // here instead of handle #1, so disposedIds would read [0, 0], not [0, 1].
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG_A);
    h.startArgs[1][3](CONFIG_B);
    expect(h.disposedIds).toEqual([0, 1]);
    expect(h.startArgs).toHaveLength(3);
    expect(h.startArgs[2][2]!.config).toBe(CONFIG_B);
  });

  it('pagehide after a reboot disposes the CURRENT handle, not the original one', () => {
    // Same stale-capture bug, seen from the pagehide path instead of a second
    // request: a pagehide closure over the ORIGINAL handle would read disposedIds
    // as [0, 0] here (handle #0 disposed twice) instead of [0, 1].
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG_A);
    expect(h.disposedIds).toEqual([0]); // the reboot's own dispose of handle #0
    h.firePagehide(false);
    expect(h.disposedIds).toEqual([0, 1]);
  });

  it('does not dispose the rebooted session when the page only goes into the bfcache', () => {
    // The bfcache guard (this module's original reason to exist) must still hold
    // after a reboot, not just for the first session.
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG_A);
    h.firePagehide(true);
    expect(h.disposedIds).toEqual([0]); // only the reboot's own dispose, not pagehide's
  });

  it('builds a fresh canvas for the rebooted session and removes the dead one', () => {
    // startGameWith's teardown forces WebGL context loss on its canvas
    // (render/scene.ts); reusing that element for a second session would silently
    // render nothing, forever, in a real browser -- invisible to this whole test
    // file, which never constructs a real WebGLRenderer. A fresh element is
    // required, and the outgoing one must not linger in the DOM.
    const h = harness();
    boot(h.deps);
    const firstCanvas = h.canvases[0];
    expect(h.root.contains(firstCanvas)).toBe(true);
    h.startArgs[0][3](CONFIG_A);
    expect(h.canvases).toHaveLength(2);
    expect(h.canvases[1]).not.toBe(firstCanvas);
    expect(h.root.contains(firstCanvas)).toBe(false);
    expect(h.root.contains(h.canvases[1])).toBe(true);
    expect(h.startArgs[1][0]).toBe(h.canvases[1]);
  });
});
