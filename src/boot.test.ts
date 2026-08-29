// @vitest-environment jsdom
import { defaultSlots } from './game/versus-setup';
import { describe, it, expect, vi } from 'vitest';
import type { GameHandle } from './game/loop';
import type { VersusConfig } from './game/versus-config';
import { boot, NO_WEBGL_MESSAGE, type BootDeps } from './boot';
import type { AppShell } from './game/app-shell';

type StartArgs = [
  HTMLCanvasElement,
  HTMLElement,
  { config: VersusConfig } | null,
  (config: VersusConfig) => void,
  () => void,
  AppShell,
];

function harness(
  opts: { throwOnStart?: unknown; throwOnAppSettings?: unknown } = {},
): {
  deps: BootDeps;
  appSettingsBuilds: number;
  appSettingsDisposals: number;
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
  const box = { disposals: 0, appSettingsBuilds: 0, appSettingsDisposals: 0 };
  /**
   * A stand-in for the page's ONE shell. Identity is the whole assertion: every session
   * must be handed this exact object, because a fresh one per session is the pre-#320
   * defect (mute and volume reset on the way into a versus match) and the pre-#317 one
   * (the splash replays on every switch) wearing a new shape, and nothing in
   * loop.test.ts's own fakes could see either.
   */
  const appSettings = {
    dispose(): void {
      box.appSettingsDisposals += 1;
    },
  } as unknown as AppShell;

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
    createAppShell: (): AppShell => {
      box.appSettingsBuilds += 1;
      if ('throwOnAppSettings' in opts) throw opts.throwOnAppSettings;
      return appSettings;
    },
    startGame: (canvas, uiRoot, versus, requestVersusSession, requestCampaignSession, settings): GameHandle => {
      startArgs.push([canvas, uiRoot, versus, requestVersusSession, requestCampaignSession, settings]);
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
    get appSettingsBuilds(): number {
      return box.appSettingsBuilds;
    },
    get appSettingsDisposals(): number {
      return box.appSettingsDisposals;
    },
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

describe('boot: the page-scoped settings owner', () => {
  it('builds it exactly ONCE, before the first session', () => {
    const h = harness();
    boot(h.deps);
    expect(h.appSettingsBuilds).toBe(1);
    expect(h.startArgs).toHaveLength(1);
  });

  it('hands every session the SAME instance across both reboot paths', () => {
    // The defect issue #320 names, in its structural form. Every other collaborator a
    // session owns -- audio engine, HUD, renderer, input -- is rebuilt on a reboot, and
    // rebuilding the settings owner too is exactly what made mute and volume reset on
    // the way into a versus match. Identity, not equality: a fresh owner over the same
    // localStorage would still lose an unsaved in-memory value, and would give the page
    // a second writable settings source.
    const h = harness();
    boot(h.deps);
    const [, , , requestVersus, requestCampaign] = h.startArgs[0];
    requestVersus({ mode: 'ffa', players: 2, friendlyFire: false, arenaId: 'random', slots: defaultSlots(2) } as VersusConfig);
    requestCampaign();
    requestVersus({ mode: 'ffa', players: 2, friendlyFire: false, arenaId: 'random', slots: defaultSlots(2) } as VersusConfig);

    expect(h.startArgs).toHaveLength(4);
    expect(h.appSettingsBuilds).toBe(1);
    const owners = h.startArgs.map((a) => a[5]);
    for (const owner of owners) expect(owner).toBe(owners[0]);
    expect(owners[0]).toBeDefined();
  });

  it('does NOT dispose it on a session reboot', () => {
    // The other half of the same decision. Disposing it with the session would leave
    // the next one with a dead OS motion subscription and settings that stop updating
    // after a single navigation -- which no unit test of a session could see.
    const h = harness();
    boot(h.deps);
    h.startArgs[0][4](); // requestCampaignSession
    expect(h.disposals).toBe(1); // the session went
    expect(h.appSettingsDisposals).toBe(0); // the page's settings did not
  });

  it('disposes it exactly once when the PAGE goes away', () => {
    const h = harness();
    boot(h.deps);
    h.firePagehide();
    expect(h.appSettingsDisposals).toBe(1);
  });

  it('keeps it alive through a bfcache freeze', () => {
    // A persisted pagehide is a FREEZE, not a destruction: the page comes back intact
    // and must come back with its settings still live and still listening to the OS.
    const h = harness();
    boot(h.deps);
    h.firePagehide(true);
    expect(h.appSettingsDisposals).toBe(0);
    expect(h.disposals).toBe(0);
  });

  it('shows the error page when building it throws, rather than failing silently', () => {
    // It resolves storage and probes platform capabilities; a locked-down context can
    // make either throw at the property access. That must land on the same visible
    // failure a missing WebGL context does.
    const boom = new Error('storage denied');
    const h = harness({ throwOnAppSettings: boom });
    boot(h.deps);
    expect(h.errors).toEqual([boom]);
    expect(h.root.textContent).toBe(NO_WEBGL_MESSAGE);
    expect(h.startArgs).toEqual([]);
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
  const CONFIG_A: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'random', stock: 3, friendlyFire: false, slots: defaultSlots(2) };
  const CONFIG_B: VersusConfig = { mode: 'teams', players: 4, arenaId: 'arena-01', stock: 5, friendlyFire: true, slots: defaultSlots(4) };

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

describe('boot: campaign session reboot (Task 5b)', () => {
  // A rebooted versus session's title screen otherwise offers nothing back to
  // campaign (its deps carry the versus level system for its whole life) -- this is
  // boot's symmetric counterpart to requestVersusSession above, reached through the
  // versus-kind title screen's Campaign button (hud.ts's onCampaignOpen).
  const CONFIG: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'arena-02', stock: 4, friendlyFire: false, slots: defaultSlots(3) };
  const CONFIG_B: VersusConfig = { mode: 'teams', players: 4, arenaId: 'arena-03', stock: 2, friendlyFire: true, slots: defaultSlots(4) };

  it('the initial boot call is also handed a requestCampaignSession', () => {
    const h = harness();
    boot(h.deps);
    const [, , , , requestCampaignSession] = h.startArgs[0];
    expect(typeof requestCampaignSession).toBe('function');
  });

  it('requesting a campaign session from a versus one disposes the versus handle and starts a new one with versus: null', () => {
    // Fails if requestCampaignSession passes `{ config: lastVersusConfig }` instead of
    // `null` for `versus` -- the exact copy-paste mistake requestVersusSession's own
    // body invites, and the one that would silently reboot BACK into a versus match
    // instead of a plain campaign session.
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG); // -> a versus session (handle #1)
    const requestCampaignSession = h.startArgs[1][4];
    requestCampaignSession();
    expect(h.disposedIds).toEqual([0, 1]);
    expect(h.startArgs).toHaveLength(3);
    expect(h.startArgs[2][2]).toBeNull();
  });

  it('threads the SAME requestVersusSession/requestCampaignSession functions through to the new campaign session', () => {
    // Both reboot callbacks are the SAME function on every call (each's own doc
    // comment in boot.ts) -- fails if requestCampaignSession rebuilds either as a
    // fresh closure instead of passing the two originals straight through.
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG);
    const requestCampaignSession = h.startArgs[1][4];
    requestCampaignSession();
    expect(h.startArgs[2][3]).toBe(h.startArgs[0][3]); // requestVersusSession identity
    expect(h.startArgs[2][4]).toBe(h.startArgs[1][4]); // requestCampaignSession identity
  });

  it('a second campaign request disposes the SECOND campaign-reachable handle, not an earlier one -- the stale-capture control', () => {
    // Same bug class the versus suite's own stale-capture test guards: a `const`
    // capture (rather than the shared reassigned `handle`/`canvas`) would dispose an
    // earlier handle a second time instead of advancing.
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG); // handle #1: versus
    h.startArgs[1][4](); // handle #2: campaign
    h.startArgs[2][3](CONFIG_B); // handle #3: versus again
    const requestCampaignSession = h.startArgs[3][4];
    requestCampaignSession(); // handle #4: campaign
    expect(h.disposedIds).toEqual([0, 1, 2, 3]);
    expect(h.startArgs).toHaveLength(5);
    expect(h.startArgs[4][2]).toBeNull();
  });

  it('pagehide after a campaign reboot disposes the CURRENT handle, not an earlier one', () => {
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG); // handle #1: versus
    h.startArgs[1][4](); // handle #2: campaign
    expect(h.disposedIds).toEqual([0, 1]);
    h.firePagehide(false);
    expect(h.disposedIds).toEqual([0, 1, 2]);
  });

  it('does not dispose the campaign-rebooted session when the page only goes into the bfcache', () => {
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG);
    h.startArgs[1][4]();
    h.firePagehide(true);
    expect(h.disposedIds).toEqual([0, 1]); // only the two reboots' own disposes
  });

  it('builds a fresh canvas for the campaign reboot and removes the dead one', () => {
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG); // versus reboot -> canvases[1]
    const versusCanvas = h.canvases[1];
    const requestCampaignSession = h.startArgs[1][4];
    requestCampaignSession();
    expect(h.canvases).toHaveLength(3);
    expect(h.canvases[2]).not.toBe(versusCanvas);
    expect(h.root.contains(versusCanvas)).toBe(false);
    expect(h.root.contains(h.canvases[2])).toBe(true);
    expect(h.startArgs[2][0]).toBe(h.canvases[2]);
  });

  it('a subsequent requestVersusSession after a campaign detour still boots versus with its OWN config -- the retained-lastVersusConfig pin', () => {
    // The brief's "do NOT clear lastVersusConfig" instruction, in the shape it is
    // actually testable today: requestVersusSession sets `lastVersusConfig` fresh from
    // its OWN argument on every call and never reads a stale value first (see its own
    // doc comment in boot.ts) -- so this passes whether or not requestCampaignSession
    // also clears `lastVersusConfig`, and is NOT a killing-mutation test for that
    // specific instruction. It is included anyway as a real regression check: a
    // campaign detour must not corrupt or freeze the shared `handle`/`canvas` closure
    // requestVersusSession depends on. See requestCampaignSession's own doc comment
    // in boot.ts and this task's report for why "retained, not cleared" has no
    // independently observable effect in this tree today.
    const h = harness();
    boot(h.deps);
    h.startArgs[0][3](CONFIG); // versus (handle #1)
    h.startArgs[1][4](); // campaign (handle #2)
    const requestVersusSession = h.startArgs[2][3];
    requestVersusSession(CONFIG_B);
    expect(h.startArgs).toHaveLength(4);
    expect(h.startArgs[3][2]!.config).toBe(CONFIG_B);
  });
});
