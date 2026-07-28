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
  addEventListener(type: 'pagehide', fn: () => void, opts: { once: boolean }): void;
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
    // `once` matters because a page can fire pagehide repeatedly when it goes
    // into and out of the back/forward cache, and disposing twice would tear
    // down a game that had already been torn down.
    deps.host.addEventListener('pagehide', () => game.dispose(), { once: true });
  } catch (err) {
    deps.root.innerHTML = '';
    const msg = document.createElement('div');
    msg.style.cssText = MESSAGE_CSS;
    msg.textContent = NO_WEBGL_MESSAGE;
    deps.root.appendChild(msg);
    deps.reportError(err);
  }
}
