import type { GameHandle } from './game/loop';
import type { VersusConfig } from './game/versus-config';
import type { AppSettings } from './game/app-settings';

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
   * reboot `requestVersusSession` triggers below. `requestVersusSession` is the SAME
   * function on every call (this module's own, closed over `handle`/`canvas`) --
   * threaded here, not stored on `BootDeps`, so main.ts's wrapper can put it on the
   * new session's `GameDeps.requestVersusSession` (loop.ts's `versusAwareDeps`)
   * without main.ts holding any state of its own. `requestCampaignSession` (Task 5b)
   * is the SAME shape, symmetric: a versus session's Campaign button reboots BACK to
   * a plain campaign session through it, and it too is the SAME function on every call.
   *
   * `appSettings` is the SAME instance on every call too, and for a sharper reason than
   * the two callbacks: it is the page's only settings store and only resolved `Storage`
   * (issue #320). Every other collaborator a session owns -- audio engine, HUD, renderer,
   * input -- is rebuilt per session, which is exactly why mute and volume used to reset
   * on the way into a versus match. Handing the same object to every session is what
   * makes them survive, and handing a NEW one would silently reintroduce the defect while
   * every unit test kept passing.
   */
  readonly startGame: (
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    versus: { config: VersusConfig } | null,
    requestVersusSession: (config: VersusConfig) => void,
    requestCampaignSession: () => void,
    appSettings: AppSettings,
  ) => GameHandle;
  readonly host: BootHost;
  readonly reportError: (err: unknown) => void;
  /**
   * Builds the page's settings/persistence owner, ONCE.
   *
   * Injected rather than imported so a test can drive the storage-denied, malformed and
   * future-schema paths without touching the real `localStorage`, and so the
   * same-instance-every-session property above is assertable.
   *
   * Called INSIDE the try below: it resolves storage and probes platform capabilities,
   * and a host that throws on either must land on the same error page a missing WebGL
   * context does rather than an unhandled rejection at module scope.
   */
  readonly createAppSettings: () => AppSettings;
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
  try {
    let canvas = deps.bootCanvas(deps.root);

    // Built once, before the first session, and handed to every session after it. See
    // BootDeps.startGame's own comment for why "once" is the whole point.
    const appSettings = deps.createAppSettings();

    let lastVersusConfig: VersusConfig | null = null;
    let handle: GameHandle;

    /**
     * The versus setup pane's "Start" (a later task) reaches this through
     * `GameDeps.requestVersusSession` (threaded below, and again on every reboot) to
     * put the running session into a versus match.
     *
     * `handle` and `canvas` are REASSIGNED here, not shadowed: the pagehide teardown
     * below reads both through this same closure, at the time it fires, rather than
     * a value captured once at boot -- so it always tears down the CURRENT session.
     * A `const` capture of the first handle (this module's shape before this task)
     * is the stale-capture bug boot.test.ts's reboot suite exists to catch: it would
     * dispose the ORIGINAL handle a second time on the next pagehide instead of the
     * live one, leaving the actual current session's loop, listeners and GL context
     * all still running.
     *
     * A FRESH canvas, not the outgoing one: `startGameWith`'s teardown disposes the
     * renderer, which calls `renderer.forceContextLoss()` (render/scene.ts) --
     * WebGL contexts do not come back from that on command, so a second
     * `WebGLRenderer` built on the SAME element would silently render nothing,
     * forever, in a real browser. Nothing in this test suite's fakes can see that
     * (they never construct a real `WebGLRenderer`), which is exactly why it is
     * spelled out here rather than left to be rediscovered. The dead canvas is
     * removed from the DOM so repeated reboots do not leave a stack of disconnected
     * elements behind the live one.
     */
    const requestVersusSession = (config: VersusConfig): void => {
      lastVersusConfig = config;
      handle.dispose();
      canvas.remove();
      canvas = deps.bootCanvas(deps.root);
      // `lastVersusConfig`, not the bare `config` parameter: the next session's start
      // call is handed exactly what was just recorded, one write ago -- not a second,
      // independent reference to the same object that a later refactor could split.
      handle = deps.startGame(
        canvas,
        deps.root,
        { config: lastVersusConfig },
        requestVersusSession,
        requestCampaignSession,
        appSettings,
      );
    };

    /**
     * Task 5b's symmetric counterpart: the versus-kind title screen's Campaign button
     * reaches this through `GameDeps.requestCampaignSession` to reboot BACK into a
     * plain campaign session -- same dispose/fresh-canvas/reassign shape as
     * `requestVersusSession` above (see its own doc comment for why each of those
     * matters), with `versus: null` for the `startGame` call instead of `{ config }`,
     * so the new session gets plain campaign deps (`applyVersusToDeps`'s no-versus
     * branch).
     *
     * Deliberately does NOT touch `lastVersusConfig`: nothing here reads a STALE
     * value between one `requestVersusSession` call and the next -- each sets it
     * fresh from its own `config` argument the instant it runs (see that function's
     * own comment on why `lastVersusConfig` exists as a name at all) -- so clearing
     * it here would be a no-op no test can observe today. It is left alone anyway,
     * on the chance a future prefill of a fresh campaign session's own setup pane
     * wants a "last-played match" to read from; boot.test.ts documents this rather
     * than asserting a behavior nothing yet consumes.
     */
    const requestCampaignSession = (): void => {
      handle.dispose();
      canvas.remove();
      canvas = deps.bootCanvas(deps.root);
      handle = deps.startGame(canvas, deps.root, null, requestVersusSession, requestCampaignSession, appSettings);
    };

    handle = deps.startGame(canvas, deps.root, null, requestVersusSession, requestCampaignSession, appSettings);

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
      handle.dispose();
      // The PAGE is going away, so this is the one place `appSettings` may be disposed --
      // it releases the OS reduced-motion listener the sessions only ever subscribed to.
      // Ordered after the session teardown so the session's own unregisters run first.
      // Deliberately NOT in the bfcache branch above: a frozen page comes back intact and
      // must come back with its settings still live.
      appSettings.dispose();
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
