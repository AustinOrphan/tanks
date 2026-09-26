import { createGameSessionHost } from './game/session-host';
import type { GameSessionHost, GameSessionHostDeps } from './game/session-host';
import type { AppShell } from './game/app-shell';
import {
  classifyStartupFailure,
  UnsupportedRenderError,
  type FailurePoint,
} from './game/startup-failure';
import type { RouteHost, SessionRequests } from './game/route-host';
import type { Hud } from './game/hud';

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
  addEventListener(type: 'error', fn: (e: HostErrorEvent) => void): void;
  addEventListener(type: 'unhandledrejection', fn: (e: HostRejectionEvent) => void): void;
  removeEventListener(type: 'pagehide', fn: (e: PageHideEvent) => void): void;
  removeEventListener(type: 'error', fn: (e: HostErrorEvent) => void): void;
  removeEventListener(type: 'unhandledrejection', fn: (e: HostRejectionEvent) => void): void;
}

/**
 * The fields of the two uncaught-failure events boot reads (issue #690), declared for the
 * same reason as `PageHideEvent`: a node-environment test can dispatch a plain object.
 *
 * `error` is `ErrorEvent.error`, the thrown value. It is null for a cross-origin script's
 * "Script error.", which is why `message` is read as the fallback.
 */
export interface HostErrorEvent {
  readonly error?: unknown;
  readonly message?: string;
}

/** `PromiseRejectionEvent.reason`: whatever the rejected promise was rejected with. */
export interface HostRejectionEvent {
  readonly reason?: unknown;
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
   * Reload the page, for the failure screen's one recovery action (issue #325).
   *
   * INJECTED rather than calling `location.reload()` where it is used, and required
   * rather than defaulted, for the reason every other seam on this interface is: a test
   * asserts that the button DOES something, and a default would let a caller ship a
   * screen whose only affordance silently did nothing. `main.ts` binds the real one.
   */
  readonly reload: () => void;
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
  /**
   * Builds the page's application-route UI -- HUD, state machine, route controller -- ONCE
   * (issue #468).
   *
   * Injected for the same reason `createAppShell` is: the real one reaches
   * `createBrowserDeps`, a real `document` and a real `TankPreview`, and none of that is
   * reachable from a boot test. The `SessionRequests` argument is the seam the route UI's
   * Versus Start and Campaign buttons call into, handed in rather than read off a session
   * -- which is what makes those buttons work while the host is empty.
   *
   * Called INSIDE the try, and AFTER the capability gate below: a browser that cannot
   * render should not pay for a HUD it is about to have cleared out of the root.
   */
  readonly createRouteHost: (
    root: HTMLElement,
    shell: AppShell,
    requests: SessionRequests,
  ) => RouteHost;
}

/**
 * The branded failure page's styles, inline for the reason they always were: this page is
 * shown when startup did not finish, so it cannot assume anything the app would have set
 * up. It does share the document background (`index.html`) rather than painting its own,
 * so a failure looks like the game failing rather than like a different site.
 */
const PAGE_CSS =
  'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
  'gap:1rem;height:100%;padding:2rem;box-sizing:border-box;color:#d8dde6;' +
  // 'IBM Plex Sans' FIRST, ahead of the same fallback the HUD keeps. These screens replace
  // the page before the HUD exists, but the bundle has already run by the time `boot()`
  // shows one, so hud.css's @font-face is declared and the face is available.
  //
  // Not cosmetic: the screen gate captures all three of these states, and text metrics are
  // what made 38 of 42 baselines disagree between macOS and the CI runner. Left on
  // `system-ui` these three would keep disagreeing after every other screen was fixed --
  // measured, they were three of the four pre-HUD states that failed that run.
  "font:16px/1.6 'IBM Plex Sans',system-ui,sans-serif;text-align:center";
const TITLE_CSS = 'margin:0;font-size:1.25rem;font-weight:600;color:#f0f3f8';
const DETAIL_CSS = 'margin:0;max-width:34rem';
const ACTION_CSS =
  'margin-top:0.5rem;padding:0.6rem 1.4rem;font:inherit;color:#f0f3f8;' +
  'background:#2a2f38;border:1px solid #4a515e;border-radius:6px;cursor:pointer';

/**
 * The id of the holding screen `index.html` paints before any script runs (issue #325).
 *
 * Named here rather than spelled into the query below so the markup and the code that
 * retires it cannot drift apart silently -- a renamed div would otherwise leave the card
 * on screen under a working Main Menu, which no unit test that builds its own root would
 * ever see.
 */
export const BOOT_LOADING_ID = 'boot-loading';

/**
 * Re-exported from `startup-failure.ts`, where issue #325 moved it so the error and the
 * copy that explains it could live together without a cycle. Kept on `boot.ts`'s surface
 * because that is where every existing importer looks for it.
 */
export { UnsupportedRenderError } from './game/startup-failure';

export function boot(deps: BootDeps): void {
  /**
   * The shell's alert surface, once there is one (issue #325).
   *
   * A `let` assigned after `createRouteHost` returns, exactly like `sessions` below and for
   * the same reason: `showFailure` is defined before the host exists and is CALLED after,
   * and the two failure paths differ in whether a host is there to draw on. `null` is the
   * honest state during boot -- a failure then has no working shell to overlay, which is
   * also why every boot state's `presentation` is `page`.
   */
  let overlayHost: Pick<Hud, 'showMatchFailure'> | null = null;

  /**
   * Replace the page with the readable explanation, and report why.
   *
   * A named function since issue #428 rather than the tail of one `catch`, because there
   * are now TWO ways to reach it and they no longer share a stack. Boot's own failures
   * still arrive at the `catch` below; a failure while CREATING a match arrives from
   * inside a HUD click handler, long after `boot()` returned, which is a boundary that
   * did not have to exist while the only session was the eager one.
   */
  const showFailure = (err: unknown, at: FailurePoint = 'boot', retry?: () => void): void => {
    const state = classifyStartupFailure(err, at);

    // OVERLAY OR PAGE, decided by the classified state rather than by this call site
    // (issue #325, owner ruling 2026-09-11). A transient match failure keeps the working
    // shell and blocks over it; a FATAL one -- the renderer is absent, so every later
    // match fails identically -- still replaces the page, because handing the player back
    // a Main Menu would only invite them to prove it again.
    //
    // Guarded on the route host EXISTING, not merely on the presentation: a boot failure
    // can be classified before `createRouteHost` has returned, and `routeHost` is a
    // `const` assigned further down that this closure reads only when a click runs. The
    // page path is the safe fallback in both senses -- it needs nothing but the root.
    if (state.presentation === 'overlay' && overlayHost !== null) {
      // `retry` travels only on this path (issue #685). A page state is FATAL or has no
      // shell to return to, so it has nothing to retry against and keeps its one Reload.
      overlayHost.showMatchFailure(state, retry);
      // Reported on BOTH paths, and last on both, for the same reason: the player-facing
      // copy says nothing technical, so this is the only place the cause survives.
      deps.reportError(err);
      return;
    }

    deps.root.innerHTML = '';

    const page = document.createElement('div');
    page.style.cssText = PAGE_CSS;
    // ANNOUNCED, not merely drawn (issue #325). The page is replaced without any
    // navigation, so a screen reader is given no reason to re-read it; `role="alert"`
    // with `aria-live="assertive"` is what makes the swap an event. Set BEFORE the text
    // is attached, because a live region that gains its content in the same task it
    // gains its role is not reliably announced.
    page.setAttribute('role', 'alert');
    page.setAttribute('aria-live', 'assertive');

    const title = document.createElement('h1');
    title.style.cssText = TITLE_CSS;
    title.textContent = state.title;

    const detail = document.createElement('p');
    detail.style.cssText = DETAIL_CSS;
    detail.textContent = state.detail;

    // Every blocking state gets a recovery action, which is issue #325's second
    // criterion. A real <button>, so it is reachable by keyboard, by controller through
    // the browser's own focus order, and by touch -- and focused, because the page it
    // replaced may have held focus on an element that no longer exists.
    const action = document.createElement('button');
    action.type = 'button';
    action.style.cssText = ACTION_CSS;
    action.textContent = state.action;
    action.addEventListener('click', () => deps.reload());

    page.append(title, detail, action);
    deps.root.appendChild(page);
    action.focus();

    // UNCHANGED, and deliberately the last thing: the player-facing copy above says
    // nothing technical, so this is the only place the actual cause survives. Issue
    // #325 asks diagnostics to live behind Developer Tools (issue #238); until that
    // exists, the console is where a developer reads them and the page is not.
    deps.reportError(err);
  };

  // Without this the visitor stares at the page background with the reason visible only
  // in devtools -- indistinguishable from a broken deploy.
  //
  // Since issue #470 the ORDINARY no-WebGL case no longer reaches here by throwing: the
  // shell's capability probe answers first, a few lines down, and the throw it raises is
  // a typed `UnsupportedRenderError`. This boundary stays anyway, and stays wrapped
  // around `sessions.start()`, because the probe answers ONE question -- can this browser
  // give out a `webgl2` context -- and session construction can still fail for reasons it
  // does not cover: `createAppShell` resolving storage, or a `WebGLRenderer` that gets its
  // context and then fails initialising on it.
  //
  // A START that throws does not arrive here either, and no longer needs to. Every start --
  // the four menu gestures and a session's own Rematch -- goes through the session host's
  // `replace`, which cleans up and hands the throw to `onStartFailure` below (issue #685).
  // This comment used to record the Rematch half of that as an open hole.
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

    // ASKED, rather than discovered by trying (issue #470).
    //
    // Until this line the only thing that knew whether the browser could render was
    // `THREE.WebGLRenderer`'s constructor, several frames inside `sessions.start()` --
    // so finding out COST a canvas, a session, a world and a seed, all of them thrown
    // away microseconds later by the catch below. The shell now carries the answer
    // (`app-shell.ts`'s `render`), taken from a detached canvas that is already gone.
    //
    // What this changes on the unsupported path: `bootCanvas` and `startGame` are no
    // longer called at all, so nothing is appended to the root for `root.innerHTML = ''`
    // to have to clear. What it deliberately does NOT change: the player still lands on
    // exactly the same message. Issue #325 owns replacing it with a branded screen, and
    // #428 owns removing the eager `sessions.start()` on the SUPPORTED path below -- both
    // of which need this answer to exist first, which is all this line provides.
    //
    // `?? 'no-webgl2'` is unreachable through `probeRenderCapability`, which never reports
    // `webgl2: false` with a null failure. It is here because `AppShell` is an interface
    // any caller can implement, and the alternative -- a non-null assertion -- would turn
    // a hand-built shell into a TypeError on the error path.
    if (!shell.render.webgl2) throw new UnsupportedRenderError(shell.render.failure ?? 'no-webgl2');

    /**
     * The page's application-route UI (issue #468).
     *
     * Built BEFORE the session host and disposed after it, because it is the half that
     * outlives sessions: the HUD element tree, the state machine and the route
     * controller. Until this issue all three were built inside `startGameWith`, so the
     * Main Menu a player sees before touching anything cost a world, a seed and a
     * renderer to put on screen.
     *
     * The two start requests are LATE-BOUND through `sessions`, which does not exist
     * yet: the route UI's Versus Start and Campaign buttons are page-level requests, and
     * the thing that services them is the session host built two statements down. That
     * indirection is issue #468's "explicit application-level start-request seam" -- and
     * `?.` rather than an assertion because the same buttons are reachable during the
     * window before `sessions` is assigned, and a click there must do nothing rather
     * than throw. Issue #428 replaces the forwarding body; the seam stays.
     */
    let sessions: GameSessionHost | null = null;
    const routeHost = deps.createRouteHost(deps.root, shell, {
      // THE ONE PLACE a gameplay session comes into existence (issue #428). Four gestures
      // reach it -- Continue, New Game, a Practice level pick, Versus Start -- and nothing
      // else in the page can produce a world, a seed or a renderer.
      //
      // Guarded, and this guard is NEW WORK rather than a copy of the one below. While
      // `boot()` started the only session, a `WebGLRenderer` that got its context and then
      // failed to initialise threw INSIDE `boot()`'s try, and the player got the message
      // page. With the eager start gone that same failure would throw out of a HUD click
      // handler with nobody listening: the game would simply not start, silently, and the
      // page would sit on a menu whose buttons did nothing. `boot.ts` has always recorded
      // that hole for the REPLACEMENT path; issue #428 turns it into the ordinary path, so
      // it is closed here rather than left. WHAT the player should see when a match fails
      // to start is still issue #325's to design -- this only guarantees they see
      // something, and that it is the same something a failed boot has always shown.
      //
      // NO catch here any more (issue #685). The host now catches a start that throws and
      // reports it through `onStartFailure`, for this path and for a session's Rematch
      // alike, so a second catch here could only ever see a throw from DISPOSING the
      // outgoing session -- a broken release path, which is a defect to surface for the
      // same reason `requestStop` below is unguarded.
      requestStart: (intent) => sessions?.start(intent),
      requestVersusSession: (config) => sessions?.requestVersusSession(config),
      requestCampaignSession: () => sessions?.requestCampaignSession(),
      // Returning to an application route (issue #429). Unguarded by a try/catch, unlike
      // `requestStart` above, and deliberately: a START builds a renderer and a GL context
      // and can genuinely fail, while a STOP only releases what already exists. A throw
      // here would mean a disposal path is itself broken, which is a defect to surface
      // rather than paint over with the no-WebGL page.
      requestStop: () => sessions?.stopSession(),
    });

    // The application UI now exists, so the markup's holding screen has done its job
    // (issue #325). Removed HERE rather than at the end of `boot()` because this is the
    // moment it stops being true: the Main Menu is on screen from this line, and a
    // "Tanks!" card left over it would be a second thing claiming the viewport.
    //
    // Not needed on the failure paths -- `showFailure` clears the whole root -- and
    // harmless if the element is absent, which it is in every test that builds its own
    // root rather than serving `index.html`.
    deps.root.querySelector(`#${BOOT_LOADING_ID}`)?.remove();



    // The replaceable half (issue #317). It owns the canvas, the running session, and
    // the two reboot seams a session calls to ask for its successor -- all three of
    // which were anonymous closures in this function until `session-host.ts`. The
    // reboot suites in boot.test.ts still drive them through `boot()`, deliberately:
    // tests that predate the extraction and still pass are what proves it preserved
    // the stale-capture, fresh-canvas and callback-identity properties they pin.
    // The shell can now be drawn over, so a transient match failure has somewhere to go
    // other than the whole page (issue #325). Assigned HERE rather than at construction so
    // the window before the HUD exists keeps the page fallback: `requestStart` is reachable
    // during it, and an overlay on a shell that is not up yet would draw on nothing.
    overlayHost = routeHost.hud;

    sessions = createGameSessionHost({
      root: deps.root,
      bootCanvas: deps.bootCanvas,
      startGame: deps.startGame,
      shell,
      routeHost,
      // THE ONE PLACE a failed start is shown (issue #685). 'match' rather than the default
      // because the game is UP: reporting "Tanks! could not start" over a Main Menu the
      // player can see working would read as the message being broken rather than the
      // match. Retry reruns the SAME descriptor through the same boundary, on a fresh
      // canvas, so a retry that fails again lands right back here.
      onStartFailure: (err, intent) => showFailure(err, 'match', () => sessions?.start(intent)),
    } satisfies GameSessionHostDeps);
    // Assigned to the `let` declared above the route host, which is what closes the loop:
    // from here on, a Versus Start click reaches this host. Every later read of
    // `sessions` in this function is on the assigned value, so the `?.`s are for the
    // construction window only.
    const host = sessions;

    /**
     * A throw during a RUNNING match (issue #690), routed to the same overlay a failed start
     * gets.
     *
     * Nothing caught these before. The host's try/catch covers building a session, and
     * `onStartFailure` covers starting one; once a match is running, a throw from input
     * sampling, a sim step or a render escaped the frame callback to the window, and the
     * driver had already queued the next frame -- so the last pose stayed on screen and the
     * same throw repeated every frame, with nothing shown. The driver now stops its own loop
     * when a frame throws; this is the half that tells the player.
     *
     * GUARDED ON A SESSION RUNNING, and that guard is also the exactly-once rule:
     * `stopSession()` empties the host before `showFailure` runs, so a second event for the
     * same failure -- an `error` followed by an `unhandledrejection`, or a frame that was
     * already in flight -- finds no session and does nothing. The same guard keeps a throw
     * boot has ALREADY handled from being reported twice: a failed start is caught and
     * shown through `onStartFailure`, and leaves the host empty.
     *
     * No Retry, unlike a failed start: a start carries the descriptor that failed, while a
     * running match that throws does not, and a Retry that rebuilt the wrong board would be
     * worse than the overlay's way back to the menu. No new failure kind or copy either --
     * `showFailure` classifies it exactly as it classifies a failed start.
     */
    const onMatchError = (err: unknown): void => {
      if (!host.hasSession()) return;
      host.stopSession();
      showFailure(err, 'match');
    };
    const onError = (e: HostErrorEvent): void => onMatchError(e.error ?? e.message);
    const onRejection = (e: HostRejectionEvent): void => onMatchError(e.reason);
    deps.host.addEventListener('error', onError);
    deps.host.addEventListener('unhandledrejection', onRejection);

    // ...and NOTHING is started (issue #428).
    //
    // This is where `sessions.start()` used to be. Every page load built a canvas, a
    // renderer, a GL context, a simulation world, a gameplay seed and a frame loop before
    // the player had seen the title screen, let alone chosen anything -- and a player who
    // opened the game and walked away paid for a running match they never asked for. The
    // page now boots into the shell-owned application UI (issue #468) with an EMPTY host,
    // and the four start gestures above are the only things that fill it.
    //
    // What made this removable, and why it could not be done alone: #468 moved the HUD,
    // the state machine and the route handlers above the session, so there is a Main Menu
    // to boot into; #470 moved the WebGL capability answer off `WEBGLRenderer`'s
    // constructor, so the support check above no longer needs a session to exist.

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
      host.dispose();
      // ...and only now the page's route UI (issue #468). This is the ONE call site: a
      // session's own teardown detaches from the route host and disposes nothing it
      // owns, because the next session needs the same HUD still on screen. Ordered after
      // the session teardown so the outgoing session has already given the slot back,
      // and before `shell.dispose()` for the same reason that one is last -- the HUD's
      // handlers can still reach settings and audio until they are gone.
      routeHost.dispose();
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
      // The page's match-error listeners go with it (issue #690): they close over a host
      // that was just disposed, and a late error on a dying document has no overlay to reach.
      deps.host.removeEventListener('error', onError);
      deps.host.removeEventListener('unhandledrejection', onRejection);
    };
    deps.host.addEventListener('pagehide', onPageHide);
  } catch (err) {
    showFailure(err);
  }
}
