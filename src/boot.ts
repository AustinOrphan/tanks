import { createGameSessionHost } from './game/session-host';
import type { GameSessionHostDeps } from './game/session-host';
import type { AppShell } from './game/app-shell';

/**
 * Everything main.ts does, with its collaborators handed in.
 *
 * main.ts itself runs at module scope against `document.getElementById('app')`,
 * so importing it *starts the game*. That made it unimportable, and therefore
 * untestable: its WebGL error path, its teardown registration and that
 * listener's `{ once: true }` were all unpinned, and mutations to them passed
 * the full CI gate.
 *
 * The same split as driver.ts: the logic moves somewhere it can be called with
 * fakes, and main.ts keeps only the wiring that names the real collaborators.
 */

/** Only what boot needs from `window`. */
export interface BootHost {
  addEventListener(type: 'pagehide', fn: (e: PageHideEvent) => void): void;
  removeEventListener(type: 'pagehide', fn: (e: PageHideEvent) => void): void;
}

/**
 * The one field of PageTransitionEvent that matters here. Declared rather than
 * using the DOM type so this module stays callable from a node-environment
 * test with a plain object.
 */
export interface PageHideEvent {
  readonly persisted: boolean;
}

export interface BootDeps {
  readonly root: HTMLElement;
  readonly bootCanvas: (root: HTMLElement) => HTMLCanvasElement;
  /**
   * `versus` is `null` for the initial campaign boot, and `{ config }` for every
   * reboot `requestVersusSession` triggers. `requestVersusSession` is the SAME function
   * on every call (the session host's own, closed over its `handle`/`canvas`) -- threaded
   * as an ARGUMENT, not stored on `BootDeps`, so main.ts's wrapper can put it on the new
   * session's `GameDeps.requestVersusSession` (loop.ts's `versusAwareDeps`) without
   * main.ts holding any state of its own. `requestCampaignSession` is the SAME shape,
   * symmetric: a versus session's Campaign button reboots BACK to a plain campaign
   * session through it, and it too is the SAME function on every call.
   *
   * `shell` is the SAME instance on every call too, and for a sharper reason than the two
   * callbacks: it is the page's only settings store and resolved `Storage` (issue #320),
   * its only audio engine, and the one place that remembers the Launch gate was already
   * dismissed (issue #317). HUD, renderer and input are still rebuilt per session, which
   * is exactly why mute and volume used to reset on the way into a versus match -- and why
   * the splash used to replay on every one. Handing the same object to every session is
   * what makes all three survive, and handing a NEW one would silently reintroduce all
   * three defects while every unit test kept passing.
   *
   * Aliased from `GameSessionHostDeps` rather than restated: `boot()` hands this field
   * straight through to the host, so two independent copies of a six-argument signature
   * could drift into a call TypeScript still accepts -- `requestVersusSession` and
   * `requestCampaignSession` are both `(config) => void`-compatible at one argument.
   */
  readonly startGame: GameSessionHostDeps['startGame'];
  readonly host: BootHost;
  readonly reportError: (err: unknown) => void;
  /**
   * Builds the page's shell -- settings/persistence, audio engine, Launch gate -- ONCE.
   *
   * Injected rather than imported so a test can drive the storage-denied, malformed and
   * future-schema paths without touching the real `localStorage`, and so the
   * same-instance-every-session property above is assertable.
   *
   * Called INSIDE the try below: it resolves storage and probes platform capabilities,
   * and a host that throws on either must land on the same error page a missing WebGL
   * context does rather than an unhandled rejection at module scope.
   */
  readonly createAppShell: () => AppShell;
}

export const NO_WEBGL_MESSAGE =
  'This game needs WebGL, which this browser is not providing. ' +
  'Try another browser, or enable hardware acceleration in its settings.';

const MESSAGE_CSS =
  'display:flex;align-items:center;justify-content:center;height:100%;' +
  'padding:2rem;color:#d8dde6;font:16px/1.6 system-ui,sans-serif;text-align:center';

export function boot(deps: BootDeps): void {
  // A WebGLRenderer constructed without WebGL support throws out of startGame,
  // which is why startGame must keep building it eagerly. Without this the
  // visitor stares at the page background with the reason visible only in
  // devtools -- indistinguishable from a broken deploy.
  //
  // `sessions.start()` is inside it for that reason and no other: the host's
  // constructor touches nothing that can fail, so the throw arrives at the call that
  // builds the first canvas and renderer. A REPLACEMENT that throws does NOT arrive
  // here -- it is raised inside a HUD click handler, long after boot() returned. That
  // is a real hole in the recovery story, measured and left alone: "unrecoverable
  // session creation failure" is issue #325's scope, and what the player should see
  // when a rematch fails to start is a product decision, not a refactor's to make.
  try {
    // Built once, before the first session, and handed to every session after it.
    // See `BootDeps.startGame`'s own comment for why "once" is the whole point.
    //
    // Before the host, the canvas was built one line ABOVE this. The order swapped
    // because the shell is now an argument to the thing that builds the canvas. The
    // only difference it can make is which failure wins when a browser would fail
    // both, and both land on the same error page below -- so it is stated here rather
    // than pinned as behaviour.
    const shell = deps.createAppShell();

    // The replaceable half (issue #317). It owns the canvas, the running session, and
    // the two reboot seams a session calls to ask for its successor -- all three of
    // which were anonymous closures in this function until `session-host.ts`. The
    // reboot suites in boot.test.ts still drive them through `boot()`, deliberately:
    // tests that predate the extraction and still pass are what proves it preserved
    // the stale-capture, fresh-canvas and callback-identity properties they pin.
    const sessions = createGameSessionHost({
      root: deps.root,
      bootCanvas: deps.bootCanvas,
      startGame: deps.startGame,
      shell,
    } satisfies GameSessionHostDeps);
    sessions.start();

    // startGame's teardown was once unreachable: nothing called it, so the
    // frame loop, the window listeners and the GL context outlived the page.
    //
    // `persisted` is the whole point. A pagehide with persisted=true means the
    // page is going into the back/forward cache -- FROZEN, not destroyed, and
    // it will be restored intact, rAF and all. Disposing there is what left a
    // permanently dead canvas behind the Back button: the page came back, the
    // game did not. The previous `{ once: true }` did not help; it only stopped
    // a SECOND dispose, having already run the damaging first one.
    //
    // Freezing is also exactly what we would want teardown to achieve, so there
    // is nothing to do on the way in and nothing to rebuild on the way out.
    const onPageHide = (e: PageHideEvent): void => {
      if (e.persisted) return;
      // The host disposes whichever session is CURRENT, which is why the reboot paths
      // could reassign it without this line changing.
      sessions.dispose();
      // The PAGE is going away, so this is the one place the shell may be disposed -- it
      // releases the OS reduced-motion listener and the audio engine the sessions only
      // ever borrowed. Ordered after the session teardown so the session's own
      // unregisters (and its `releaseAudio`) run first. Deliberately NOT in the bfcache
      // branch above: a frozen page comes back intact and must come back with its
      // settings, its audio and its dismissed splash all still live.
      shell.dispose();
      // Only now is the listener spent. Self-removal replaces `{ once: true }`,
      // which would have burned the registration on the first bfcache entry and
      // left a real unload afterwards with no teardown at all.
      deps.host.removeEventListener('pagehide', onPageHide);
    };
    deps.host.addEventListener('pagehide', onPageHide);
  } catch (err) {
    deps.root.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.cssText = MESSAGE_CSS;
    msg.textContent = NO_WEBGL_MESSAGE;
    deps.root.appendChild(msg);
    deps.reportError(err);
  }
}
