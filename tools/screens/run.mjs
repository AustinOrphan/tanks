/**
 * Screen-state capture (issue #561): boot the BUILT page into a named application state
 * and photograph it, deterministically.
 *
 *   node tools/screens/run.mjs --state screen.records.stats --dist dist \
 *     --out tmp/frame.png --report tmp/producer.json --w 1280 --h 800 --dpr 2
 *
 * A standalone CLI writing one frame and one report, which is the shape
 * `tools/capture/gallery-adapter.mjs` already established for the `moment` producer -- the
 * adapter shells out, reads `producer.json` back, and validates it. Playwright arrives
 * through `PLAYWRIGHT_MODULE`, resolved once by the capture framework's prerequisites
 * check, so this file never has to hunt for it.
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
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, dirname, resolve } from 'node:path';
import { resolveRequestPath } from '../visual/serve-path.mjs';
import { findScreenState, SCREEN_STATE_IDS, STEP_KINDS, WEBGL_MODES } from './states.mjs';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

/**
 * The static server, rooted at `dist` and sharing `roundtrip.mjs`'s path resolver.
 *
 * REUSED rather than rewritten: `resolveRequestPath` already refuses malformed
 * percent-encoding and directory traversal, both of which were real failures found against
 * that probe, and both of which every ad-hoc capture script in this repository's history
 * has quietly reintroduced.
 */
function serve(dist) {
  const server = createServer(async (req, res) => {
    const file = resolveRequestPath(dist, req.url);
    if (file === null || !existsSync(file)) return void res.writeHead(404).end('not found');
    try {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(500).end('error');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/**
 * The page-side WebGL override, as a source string for `addInitScript`.
 *
 * Patches `HTMLCanvasElement.prototype.getContext` rather than stubbing a module, so the
 * REAL probe in `render-capability.ts` runs and takes its real branch -- returning null is
 * `no-webgl2`, throwing is `probe-failed`, and those select two different branded screens.
 * A capture that injected the screen's markup instead would evidence nothing.
 *
 * Only `webgl2` is intercepted. The HUD's Customize preview and the 2D contexts the page
 * uses elsewhere keep working, so a failure state still renders the rest of the page the
 * way a player would meet it.
 */
function webglOverrideSource(mode) {
  if (!WEBGL_MODES.includes(mode)) throw new Error(`unknown webgl mode '${mode}'`);
  return `(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (id, ...rest) {
      if (String(id).toLowerCase() !== 'webgl2') return real.call(this, id, ...rest);
      ${mode === 'probe-blocked'
        ? "throw new Error('capture: webgl2 blocked');"
        : 'return null;'}
    };
  })()`;
}

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

const visibleIn = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (el === null) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
})()`;

const goneIn = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (el === null) return true;
  return getComputedStyle(el).display === 'none' || el.classList.contains('hud-splash--hidden');
})()`;

/** Run one declarative step. An unknown kind is an error, never a skipped line. */
async function runStep(page, step, timeout) {
  const kinds = Object.keys(step).filter((k) => STEP_KINDS.includes(k));
  if (kinds.length !== 1) {
    throw new Error(`each step needs exactly one known key, got ${JSON.stringify(step)}`);
  }
  const [kind] = kinds;
  if (kind === 'press') return void (await page.keyboard.press(step.press));
  if (kind === 'waitVisible') return void (await page.waitForFunction(visibleIn(step.waitVisible), undefined, { timeout }));
  if (kind === 'waitHidden') return void (await page.waitForFunction(goneIn(step.waitHidden), undefined, { timeout }));
  if (kind === 'breakWebgl') {
    // Applied to the LIVE page, not as an init script: the point of this step is that boot
    // already succeeded. `addInitScript` would run before the probe and produce a boot
    // failure instead, which is a different screen.
    return void (await page.evaluate(webglOverrideSource(step.breakWebgl)));
  }
  await page.waitForFunction(
    `(() => {
      const el = document.querySelector(${JSON.stringify(step.click)});
      if (el === null || el.disabled) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.getBoundingClientRect().width > 0;
    })()`,
    undefined,
    { timeout },
  );
  await page.click(step.click);
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
  const out = resolve(arg('out', 'screen.png'));
  const reportPath = resolve(arg('report', 'producer.json'));
  const width = Number(arg('w', 1280));
  const height = Number(arg('h', 800));
  const dpr = Number(arg('dpr', 2));
  const timeout = Number(arg('timeout', 20000));
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error(`no index.html under ${dist}`);

  const chromium = (await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')).chromium;
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

    for (const step of state.steps) await runStep(page, step, timeout);
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
