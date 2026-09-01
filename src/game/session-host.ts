import type { GameHandle } from './loop';
import type { VersusConfig } from './versus-config';
import type { AppShell } from './app-shell';
import type { RouteHost, StartIntent } from './route-host';

/**
 * The replaceable half of issue #317's ownership split.
 *
 * `app-shell.ts` owns what must OUTLIVE a session -- settings/persistence, the audio
 * engine, the Launch gate. This owns what must be REPLACED with one: the canvas, the
 * `GameHandle` running on it, and the two reboot seams a session calls to ask for its
 * successor. Splitting them is the point of the issue: before #401 a Campaign<->Versus
 * switch rebuilt both halves together, which is how mute, volume and the dismissed splash
 * all used to reset on the way into a versus match.
 *
 * These four boundaries were `boot.ts`'s two anonymous closures until this module. Nothing
 * about the sequence changed in the move -- every property their comments recorded is
 * restated below on the method that now owns it, and `boot.test.ts`'s two reboot suites
 * still drive `boot()` rather than this module, deliberately, so they keep proving the
 * extraction preserved them.
 */
export interface GameSessionHost {
  /**
   * Create and run a session for one explicit match-start request (issue #428).
   *
   * Until #428 this took no argument and `boot.ts` called it EAGERLY, so a page that had
   * shown nobody anything already owned a world, a seed, a driver and a GL context. It is
   * now called only from the four gestures that genuinely start a match -- Continue, New
   * Game, a Practice level pick and Versus Start -- and the intent is what decides which
   * board gets built.
   *
   * Still separate from construction, and still for the original reason: `boot.ts` builds
   * the host inside its try/catch, and a `WebGLRenderer` that fails to initialise throws
   * out of `startGame`, so the throw has to happen at a call rather than at construction.
   * Since #470 the ordinary no-WebGL case is answered before any of this.
   */
  start(intent: StartIntent): void;
  /**
   * Is a gameplay session running right now? (issue #427)
   *
   * The EMPTY state made observable. The host could always be empty -- construction builds
   * nothing and `start()` is a separate, explicit call -- but nothing outside could ask,
   * so "the shell exists with no session" was a property the code had and no test could
   * state. That is the gap this closes: `#427`'s criteria are all of the form "X still
   * works while the host has no active session", and none of them is checkable without a
   * way to assert the second half.
   *
   * Deliberately a QUESTION, not the handle. Returning the `GameHandle` would hand callers
   * the thing this module exists to own, and the one legitimate consumer -- a shell asking
   * whether to offer Resume -- needs the boolean and nothing else.
   */
  hasSession(): boolean;
  /**
   * The reboot seams, handed to every session this host starts.
   *
   * The SAME two function objects on every call, never rebuilt per session. A session
   * reaches them through `GameDeps.requestVersusSession`/`requestCampaignSession`
   * (`loop.ts`'s `versusAwareDeps`), so a fresh pair per session would hand the outgoing
   * session's closure to the incoming one and, on the next switch, tear down a handle
   * that is no longer live.
   */
  readonly requestVersusSession: (config: VersusConfig) => void;
  readonly requestCampaignSession: () => void;
  /**
   * Dispose the running session, leaving its canvas in the DOM. Idempotent.
   *
   * The canvas is deliberately NOT removed here: this is what the page teardown calls,
   * and at that point the document is going away with it. `replace` removes it, because
   * replacement is the only case where something has to be drawn afterwards -- see its
   * own comment for why the next session cannot have the old element.
   */
  stop(): void;
  /**
   * The page teardown. `stop()` plus a latch, so nothing can start a session afterwards.
   *
   * The latch is what makes a late reboot request harmless. Both seams are already in the
   * hands of a session's HUD handlers by the time `pagehide` fires, and a click that lands
   * in the same task would otherwise build a whole new session -- canvas, renderer, frame
   * loop -- onto a document on its way out, holding a GL context nothing will ever
   * dispose. Not reachable through any test fake today; latched because the cost is one
   * boolean and the failure is invisible.
   */
  dispose(): void;
}

export interface GameSessionHostDeps {
  readonly root: HTMLElement;
  readonly bootCanvas: (root: HTMLElement) => HTMLCanvasElement;
  /**
   * Builds one session on the canvas it is handed. `main.ts`'s one wrapper line, which
   * composes `versusAwareDeps` over the arguments below and calls `startGameWith`.
   *
   * `versus` is `null` for a campaign session and `{ config }` for a versus one.
   */
  readonly startGame: (
    canvas: HTMLCanvasElement,
    intent: StartIntent,
    requestVersusSession: (config: VersusConfig) => void,
    requestCampaignSession: () => void,
    shell: AppShell,
    routeHost: RouteHost,
  ) => GameHandle;
  /**
   * The page's one shell, handed to every session unchanged.
   *
   * The host BORROWS it and never disposes it -- `boot.ts`'s `pagehide` is the one owner
   * (`AppShell.dispose`'s own comment). A host that disposed the shell on a session
   * replacement would hand the next session a latched audio engine and settings that have
   * stopped reacting, with nothing thrown.
   */
  readonly shell: AppShell;
  /**
   * The page's application-route UI, handed to every session unchanged (issue #468).
   *
   * BORROWED exactly like `shell`, and for the same reason: `boot.ts` owns it and is the
   * only caller of its `dispose()`. A session takes the gameplay slot in `startGameWith`
   * and gives it back in its own teardown, so a `replace()` hands the incoming session a
   * HUD that is still on screen -- which is what stops a Campaign<->Versus switch from
   * rebuilding the whole menu, and what makes the empty state between the two a normal
   * application-route state rather than a blank page.
   */
  readonly routeHost: RouteHost;
}

export function createGameSessionHost(deps: GameSessionHostDeps): GameSessionHost {
  let canvas: HTMLCanvasElement | null = null;
  let handle: GameHandle | null = null;
  let spent = false;

  /**
   * The config the last versus request carried.
   *
   * Read only by `replace` one line after it is written, so nothing consumes a stale
   * value today. Retained anyway, and pinned by `boot.test.ts`, on the chance a fresh
   * campaign session's setup pane later wants a "last played match" to prefill from --
   * a campaign replacement deliberately does NOT clear it.
   */
  let lastVersusConfig: VersusConfig | null = null;

  /**
   * Build a session and run it. `startGameWith` fuses create and start (it calls
   * `driver.start()` before returning its handle), so this is one step rather than two;
   * naming it `create` alone would advertise a session that exists but is not running,
   * which is not a state this host can produce.
   */
  const create = (intent: StartIntent): void => {
    canvas = deps.bootCanvas(deps.root);
    handle = deps.startGame(
      canvas,
      intent,
      requestVersusSession,
      requestCampaignSession,
      deps.shell,
      deps.routeHost,
    );
  };

  /**
   * Stop the running session and start a replacement.
   *
   * A FRESH canvas, and the old one removed from the DOM. `startGameWith`'s teardown
   * disposes the renderer, which calls `renderer.forceContextLoss()` (`render/scene.ts`),
   * and a WebGL context does not come back from that on command -- so a second
   * `WebGLRenderer` built on the SAME element would silently render nothing, forever, in
   * a real browser. Nothing in the unit fakes constructs a real `WebGLRenderer`, so no
   * test can see it; it is spelled out here rather than left to be rediscovered. Removing
   * the dead element is what stops repeated switches leaving a stack of disconnected
   * canvases behind the live one.
   *
   * `handle` and `canvas` are REASSIGNED, not shadowed, so `stop()` -- and therefore the
   * page teardown that calls it -- always reaches the CURRENT session. A `const` capture
   * of the first handle is the stale-capture bug `boot.test.ts`'s two "stale-capture
   * control" tests exist to catch: it would dispose the ORIGINAL handle a second time on
   * the next teardown and leave the live session's loop, listeners and GL context all
   * still running.
   */
  const replace = (intent: StartIntent): void => {
    if (spent) return;
    stop();
    canvas?.remove();
    create(intent);
  };

  function stop(): void {
    handle?.dispose();
    handle = null;
  }

  const requestVersusSession = (config: VersusConfig): void => {
    lastVersusConfig = config;
    // `lastVersusConfig`, not the bare `config` parameter: the next session is handed
    // exactly what was just recorded, one write ago -- not a second, independent
    // reference to the same object that a later refactor could split in two.
    replace({ kind: 'versus', config: lastVersusConfig });
  };

  /**
   * A versus session's Campaign button: back to the campaign title.
   *
   * Since issue #428 this STOPS rather than replaces. Building a fresh campaign session
   * to show a title screen is precisely the eager creation #428 removes -- the page has
   * owned its own menu since #468, so returning to it needs no session at all. The exact
   * disposal accounting, and the other gameplay-to-route exits, are #429's.
   */
  const requestCampaignSession = (): void => {
    if (spent) return;
    stop();
    canvas?.remove();
    canvas = null;
  };

  return {
    hasSession: () => handle !== null,
    start(intent): void {
      // `replace`, not `create`: routing every start through the same path is what makes
      // `start()` obey the `spent` latch and dispose a predecessor. Calling `create`
      // directly -- the shape this had first -- meant a `start()` after `dispose()` built
      // a session onto a dying page, and a second `start()` orphaned the first session's
      // loop, renderer and GL context with nothing left holding its handle. That second
      // case stopped being hypothetical in issue #428: `start()` is now called from a HUD
      // button rather than once from `boot()`, so a player who presses New Game twice
      // takes exactly this path.
      replace(intent);
    },
    requestVersusSession,
    requestCampaignSession,
    stop,
    dispose(): void {
      stop();
      spent = true;
    },
  };
}
