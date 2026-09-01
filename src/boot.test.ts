// @vitest-environment jsdom
import { defaultSlots } from './game/versus-setup';
import { describe, it, expect, vi } from 'vitest';
import type { GameHandle } from './game/loop';
import type { VersusConfig } from './game/versus-config';
import { boot, NO_WEBGL_MESSAGE, UnsupportedRenderError, type BootDeps } from './boot';
import type { AppShell } from './game/app-shell';
import { RENDER_CAPABILITY_SUPPORTED, type RenderCapability } from './game/render-capability';
import type { RouteHost, SessionRequests, StartIntent } from './game/route-host';

type StartArgs = [
  HTMLCanvasElement,
  StartIntent,
  (config: VersusConfig) => void,
  () => void,
  AppShell,
  RouteHost,
];


/**
 * The versus config a start intent carries, or `null` for the three campaign/practice
 * kinds (issue #428).
 *
 * The `versus: {config} | null` argument these suites used to read became a four-kind
 * `StartIntent`, so "this start was for a versus match with THIS config" and "this start
 * was not a versus one" are both asked through here rather than by pattern-matching at
 * each of the eight sites.
 */
function versusConfigOf(intent: StartIntent): VersusConfig | null {
  return intent.kind === 'versus' ? intent.config : null;
}

function harness(
  opts: {
    throwOnStart?: unknown;
    throwOnAppSettings?: unknown;
    /**
     * What the shell's capability probe answered (issue #470). Defaults to supported, so
     * every suite that predates the probe keeps driving the path it was written for.
     */
    render?: RenderCapability;
  } = {},
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
  /** Which session (by construction order) was SHOWN, in order (issue #428). */
  enteredIds: number[];
  /** How many times the page's route UI was built. Must be 1, however many sessions run. */
  routeHostBuilds: number;
  /** ...and disposed. Only the page teardown may. */
  routeHostDisposals: number;
  /** The root each route host was built in. */
  routeHostRoots: HTMLElement[];
  /** The application-level start requests boot handed the route UI (issue #468). */
  sessionRequests: SessionRequests[];
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
  const enteredIds: number[] = [];
  let nextId = 0;
  const routeHostRoots: HTMLElement[] = [];
  const sessionRequests: SessionRequests[] = [];
  const box = {
    disposals: 0,
    appSettingsBuilds: 0,
    appSettingsDisposals: 0,
    routeHostBuilds: 0,
    routeHostDisposals: 0,
  };
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
    // Carried on the fake rather than defaulted inside boot: `boot()` reads it on every
    // call, so a shell that lacked it would make every suite in this file throw a
    // TypeError on the line that asks -- which is the point. The field is not optional
    // production state that boot can shrug off.
    render: opts.render ?? RENDER_CAPABILITY_SUPPORTED,
  } as unknown as AppShell;

  /**
   * A stand-in for the page's ONE route UI (issue #468), the same shape and for the same
   * reason as the shell above: identity across every session is the assertion, because a
   * fresh one per session is the pre-#468 defect -- a HUD rebuilt on every Campaign<->
   * Versus switch -- wearing a new shape.
   *
   * `attach` returns a slot that records nothing: `boot()` never calls it, and the tests
   * that DO drive a slot use the real `createRouteHost` (route-host.test.ts) rather than
   * this.
   */
  const routeHost = {
    dispose(): void {
      box.routeHostDisposals += 1;
    },
  } as unknown as RouteHost;

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
    createRouteHost: (r, _shell, requests): RouteHost => {
      box.routeHostBuilds += 1;
      routeHostRoots.push(r);
      sessionRequests.push(requests);
      return routeHost;
    },
    startGame: (canvas, versus, requestVersusSession, requestCampaignSession, settings, host): GameHandle => {
      startArgs.push([canvas, versus, requestVersusSession, requestCampaignSession, settings, host]);
      if ('throwOnStart' in opts) throw opts.throwOnStart;
      const id = nextId++;
      return {
        // Recorded by id, like the disposals: "every session was revealed" and "the FIRST
        // one was revealed four times" are different facts, and only the ledger separates
        // them (issue #428).
        enterGameplay(): void {
          enteredIds.push(id);
        },
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
    get routeHostBuilds(): number {
      return box.routeHostBuilds;
    },
    get routeHostDisposals(): number {
      return box.routeHostDisposals;
    },
    routeHostRoots,
    sessionRequests,
    disposedIds,
    enteredIds,
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


/**
 * `boot()`, and then the Continue gesture -- which is what `boot()` itself used to do
 * (issue #428).
 *
 * Driven through the REAL seam boot handed the route UI, not by calling the session host
 * directly: the whole of #428 is that a session exists only because a start request
 * reached that seam, and a helper that reached around it would leave the wiring untested
 * while every count below stayed green.
 *
 * Every suite that predates #428 uses this, so each keeps asserting what it was written
 * to assert -- the difference is that the session it asserts about is now the result of a
 * gesture rather than of the page having loaded.
 */
function bootAndStart(h: ReturnType<typeof harness>): void {
  boot(h.deps);
  h.sessionRequests[0]?.requestStart({ kind: 'campaign-continue' });
}

describe('boot: the happy path', () => {
  it('builds the canvas in the root, and starts the game with both', () => {
    const h = harness();
    bootAndStart(h);
    expect(h.canvasRoots).toEqual([h.root]);
    const [canvas] = h.startArgs[0];
    expect(canvas.tagName).toBe('CANVAS');
    // The ui root moved to the route host (issue #468): a session no longer takes one,
    // because the only thing it ever did with it was build a HUD.
    expect(h.routeHostRoots).toEqual([h.root]);
  });

  it('registers teardown so the loop and the GL context do not outlive the page', () => {
    // This was once unreachable: nothing ever called dispose, so the frame
    // loop, the window listeners and the GL context leaked on navigation.
    const h = harness();
    bootAndStart(h);
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
    bootAndStart(h);
    h.firePagehide(true);
    expect(h.disposals).toBe(0);
  });

  it('still disposes on a real unload', () => {
    const h = harness();
    bootAndStart(h);
    h.firePagehide(false);
    expect(h.disposals).toBe(1);
  });

  it('survives a bfcache round trip and still tears down afterwards', () => {
    // The sequence the bug actually produced: freeze, restore, then eventually
    // leave for real. All three must behave.
    const h = harness();
    bootAndStart(h);
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
    bootAndStart(h);
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
    bootAndStart(h);
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
    bootAndStart(h);
    const [, , requestVersus, requestCampaign] = h.startArgs[0];
    requestVersus({ mode: 'ffa', players: 2, friendlyFire: false, arenaId: 'random', slots: defaultSlots(2) } as VersusConfig);
    // The Campaign return builds nothing since issue #428, so the run below is
    // Continue -> Versus -> title -> Versus: three sessions rather than four.
    requestCampaign();
    requestVersus({ mode: 'ffa', players: 2, friendlyFire: false, arenaId: 'random', slots: defaultSlots(2) } as VersusConfig);

    expect(h.startArgs).toHaveLength(3);
    expect(h.appSettingsBuilds).toBe(1);
    const owners = h.startArgs.map((a) => a[4]);
    for (const owner of owners) expect(owner).toBe(owners[0]);
    expect(owners[0]).toBeDefined();
  });

  it('does NOT dispose it on a session reboot', () => {
    // The other half of the same decision. Disposing it with the session would leave
    // the next one with a dead OS motion subscription and settings that stop updating
    // after a single navigation -- which no unit test of a session could see.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][3](); // requestCampaignSession
    expect(h.disposals).toBe(1); // the session went
    expect(h.appSettingsDisposals).toBe(0); // the page's settings did not
  });

  it('disposes it exactly once when the PAGE goes away', () => {
    const h = harness();
    bootAndStart(h);
    h.firePagehide();
    expect(h.appSettingsDisposals).toBe(1);
  });

  it('keeps it alive through a bfcache freeze', () => {
    // A persisted pagehide is a FREEZE, not a destruction: the page comes back intact
    // and must come back with its settings still live and still listening to the OS.
    const h = harness();
    bootAndStart(h);
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
    bootAndStart(h);
    expect(h.root.textContent).toBe(NO_WEBGL_MESSAGE);
  });

  it('clears whatever was in the root first, so the message is not appended below it', () => {
    const h = harness({ throwOnStart: new Error('no webgl') });
    h.root.appendChild(document.createElement('canvas'));
    expect(h.root.querySelector('canvas')).not.toBeNull();
    bootAndStart(h);
    expect(h.root.querySelector('canvas')).toBeNull();
    expect(h.root.children).toHaveLength(1);
  });

  it('still reports the underlying error, so the reason is not lost', () => {
    const err = new Error('Error creating WebGL context.');
    const h = harness({ throwOnStart: err });
    bootAndStart(h);
    expect(h.errors).toEqual([err]);
  });

  it('registers its teardown even though the start failed', () => {
    // Re-anchored by issue #428. `boot()` no longer starts anything, so its own teardown
    // registration happens BEFORE any session can fail -- and it must, because the page
    // still owns a shell, a route UI and a HUD that need releasing whether or not a match
    // ever ran. What is asserted instead is that the failed start left no session to
    // dispose: `disposals` stays 0 through the teardown.
    const h = harness({ throwOnStart: new Error('no webgl') });
    bootAndStart(h);
    expect(h.pagehide).toHaveLength(1);
    h.firePagehide();
    expect(h.disposals, 'the page teardown disposed a session that never started').toBe(0);
    expect(h.routeHostDisposals, 'the page teardown skipped the route UI').toBe(1);
  });

  it('does not rethrow, so a failed start cannot take the module down with it', () => {
    const h = harness({ throwOnStart: new Error('no webgl') });
    expect(() => boot(h.deps)).not.toThrow();
  });

  it('handles a thrown non-Error without crashing the error path itself', () => {
    // Driven through the START request since issue #428: `boot()` itself no longer builds
    // a session, so a `startGame` that throws a bare string reaches the page from a HUD
    // click handler. That path has its own guard (`boot.ts`'s `showFailure`), and this is
    // what proves it is not narrower than the one it mirrors.
    const h = harness({ throwOnStart: 'a string, not an Error' });
    expect(() => bootAndStart(h)).not.toThrow();
    expect(h.errors).toEqual(['a string, not an Error']);
    expect(h.root.textContent).toBe(NO_WEBGL_MESSAGE);
  });
});

/**
 * The capability probe, read BEFORE anything gameplay-shaped is built (issue #470).
 *
 * The suite above ("boot: no WebGL") drives the OLD route to the same screen: `startGame`
 * throws, several frames into a session that has already cost a canvas. These pin the new
 * one -- the shell answered, so none of that is built at all. Both routes still exist and
 * both still land on `NO_WEBGL_MESSAGE`; what separates them is what got constructed on
 * the way, which is exactly what issue #428 needs to be able to remove.
 */
describe('boot: the shell capability probe (issue #470)', () => {
  const unsupported: RenderCapability = { webgl2: false, failure: 'no-webgl2' };

  it('shows the same explanation when the probe says this browser has no WebGL 2', () => {
    const h = harness({ render: unsupported });
    bootAndStart(h);
    expect(h.root.textContent).toContain(NO_WEBGL_MESSAGE);
  });

  /**
   * The whole point of the seam, asserted as COUNTS at the production boundary rather than
   * inferred from the screen: a page that cannot render builds no canvas and no session.
   *
   * Would fail if the `shell.render.webgl2` check in boot.ts were deleted -- this
   * harness's `startGame` does NOT throw, so boot would sail past it and both counts would
   * be 1. That is the negative control for the entire issue.
   */
  it('builds no canvas and starts no session when the probe says no', () => {
    const h = harness({ render: unsupported });
    bootAndStart(h);
    expect(h.canvases).toEqual([]);
    expect(h.startArgs).toEqual([]);
  });

  it('registers no teardown, because there is nothing to tear down', () => {
    const h = harness({ render: unsupported });
    bootAndStart(h);
    expect(h.pagehide).toEqual([]);
  });

  /**
   * The typed result reaches the error reporter, so #325's branded screen has a cause to
   * render rather than "something threw".
   *
   * Would fail if boot threw a bare `Error`, or passed `no-webgl2` for every failure.
   */
  it('reports a typed error carrying which probe branch answered', () => {
    const h = harness({ render: { webgl2: false, failure: 'probe-failed' } });
    bootAndStart(h);
    expect(h.errors).toHaveLength(1);
    const err = h.errors[0];
    expect(err).toBeInstanceOf(UnsupportedRenderError);
    expect((err as UnsupportedRenderError).failure).toBe('probe-failed');
    expect((err as UnsupportedRenderError).message).toContain('WebGL 2');
  });

  it('distinguishes the two failures rather than collapsing them', () => {
    const h = harness({ render: unsupported });
    bootAndStart(h);
    expect((h.errors[0] as UnsupportedRenderError).failure).toBe('no-webgl2');
  });

  /**
   * The probe is not a second gate on the happy path. `hasSession()` is not reachable from
   * here, so the session count stands in for it -- one session, exactly as before #470.
   */
  it('changes nothing when the probe says yes', () => {
    const h = harness();
    bootAndStart(h);
    expect(h.startArgs).toHaveLength(1);
    expect(h.canvases).toHaveLength(1);
    expect(h.errors).toEqual([]);
    expect(h.root.textContent).not.toContain(NO_WEBGL_MESSAGE);
  });

  /**
   * The probe answers ONE question, and the try/catch still covers the rest. A shell that
   * says the browser can render, over a `startGame` that throws anyway, must still land on
   * the error page -- otherwise #470 would have replaced a working boundary with a
   * narrower one.
   */
  it('still catches a session that fails for a reason the probe cannot see', () => {
    const h = harness({ throwOnStart: new Error('context lost during init') });
    bootAndStart(h);
    expect(h.root.textContent).toContain(NO_WEBGL_MESSAGE);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).not.toBeInstanceOf(UnsupportedRenderError);
  });
});

/**
 * The page's route UI (issue #468), owned here exactly as the shell is.
 *
 * The suite above pins the SHELL's once-per-page/never-per-session ownership. These are
 * the same four claims for the thing that owns the HUD, and they matter for a sharper
 * reason: the shell is invisible, so a second one only loses preferences, while a second
 * route UI means a second HUD element tree in the root and a menu that rebuilds itself on
 * every Campaign<->Versus switch.
 */
describe('boot: the page-scoped route UI (issue #468)', () => {
  const CONFIG_A: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'arena-02', stock: 3, friendlyFire: false, slots: defaultSlots(2) };

  it('builds it exactly ONCE, in the page root', () => {
    const h = harness();
    bootAndStart(h);
    expect(h.routeHostBuilds).toBe(1);
    expect(h.routeHostRoots).toEqual([h.root]);
  });

  it('hands every session the SAME instance across both reboot paths', () => {
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG_A); // a versus reboot
    h.startArgs[1][3](); // ...and back to the campaign title, which since #428 builds nothing
    h.sessionRequests[0].requestStart({ kind: 'campaign-continue' }); // ...and in again
    expect(h.startArgs).toHaveLength(3);
    for (const args of h.startArgs) {
      expect(args[5], 'a session was handed a fresh route UI').toBe(h.startArgs[0][5]);
    }
    expect(h.routeHostBuilds, 'a reboot rebuilt the page route UI').toBe(1);
  });

  it('does NOT dispose it on a session reboot', () => {
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG_A);
    expect(h.routeHostDisposals, 'a reboot tore down the menu the player is looking at').toBe(0);
  });

  it('disposes it exactly once when the PAGE goes away, after the session', () => {
    const h = harness();
    bootAndStart(h);
    expect(h.routeHostDisposals).toBe(0);
    h.firePagehide();
    expect(h.routeHostDisposals).toBe(1);
  });

  it('keeps it alive through a bfcache freeze', () => {
    // A frozen page comes back intact and must come back with its HUD still in the root.
    const h = harness();
    bootAndStart(h);
    h.firePagehide(true);
    expect(h.routeHostDisposals).toBe(0);
  });

  /**
   * The application-level start seam (issue #468).
   *
   * Boot hands the route UI two request callbacks rather than letting it reach into a
   * session, and those callbacks reach the session host. Fired here through the seam boot
   * actually built, which is what proves the late binding closed: the route UI is built
   * BEFORE the host exists, so a seam that captured `sessions` by value would forward
   * nothing forever.
   */
  it('wires the route UI\'s start requests to the session host', () => {
    const h = harness();
    bootAndStart(h);
    expect(h.sessionRequests).toHaveLength(1);

    h.sessionRequests[0].requestVersusSession(CONFIG_A);
    expect(h.startArgs, 'a Versus Start from the route UI started nothing').toHaveLength(2);
    expect(versusConfigOf(h.startArgs[1][1])).toBe(CONFIG_A);

    // ...and the Campaign request STOPS rather than starting (issue #428): returning to
    // a title screen the page owns needs no session.
    h.sessionRequests[0].requestCampaignSession();
    expect(h.startArgs, 'the campaign request started a session').toHaveLength(2);
    expect(h.canvasRoots).toHaveLength(2);
  });

  it('builds no route UI at all when the capability probe says no', () => {
    // Ordered after the gate deliberately: a browser that cannot render should not pay
    // for a HUD that `root.innerHTML = ''` is about to clear out from under it.
    const h = harness({ render: { webgl2: false, failure: 'no-webgl2' } });
    bootAndStart(h);
    expect(h.routeHostBuilds).toBe(0);
  });
});

/**
 * The page boots EMPTY (issue #428).
 *
 * Counted at the production boundary rather than described: every criterion in the issue
 * is of the form "opening X creates zero sessions/worlds/seeds", and the only honest way
 * to say that is to count what the injected seams were asked to build. `bootCanvas` and
 * `startGame` are those seams -- nothing downstream of them (a world, a seed, a driver, a
 * GL context) can exist without one of the two having been called first.
 */
describe('boot: nothing starts until the player asks (issue #428)', () => {
  const VS: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'arena-02', stock: 3, friendlyFire: false, slots: defaultSlots(2) };

  it('reaches the application UI with no session, no canvas and no world', () => {
    // The whole issue in one assertion. Before #428 both counts read 1 on a page nobody
    // had touched, and a player who opened the game and walked away paid for a running
    // match they never asked for.
    const h = harness();
    boot(h.deps);
    expect(h.routeHostBuilds, 'the application UI was not built').toBe(1);
    expect(h.startArgs, 'a session was created by the page loading').toEqual([]);
    expect(h.canvases, 'a canvas was created by the page loading').toEqual([]);
  });

  it('creates exactly one session per start gesture, and one per gesture only', () => {
    const h = harness();
    boot(h.deps);
    const requests = h.sessionRequests[0];

    requests.requestStart({ kind: 'campaign-continue' });
    expect(h.startArgs).toHaveLength(1);
    expect(h.startArgs[0][1]).toEqual({ kind: 'campaign-continue' });
    expect(h.canvases, 'one start built more than one canvas').toHaveLength(1);
  });

  /**
   * Each of the four intents reaches `startGame` unchanged, and each builds exactly one
   * session -- "no discarded precursor", in the issue's words.
   *
   * The disposal ledger is the half that says "no precursor": a boundary that built a
   * default session and then replaced it would show the same four `startArgs` and three
   * extra disposals.
   */
  it('passes each of the four intents through, one session each', () => {
    const h = harness();
    boot(h.deps);
    const requests = h.sessionRequests[0];
    const intents: StartIntent[] = [
      { kind: 'campaign-continue' },
      { kind: 'campaign-new' },
      { kind: 'practice', level: 2 },
      { kind: 'versus', config: VS },
    ];
    for (const intent of intents) requests.requestStart(intent);

    expect(h.startArgs.map((a) => a[1])).toEqual(intents);
    expect(h.canvases, 'a start built a canvas it then threw away').toHaveLength(4);
    // Three replacements, each disposing exactly its own predecessor -- not a fourth
    // disposal from a precursor nobody asked for.
    expect(h.disposedIds).toEqual([0, 1, 2]);
  });

  /**
   * Navigating the application routes creates nothing.
   *
   * Driven through the route UI's own seams rather than by asserting on a screen: the
   * criterion is about what got BUILT, and the screen is identical either way.
   */
  it('opening and leaving application routes creates nothing', () => {
    const h = harness();
    boot(h.deps);
    const requests = h.sessionRequests[0];
    for (let i = 0; i < 4; i += 1) {
      requests.requestCampaignSession(); // Campaign <-> Versus menu switching, repeatedly
    }
    expect(h.startArgs).toEqual([]);
    expect(h.canvases).toEqual([]);
  });

/**
   * A start SHOWS the match it built (issue #428).
   *
   * The gap this closes was found in a browser, not here, and that is the lesson worth
   * keeping: every count in this suite was right -- one session, one canvas, one world,
   * the correct intent -- and the game still did not start. `startGameWith` built the
   * board and left the player on the Main Menu, because the branch that used to enter
   * gameplay (`onStartRestart`'s main-menu arm) is unreachable once the click goes to the
   * start boundary instead of to the slot.
   *
   * So the assertion is not another count of what was BUILT. It is that the thing built
   * was revealed, by id, exactly once.
   */
  it('reveals the session it started, exactly once', () => {
    const h = harness();
    boot(h.deps);
    h.sessionRequests[0].requestStart({ kind: 'campaign-continue' });
    expect(h.enteredIds, 'the match was built and never shown').toEqual([0]);
  });

  it('reveals each session of a repeated start, never an earlier one twice', () => {
    // By id, not by count: a boundary that revealed the FIRST handle every time reports
    // the same total as one that advances -- the same stale-capture shape the disposal
    // ledger exists to catch.
    const h = harness();
    boot(h.deps);
    const requests = h.sessionRequests[0];
    requests.requestStart({ kind: 'campaign-continue' });
    requests.requestStart({ kind: 'campaign-new' });
    requests.requestStart({ kind: 'versus', config: VS });
    expect(h.enteredIds).toEqual([0, 1, 2]);
  });

  it('reveals nothing when the capability probe refused the start', () => {
    const h = harness({ render: { webgl2: false, failure: 'no-webgl2' } });
    boot(h.deps);
    expect(h.enteredIds).toEqual([]);
  });

  it('a failed start reaches the same message page a failed boot always has', () => {
    // The boundary that had to be added: with the eager start gone, a renderer that gets
    // its context and then fails to initialise throws out of a HUD click handler, and
    // without this guard the page would sit on a menu whose buttons silently did nothing.
    const boom = new Error('context lost during init');
    const h = harness({ throwOnStart: boom });
    boot(h.deps);
    expect(h.root.textContent, 'the page still showed a working menu').toBe('');

    h.sessionRequests[0].requestStart({ kind: 'campaign-continue' });
    expect(h.root.textContent).toContain(NO_WEBGL_MESSAGE);
    expect(h.errors).toEqual([boom]);
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
    bootAndStart(h);
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
    bootAndStart(h);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('boot: versus session reboot', () => {
  const CONFIG_A: VersusConfig = { mode: 'ffa', players: 2, arenaId: 'random', stock: 3, friendlyFire: false, slots: defaultSlots(2) };
  const CONFIG_B: VersusConfig = { mode: 'teams', players: 4, arenaId: 'arena-01', stock: 5, friendlyFire: true, slots: defaultSlots(4) };

  it('starts the first session on the intent it was ASKED for, and hands it a requestVersusSession', () => {
    // Re-anchored by issue #428: there is no "first boot" session any more, so the
    // question is no longer "what did boot decide" but "did the host pass the gesture
    // through unchanged". A host that substituted a retained versus config here would put
    // a player who pressed Continue straight into a match.
    const h = harness();
    bootAndStart(h);
    const [, intent, requestVersusSession] = h.startArgs[0];
    expect(intent).toEqual({ kind: 'campaign-continue' });
    expect(typeof requestVersusSession).toBe('function');
  });

  it('requesting a versus session disposes the old handle exactly once and starts a new one with the config', () => {
    // Fails if: requestVersusSession forgets to dispose the outgoing handle
    // (disposedIds would stay []) or disposes it twice (disposedIds would read
    // [0, 0]). Fails on a rebuilt lookalike config too, since `.config` is checked
    // by IDENTITY (toBe), not deep equality.
    const h = harness();
    bootAndStart(h);
    const requestVersusSession = h.startArgs[0][2];
    requestVersusSession(CONFIG_A);
    expect(h.disposedIds).toEqual([0]);
    expect(h.startArgs).toHaveLength(2);
    expect(versusConfigOf(h.startArgs[1][1])).not.toBeNull();
    expect(versusConfigOf(h.startArgs[1][1])).toBe(CONFIG_A);
  });

  it('a second request disposes the SECOND handle, not the first -- the stale-capture control', () => {
    // The bug this whole suite exists to catch: a `const game = deps.startGame(...)`
    // capture (this module's shape before this task) would dispose handle #0 again
    // here instead of handle #1, so disposedIds would read [0, 0], not [0, 1].
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG_A);
    h.startArgs[1][2](CONFIG_B);
    expect(h.disposedIds).toEqual([0, 1]);
    expect(h.startArgs).toHaveLength(3);
    expect(versusConfigOf(h.startArgs[2][1])).toBe(CONFIG_B);
  });

  it('pagehide after a reboot disposes the CURRENT handle, not the original one', () => {
    // Same stale-capture bug, seen from the pagehide path instead of a second
    // request: a pagehide closure over the ORIGINAL handle would read disposedIds
    // as [0, 0] here (handle #0 disposed twice) instead of [0, 1].
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG_A);
    expect(h.disposedIds).toEqual([0]); // the reboot's own dispose of handle #0
    h.firePagehide(false);
    expect(h.disposedIds).toEqual([0, 1]);
  });

  it('does not dispose the rebooted session when the page only goes into the bfcache', () => {
    // The bfcache guard (this module's original reason to exist) must still hold
    // after a reboot, not just for the first session.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG_A);
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
    bootAndStart(h);
    const firstCanvas = h.canvases[0];
    expect(h.root.contains(firstCanvas)).toBe(true);
    h.startArgs[0][2](CONFIG_A);
    expect(h.canvases).toHaveLength(2);
    expect(h.canvases[1]).not.toBe(firstCanvas);
    expect(h.root.contains(firstCanvas)).toBe(false);
    expect(h.root.contains(h.canvases[1])).toBe(true);
    expect(h.startArgs[1][0]).toBe(h.canvases[1]);
  });
});

describe('boot: the Campaign return from a versus session (Task 5b, re-anchored by #428)', () => {
  // boot's counterpart to requestVersusSession above, reached through the versus-kind
  // title screen's Campaign button (hud.ts's onCampaignOpen).
  //
  // RE-ANCHORED BY ISSUE #428, and the change is the point of the suite now. This used to
  // build a whole campaign session -- canvas, renderer, world, seed -- for the sole
  // purpose of showing a title screen. The page has owned that title screen since #468, so
  // the button now disposes the versus session and leaves the host EMPTY. Every case below
  // keeps its original claim about disposal ledgers and callback identity; what changed is
  // that the "new campaign session" half of each has become "and nothing was built".
  const CONFIG: VersusConfig = { mode: 'ffa', players: 3, arenaId: 'arena-02', stock: 4, friendlyFire: false, slots: defaultSlots(3) };
  const CONFIG_B: VersusConfig = { mode: 'teams', players: 4, arenaId: 'arena-03', stock: 2, friendlyFire: true, slots: defaultSlots(4) };

  it('the initial start is also handed a requestCampaignSession', () => {
    const h = harness();
    bootAndStart(h);
    const [, , , requestCampaignSession] = h.startArgs[0];
    expect(typeof requestCampaignSession).toBe('function');
  });

  it('disposes the versus handle and builds NOTHING in its place', () => {
    // Fails if the button still starts a session -- which, before #428, is exactly what
    // it did, and what made "boot into an empty host" impossible while the Campaign
    // button existed.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG); // -> a versus session (handle #1)
    const requestCampaignSession = h.startArgs[1][3];
    requestCampaignSession();
    expect(h.disposedIds).toEqual([0, 1]);
    expect(h.startArgs, 'the Campaign button started a session').toHaveLength(2);
    expect(h.canvasRoots, 'the Campaign button built a canvas').toHaveLength(2);
    expect(h.root.querySelectorAll('canvas'), 'the dead canvas was left behind').toHaveLength(0);
  });

  it('leaves the page able to start again afterwards', () => {
    // The other half of "builds nothing": a host that returned to the title by latching
    // itself shut would satisfy every count above and leave the player on a dead menu.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG);
    h.startArgs[1][3]();

    h.sessionRequests[0].requestStart({ kind: 'campaign-new' });
    expect(h.startArgs).toHaveLength(3);
    expect(h.startArgs[2][1]).toEqual({ kind: 'campaign-new' });
    expect(h.disposedIds, 'starting again disposed something that was already gone').toEqual([0, 1]);
  });

  it('threads the SAME requestVersusSession/requestCampaignSession functions through to a later session', () => {
    // Both reboot callbacks are the SAME function on every call (each's own doc comment
    // in session-host.ts) -- fails if either is rebuilt as a fresh closure per session,
    // which would hand the outgoing session's closure to the incoming one.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG);
    h.startArgs[1][3]();
    h.sessionRequests[0].requestStart({ kind: 'campaign-continue' });
    expect(h.startArgs[2][2]).toBe(h.startArgs[0][2]); // requestVersusSession identity
    expect(h.startArgs[2][3]).toBe(h.startArgs[1][3]); // requestCampaignSession identity
  });

  it('a second Campaign return disposes the SECOND handle, not an earlier one -- the stale-capture control', () => {
    // Same bug class the versus suite's own stale-capture test guards: a `const` capture
    // (rather than the shared reassigned `handle`/`canvas`) would dispose an earlier
    // handle a second time instead of advancing.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG); // handle #1: versus
    h.startArgs[1][3](); // back to the title -- nothing built
    h.sessionRequests[0].requestStart({ kind: 'versus', config: CONFIG_B }); // handle #2
    h.startArgs[2][3](); // back to the title again
    expect(h.disposedIds).toEqual([0, 1, 2]);
    expect(h.startArgs).toHaveLength(3);
  });

  it('pagehide after a Campaign return disposes nothing twice', () => {
    // There is no live session to tear down, and the ledger is what proves the teardown
    // did not re-dispose the one the button already took.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG);
    h.startArgs[1][3]();
    expect(h.disposedIds).toEqual([0, 1]);
    h.firePagehide(false);
    expect(h.disposedIds, 'the page teardown re-disposed a retired session').toEqual([0, 1]);
    expect(h.routeHostDisposals, 'the page teardown skipped the route UI').toBe(1);
  });

  it('does not dispose anything further when the page only goes into the bfcache', () => {
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG);
    h.startArgs[1][3]();
    h.firePagehide(true);
    expect(h.disposedIds).toEqual([0, 1]);
    expect(h.routeHostDisposals).toBe(0);
  });

  it('a later Versus Start after a Campaign return carries its OWN config', () => {
    // The retained-config pin, in the shape it is testable today: requestVersusSession
    // sets `lastVersusConfig` fresh from its OWN argument on every call and never reads a
    // stale value first (see its doc comment in session-host.ts). What this really guards
    // is that a Campaign return does not corrupt or freeze the shared `handle`/`canvas`
    // closure the next start depends on -- which matters more since #428, because the
    // return now leaves BOTH of them null rather than pointing at a fresh session.
    const h = harness();
    bootAndStart(h);
    h.startArgs[0][2](CONFIG); // versus (handle #1)
    h.startArgs[1][3](); // back to the title
    const requestVersusSession = h.startArgs[1][2];
    requestVersusSession(CONFIG_B);
    expect(h.startArgs).toHaveLength(3);
    expect(versusConfigOf(h.startArgs[2][1])).toBe(CONFIG_B);
  });
});
