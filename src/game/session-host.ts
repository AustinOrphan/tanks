import type { GameHandle } from './loop';
import type { VersusConfig } from './versus-config';
import type { AppShell } from './app-shell';

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
   * Create and run the FIRST session, on a canvas built into the root.
   *
   * Separate from construction because `boot.ts` builds the host inside its try/catch and
   * a `WebGLRenderer` with no WebGL support throws out of `startGame` -- so the throw has
   * to happen at a call the caller can put inside that catch, not at construction.
   */
  start(): void;
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
    uiRoot: HTMLElement,
    versus: { config: VersusConfig } | null,
    requestVersusSession: (config: VersusConfig) => void,
    requestCampaignSession: () => void,
    shell: AppShell,
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
  const create = (versus: { config: VersusConfig } | null): void => {
    canvas = deps.bootCanvas(deps.root);
    handle = deps.startGame(
      canvas,
      deps.root,
      versus,
      requestVersusSession,
      requestCampaignSession,
      deps.shell,
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
  const replace = (versus: { config: VersusConfig } | null): void => {
    if (spent) return;
    stop();
    canvas?.remove();
    canvas = null;
    create(versus);
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
    replace({ config: lastVersusConfig });
  };

  const requestCampaignSession = (): void => {
    replace(null);
  };

  return {
    start(): void {
      create(null);
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
