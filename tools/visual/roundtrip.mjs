/**
 * Repeated start/return cycles in a REAL browser (issue #429).
 *
 * The unit tests count disposals through injected seams. This counts what the DOCUMENT is
 * actually left holding after the player starts a match, quits to the menu, and does it
 * again -- which is the only place the failure #429 exists to prevent becomes visible.
 *
 * WHY IT NEEDS A BROWSER. `startGameWith`'s teardown calls `renderer.forceContextLoss()`
 * (`render/scene.ts`), and a WebGL context does not come back from that. Nothing in the
 * unit fakes constructs a real `WebGLRenderer`, so a session that left its canvas in the
 * DOM -- or a page that stacked one per match -- looks identical to a correct one there.
 * Here it does not: the canvas count and the live-context count are read off the document.
 *
 * Reports numbers rather than asserting a threshold: the interesting output is "1 canvas
 * after 3 round trips" versus "4", and a bare pass/fail would hide which.
 *
 * Usage: node tools/visual/roundtrip.mjs <dist-dir> [--cycles N]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

async function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      return (await import(c.startsWith('/') ? `${c}/index.mjs` : c)).chromium;
    } catch {
      try {
        return require(c).chromium;
      } catch {
        /* try the next candidate */
      }
    }
  }
  throw new Error('playwright not resolvable; set PLAYWRIGHT_MODULE');
}

function serve(dist) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = join(dist, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** What the document is holding right now. */
const CENSUS = () => {
  const all = [...document.querySelectorAll('canvas')];
  const gameplay = all.filter((c) => !c.classList.contains('hud-preview'));
  const live = gameplay.filter((c) => {
    const ctx = c.getContext('webgl2') ?? c.getContext('webgl');
    return !!ctx && !ctx.isContextLost();
  });
  return { canvases: all.length, gameplay: gameplay.length, liveContexts: live.length };
};

const visible = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && el.offsetParent !== null;
  }, sel);

async function clickFirstVisible(page, selectors) {
  for (const sel of selectors) {
    if (await visible(page, sel)) {
      await page.click(sel);
      return sel;
    }
  }
  return null;
}

async function main() {
  const [distArg, ...rest] = process.argv.slice(2);
  const dist = resolve(distArg ?? 'dist');
  const cycles = rest.includes('--cycles') ? Number(rest[rest.indexOf('--cycles') + 1]) : 3;
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`no index.html in ${dist} -- build first`);
    process.exit(2);
  }

  const chromium = await loadChromium();
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base, { waitUntil: 'load' });
  await page.keyboard.press('Space'); // leave the Launch splash
  await page.waitForTimeout(300);

  console.log('after boot, before any match:', JSON.stringify(await page.evaluate(CENSUS)));

  for (let i = 1; i <= cycles; i += 1) {
    const started = await clickFirstVisible(page, ['.hud-continue', '.hud-new-game', '.hud-action']);
    if (!started) {
      console.error(`cycle ${i}: no start control visible`);
      process.exitCode = 1;
      break;
    }
    await page.waitForFunction(() => {
      const c = document.querySelector('canvas:not(.hud-preview)');
      return !!c && c.width > 0;
    }, undefined, { timeout: 20000 });
    const inMatch = await page.evaluate(CENSUS);

    // Pause, then Quit -- the most-travelled exit in the game. WAITS for the pause panel
    // rather than sleeping: a fixed delay found the Quit button on some cycles and not
    // others, which reads as a disposal failure when it is only a race in this probe.
    let quit = null;
    for (let attempt = 1; attempt <= 3 && !quit; attempt += 1) {
      await page.keyboard.press('Escape');
      try {
        await page.waitForFunction(
          () => {
            const b = document.querySelector('.hud-quit');
            return !!b && b.offsetParent !== null;
          },
          undefined,
          { timeout: 3000 },
        );
      } catch {
        continue;
      }
      await page.click('.hud-quit');
      quit = '.hud-quit';
    }
    if (!quit) {
      console.error(`cycle ${i}: never reached a pause panel with a Quit button`);
      process.exitCode = 1;
      break;
    }
    // Wait for the return to settle rather than sleeping on it.
    await page.waitForFunction(
      () => !document.querySelector('canvas:not(.hud-preview)'),
      undefined,
      { timeout: 5000 },
    ).catch(() => {});
    const afterQuit = await page.evaluate(CENSUS);

    console.log(
      `cycle ${i}: started via ${started} -> ${JSON.stringify(inMatch)} | quit via ${quit} -> ${JSON.stringify(afterQuit)}`,
    );
  }

  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
