import type { GameHandle } from './game/loop';

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
  readonly startGame: (canvas: HTMLCanvasElement, uiRoot: HTMLElement) => GameHandle;
  readonly host: BootHost;
  readonly reportError: (err: unknown) => void;
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
    const game = deps.startGame(deps.bootCanvas(deps.root), deps.root);
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
      game.dispose();
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
