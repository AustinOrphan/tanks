/**
 * Drive a loaded page from the title screen into running gameplay (issue #581).
 *
 * WHY THIS IS ITS OWN MODULE. It used to be inline in `run.mjs`, which has no tests at all,
 * and it was WRONG: it waited for the game canvas immediately after `goto`, before pressing
 * Start. That canvas does not exist at page load -- `bootCanvas` is called from
 * `session-host.ts` when a session is created -- so `--scene game` timed out after 30s on
 * every invocation, reporting a locator timeout rather than "the game was never started".
 * Three separate agents hit it in one day and each wrote their own driver to get around it.
 *
 * Extracted so the ORDER is testable without a browser. The fake page in
 * `enter-gameplay.test.ts` models the one invariant that matters -- the canvas appears only
 * after Start is pressed -- so the old order fails there in milliseconds instead of after
 * thirty seconds of a real Chromium.
 */

/** The game canvas. The HUD's own preview canvas exists from page load and is not it. */
export const GAME_CANVAS = 'canvas:not(.hud-preview)';

/**
 * The Main Menu's campaign entry, whichever of the two is showing: `Continue Campaign` on
 * a save, `Start Campaign` on a fresh one. Each carries its own `--hidden` modifier, so
 * `:not(...)` picks the live one and cannot match the other.
 *
 * NOT `button` matched on /start|play/i, which is what this used to be. That matched by
 * LABEL across the whole document, so it resolved first to the Versus pane's hidden
 * `.hud-versus-start` and failed with "element is not visible" -- a pane that is not even
 * open winning a search for the thing to click. A class selector cannot drift onto another
 * surface the way a text match can.
 */
export const START_CAMPAIGN =
  '.hud-continue:not(.hud-continue--hidden), .hud-new-game:not(.hud-new-game--hidden)';

const SPLASH_UP = '.hud-splash:not(.hud-splash--hidden)';
const SPLASH_GONE = '.hud-splash.hud-splash--hidden';

/**
 * Load `url`, leave the title screen, press Start, and wait for the canvas that pressing
 * Start creates -- in that order, which is the whole point.
 *
 * Retried once, because this degrades with SEQUENCE LENGTH: a two-variant sweep is reliable
 * and a six-variant one is not. Each variant is a fresh full load of a WebGL game under
 * software rendering, and the later ones are slower. The retry wraps the WHOLE sequence,
 * not just the navigation, because any step can lose a race against a rebuilding vite
 * during a `--sweep`.
 *
 * @param page a Playwright page, or anything with the same four methods
 * @param {{url: string, settleMs?: number, timeout?: number, retryDelayMs?: number, onRetry?: (message: string) => void}} opts
 */
export async function enterGameplay(page, opts) {
  const { url, settleMs = 1500, timeout = 30000, retryDelayMs = 2000, onRetry = () => {} } = opts;
  const start = page.locator(START_CAMPAIGN).first();
  for (let attempt = 0; ; attempt++) {
    try {
      // 'domcontentloaded', not 'load'. A --sweep patches source between shots, so vite is
      // rebuilding when we navigate and may issue a full HMR reload mid-load -- the 'load'
      // event then never fires for the navigation we are awaiting, and it times out after
      // 30s looking like a broken page.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(settleMs);
      // Leave the title screen FIRST. Until it is gone the menu has no Start button to
      // find -- setState('splash') returns before the branch that writes the label -- and
      // the panel-hidden check the caller runs afterwards reads TRUE while the splash is
      // up, because the menu behind it is hidden too. Both safeguards silently degrade
      // into the Enter fallback without this.
      if (await page.locator(SPLASH_UP).count()) {
        await page.keyboard.press('Space');
        await page.waitForSelector(SPLASH_GONE, { timeout: 5000 }).catch(() => {});
      }
      if (await start.count()) await start.click();
      else await page.keyboard.press('Enter');
      await page.locator(GAME_CANVAS).waitFor({ state: 'attached', timeout });
      return start;
    } catch (e) {
      if (attempt >= 1) throw e;
      onRetry(String(e).split('\n')[0]);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}
