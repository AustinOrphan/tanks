/**
 * One screen capture against an already-running browser and server (issues #561, #766).
 *
 * MOVED OUT OF `run.mjs`, unchanged in behaviour. `run.mjs` launches a browser and a server for
 * each capture it takes, which suits the capture framework's one-recipe-one-process shape. The
 * layout sweep (`sweep.mjs`) takes hundreds of captures, and a browser per capture would spend
 * most of its time starting Chromium. So the part between "a browser exists" and "a frame and a
 * report exist" lives here, and both commands call it.
 *
 * Launching and serving stay with the callers, through the shared helpers below.
 */
import { loadChromium } from '../shared/playwright.mjs';
import { serveStatic } from '../visual/static-server.mjs';
import { runStep, webglOverrideSource } from './steps.mjs';
import { GAME_CANVAS } from '../gallery/enter-gameplay.mjs';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

/**
 * The static server, rooted at `dist`: `tools/visual/static-server.mjs`, which serves through
 * `serve-path.mjs`'s resolver.
 *
 * REUSED rather than rewritten: `resolveRequestPath` already refuses malformed
 * percent-encoding and directory traversal, both of which were real failures found against
 * that probe, and both of which every ad-hoc capture script in this repository's history
 * has quietly reintroduced.
 */
export const serve = (/** @type {string} */ dist) => serveStatic(dist, MIME);

/** Chromium with software GL, the configuration every screen capture has used. */
export async function launchBrowser() {
  const chromium = await loadChromium();
  return chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
}

/** The properties a measurement records beside the box, chosen to catch layout drift. */
const WATCHED = ['display', 'opacity', 'color', 'background-color', 'font-size', 'margin-top', 'margin-bottom'];

async function measure(/** @type {any} */ page, /** @type {readonly string[]} */ selectors) {
  return page.evaluate(
    ([sels, props]) => sels.map((sel) => {
      const el = document.querySelector(sel);
      if (el === null) return { selector: sel, present: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const style = {};
      for (const p of props) style[p] = cs.getPropertyValue(p);
      return {
        selector: sel,
        present: true,
        visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        text: (el.textContent ?? '').trim().slice(0, 200),
        style,
      };
    }),
    [selectors, WATCHED],
  );
}

/**
 * Boot `state` in a fresh context at one viewport, run its steps, and photograph it.
 *
 * Returns the PNG bytes and the producer report `run.mjs` has always written. The context is
 * closed before returning, so a sweep's next capture starts from nothing.
 *
 * `hideGame` (issue #766) hides the gameplay canvas before measuring and shooting. A state reached
 * through a live match, such as Pause or Controllers, otherwise photographs that match at whatever
 * tick the pause landed on, so two captures of one build differ in the enemies behind the pane.
 * `run.mjs` never sets it: a single capture shows the page as a player sees it.
 *
 * @param {any} browser a Playwright browser
 * @param {string} base the served page's URL, ending in `/`
 * @param {any} state a catalogue state
 * @param {{ width: number, height: number, dpr: number, timeout: number, hideGame?: boolean }} viewport
 */
export async function captureState(browser, base, state, { width, height, dpr, timeout, hideGame = false }) {
  const pageErrors = [];
  // A touchscreen is a CAPABILITY, not a viewport (issue #844). `control-relevance.ts`
  // decides which control settings are worth showing from `PlatformCapabilities.touch`, so a
  // narrow desktop context and a phone render different controls at the same size: with
  // `hasTouch` off, `touchScheme` and `fireMode` are OMITTED rather than merely restyled.
  // Both flags together, because `isMobile` alone does not add touch points and `hasTouch`
  // alone leaves the mobile viewport meta unapplied -- a half-configured context would
  // photograph something no real device produces.
  const touch = state.touch === true;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch: touch,
    isMobile: touch,
    javaScriptEnabled: state.javascript !== 'off',
    // Deterministic by construction rather than by hope: the same reduced-motion answer
    // every run, so a transition cannot be caught mid-flight on a slow machine and not
    // on a fast one.
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', (/** @type {unknown} */ e) => pageErrors.push(String(e)));

    // The state's own query, if it has one (issue #591). Both `goto`s use it: the storage
    // seed visits first only to get an origin, and a capture whose flag is in the URL must
    // carry it on the visit that actually boots.
    const url = `${base}${state.query ?? ''}`;
    // Issue #841's holding card. The module request is answered by nobody, so `boot()`
    // never runs and never removes `#boot-loading` -- the one state that photographs the
    // page BEFORE the application exists. Navigation is awaited at `commit` rather than
    // `load`, because a `type="module"` script is deferred and both `load` and
    // `domcontentloaded` wait for one that is never going to arrive.
    if (state.boot === 'holding') await page.route('**/*.js', () => {});
    if (state.webgl !== 'ok') await page.addInitScript(webglOverrideSource(state.webgl));
    if (Object.keys(state.storage).length > 0) {
      // localStorage needs an origin, so the first visit exists only to get one. The
      // reload is what makes the boot this capture photographs read the seeded save.
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate((/** @type {[string, string][]} */ entries) => {
        localStorage.clear();
        for (const [k, v] of entries) localStorage.setItem(k, v);
      }, Object.entries(state.storage));
    }
    await page.goto(url, { waitUntil: state.boot === 'holding' ? 'commit' : 'load' });

    // What each `{ playUntil }` step cost (issue #617): simulated ticks and wall-clock, kept
    // in the report so a played capture's price is recorded every time it runs, not once.
    const played = [];
    for (const step of state.steps) {
      const result = await runStep(page, step, timeout);
      if (result !== undefined) played.push(result);
    }
    // One settle after the last step, at the reduced-motion duration, so a crossfade that
    // has been asked to be instant has still had a frame to become instant in.
    await page.waitForTimeout(250);
    // Not on a page with scripting off: there is no game to hide, and an evaluation there waits
    // for a frame callback that never runs. Measured: the first full sweep stopped for good at
    // `screen.no-script`. The frame wait is also bounded, so no page can hold a sweep forever.
    if (hideGame && state.javascript !== 'off') {
      await page.addStyleTag({ content: `${GAME_CANVAS} { visibility: hidden !important; }` });
      await page.evaluate(() => new Promise((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)));
        setTimeout(() => done(undefined), 500);
      }));
    }

    const measurements = await measure(page, state.measure);
    const png = await page.screenshot();
    const report = {
      capture: { viewport: { width, height, devicePixelRatio: dpr } },
      producer: {
        stateId: state.id,
        title: state.title,
        webgl: state.webgl,
        javascript: state.javascript,
        boot: state.boot,
        measurements,
        pageErrors,
        played,
      },
    };
    return { png, report };
  } finally {
    await context.close();
  }
}
