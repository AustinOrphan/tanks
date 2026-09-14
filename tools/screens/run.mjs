/**
 * Screen-state capture (issue #561): boot the BUILT page into a named application state
 * and photograph it, deterministically.
 *
 *   node tools/screens/run.mjs --state screen.records.stats --dist dist \
 *     --out tmp/frame.png --report tmp/producer.json --w 1280 --h 800 --dpr 2
 *
 * `--report` may be omitted, and then lands beside `--out`; both default under `tmp/`
 * rather than the repository root (issue #637, tools/screens/paths.mjs).
 *
 * A standalone CLI writing one frame and one report, which is the shape
 * `tools/capture/gallery-adapter.mjs` already established for the `moment` producer -- the
 * adapter shells out, reads `producer.json` back, and validates it. Playwright arrives
 * through `PLAYWRIGHT_MODULE`, checked once by the capture framework's prerequisites, and is
 * loaded here through the tools family's shared loader (`tools/shared/playwright.mjs`).
 *
 * WHY EVERY SHOT IS ALSO MEASURED. A screenshot named `records.stats` proves the page did
 * not crash and nothing else; two states that render identically produce two files a
 * reviewer has to eyeball. So each capture also records the bounding box and key computed
 * properties of the elements the state names. That half is deterministic in a way pixels
 * are not, and it is the half that has actually caught things: the campaign-complete
 * screen's two tally lines sat 24px apart where 8px was intended, and the number is what
 * said so -- the picture just looked slightly loose.
 *
 * NOT A GATE, and that is argued rather than assumed. See tools/screens/README.md.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadChromium } from '../shared/playwright.mjs';
import { serveStatic } from '../visual/static-server.mjs';
import { findScreenState, SCREEN_STATE_IDS } from './states.mjs';
import { runStep, webglOverrideSource } from './steps.mjs';
import { screenCapturePaths } from './paths.mjs';

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
const serve = (dist) => serveStatic(dist, MIME);

/** The properties a measurement records beside the box, chosen to catch layout drift. */
const WATCHED = ['display', 'opacity', 'color', 'background-color', 'font-size', 'margin-top', 'margin-bottom'];

async function measure(page, selectors) {
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

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const stateId = arg('state');
  const state = stateId ? findScreenState(stateId) : null;
  if (state === null) {
    throw new Error(`--state must name a screen state (${SCREEN_STATE_IDS.join(', ')})`);
  }
  const dist = resolve(arg('dist', 'dist'));
  // Both artifacts through one resolver (issue #637): a bare default used to resolve
  // against the working directory, dropping `screen.png` and `producer.json` into the
  // repository root where neither is ignored. See tools/screens/paths.mjs.
  const { out, report: reportPath } = screenCapturePaths({ out: arg('out'), report: arg('report') });
  const width = Number(arg('w', 1280));
  const height = Number(arg('h', 800));
  const dpr = Number(arg('dpr', 2));
  const timeout = Number(arg('timeout', 20000));
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error(`no index.html under ${dist}`);

  const chromium = await loadChromium();
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  const pageErrors = [];
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: dpr,
      javaScriptEnabled: state.javascript !== 'off',
      // Deterministic by construction rather than by hope: the same reduced-motion answer
      // every run, so a transition cannot be caught mid-flight on a slow machine and not
      // on a fast one.
      reducedMotion: 'reduce',
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    // The state's own query, if it has one (issue #591). Both `goto`s use it: the storage
    // seed visits first only to get an origin, and a capture whose flag is in the URL must
    // carry it on the visit that actually boots.
    const url = `${base}${state.query ?? ''}`;
    if (state.webgl !== 'ok') await page.addInitScript(webglOverrideSource(state.webgl));
    if (Object.keys(state.storage).length > 0) {
      // localStorage needs an origin, so the first visit exists only to get one. The
      // reload is what makes the boot this capture photographs read the seeded save.
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate((entries) => {
        localStorage.clear();
        for (const [k, v] of entries) localStorage.setItem(k, v);
      }, Object.entries(state.storage));
    }
    await page.goto(url, { waitUntil: 'load' });

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

    const measurements = await measure(page, state.measure);
    await mkdir(dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      `${JSON.stringify({
        capture: { viewport: { width, height, devicePixelRatio: dpr } },
        producer: {
          stateId: state.id,
          title: state.title,
          webgl: state.webgl,
          javascript: state.javascript,
          measurements,
          pageErrors,
          played,
        },
      }, null, 2)}\n`,
    );
    console.log(`${state.id}: ${measurements.filter((m) => m.visible).length}/${measurements.length} measured element(s) visible, ${pageErrors.length} page error(s)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
