/**
 * The browser half of issue #947's check: enter, navigate and exit Developer Tools on a
 * build served the way GitHub Pages serves it.
 *
 * Separate from `check.mjs` so that file's pure functions can be imported by a test without
 * importing Playwright, which `tools/shared/playwright.mjs` records is not a dependency of
 * this repository.
 */
import { loadChromium } from '../shared/playwright.mjs';
import { audioContextOverrideSource } from '../shared/audio-context.mjs';
import { PAGES_PREFIX, exitContractFailures, servePagesShape } from './check.mjs';

/** The developer parameters the exit must remove, and the unrelated one it must keep. */
const DEV_QUERY = 'dev=1&aimRay=1';
const KEEP_QUERY = 'ref=keep';
const DEV_PARAMS = ['dev', 'aimRay'];

/** Visible means present AND not carrying the surface's own hidden modifier. */
async function isVisible(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, selector);
}

/**
 * Wait for a surface to reach a state rather than sampling it straight after a click.
 *
 * These panes animate (`src/game/menu-transition.ts`), so an immediate read catches the
 * outgoing frame: this check reported "the configuration pane did not close on its own Back
 * control" against a pane that closes perfectly well ~600 ms later. Sampling a transition
 * is a flake in one direction and a false failure in the other.
 */
async function settles(page, selector, state, ms = 15000) {
  try {
    await page.waitForSelector(selector, { state, timeout: ms });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive the whole journey and report every breach.
 *
 * @param {string} dist
 * @returns {Promise<string[]>} one message per failure; empty means the journey held
 */
export async function runPagesJourney(dist) {
  const failures = [];
  const server = await servePagesShape(dist);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}${PAGES_PREFIX}`;
  const entered = `${base}?${DEV_QUERY}&${KEEP_QUERY}`;

  const chromium = await loadChromium();
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(audioContextOverrideSource());
    const page = await context.newPage();
    const pageErrors = [];
    const missing = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('response', (r) => {
      if (r.status() === 404) missing.push(r.url());
    });

    await page.goto(entered, { waitUntil: 'load', timeout: 120000 });

    // NON-VACUITY FIRST. Every assertion below is about a page that booted; on a page that
    // did not, they would all fail for one uninformative reason. A blank page is the exact
    // failure a broken `base` produces under a subpath, so it is named separately.
    try {
      await page.waitForSelector('canvas', { state: 'attached', timeout: 60000 });
    } catch {
      failures.push(
        `the app did not boot under ${PAGES_PREFIX} -- no canvas attached. ` +
          `404s so far: ${missing.length ? missing.join(', ') : 'none'}. ` +
          `This is what a non-relative \`base\` looks like on a Pages-shaped serve.`,
      );
      return failures;
    }

    // 0. Past the Launch splash, which covers the menu until a key is pressed. The screen
    //    catalogue's own `PAST_SPLASH` does exactly this, and skipping it makes every
    //    control below "present but not visible" -- which reads as a broken selector
    //    rather than as a page waiting for a gesture.
    await page.keyboard.press('Space');
    await page.waitForSelector('.hud-splash', { state: 'hidden', timeout: 60000 }).catch(() => {});

    // 1. The developer entry is reachable under the prefix.
    await page.waitForSelector('.hud-devtools-open', { timeout: 30000 }).catch(() => {});
    if (!(await isVisible(page, '.hud-devtools-open'))) {
      failures.push('`?dev=1` did not expose the Developer Tools button under the deploy prefix');
      return failures;
    }

    // 2. The menu opens.
    await page.click('.hud-devtools-open');
    if (!(await settles(page, '.hud-devtools', 'visible'))) {
      failures.push('the Developer Tools button did not open the tools menu');
      return failures;
    }

    // 3. NAVIGATE, which is the half a screenshot of the menu would not cover: a pane
    //    inside it opens, its own Back leaves it, and the tools are reachable again after.
    //
    //    WHAT THIS DELIBERATELY DOES NOT ASSERT is where Back lands. Measured here, the
    //    Configuration pane's Back closes the Developer Tools menu too and returns to the
    //    main menu, even though `handleDevCfgBack` calls the layer system's `back()` and
    //    the pane was opened with `openLayer('developer-config', devCfgOpenBtn)`. Whether
    //    one pop should reveal the opener is issue #318's contract, not this check's, and
    //    pinning my expectation of it here would make a navigation ruling by accident.
    //    Recorded on #947 instead. What IS asserted is the round trip: you can leave the
    //    pane and get back to the tools.
    await page.click('.hud-devcfg-open');
    if (!(await settles(page, '.hud-devcfg', 'visible'))) {
      failures.push('the Configuration entry did not open the configuration pane');
    } else {
      await page.click('.hud-devcfg-back');
      if (!(await settles(page, '.hud-devcfg', 'hidden'))) {
        failures.push('the configuration pane did not close on its own Back control');
      }
      if (!(await isVisible(page, '.hud-devtools'))) {
        // Not a failure -- see above. Reopen so the exit below starts from the menu.
        await page.click('.hud-devtools-open');
        await settles(page, '.hud-devtools', 'visible');
      }
      if (!(await isVisible(page, '.hud-devtools'))) {
        failures.push('the Developer Tools menu could not be reopened after leaving a pane');
      }
    }

    // 4. Exit, and let the reload settle.
    if (await isVisible(page, '.hud-devtools')) {
      await Promise.all([
        page.waitForURL((url) => !url.searchParams.has('dev'), { timeout: 60000 }).catch(() => {}),
        page.click('.hud-devtools-exit'),
      ]);
    } else {
      failures.push('never reached the Developer Tools menu, so Exit was not exercised');
    }
    const landed = page.url();
    failures.push(...exitContractFailures(entered, landed, DEV_PARAMS));

    // 5. It must be a LIVE page, not merely a tidy address. `location.assign` reloads, so
    //    the app has to come back up -- and come back up WITHOUT the developer entry.
    try {
      await page.waitForSelector('canvas', { state: 'attached', timeout: 60000 });
    } catch {
      failures.push(`the app did not boot again after Exit; landed on ${landed}`);
    }
    if (await isVisible(page, '.hud-devtools-open')) {
      failures.push('the Developer Tools button is still exposed after leaving developer mode');
    }

    if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
    const offPrefix = missing.filter((u) => !u.includes(PAGES_PREFIX));
    if (offPrefix.length) {
      failures.push(
        `requests escaped the deploy prefix and 404'd: ${offPrefix.join(', ')} -- ` +
          `an asset URL is resolving against the origin root instead of ${PAGES_PREFIX}`,
      );
    }

    if (!failures.length) {
      console.log(
        `developer tools on a Pages shape: entered ${entered}, opened the menu and the ` +
          `configuration pane, exited to ${landed}, and the app booted at both ends`,
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
  return failures;
}
