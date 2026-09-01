/**
 * Every match-start gesture, started and returned from, in a REAL browser (issues #429,
 * #480).
 *
 * The unit tests count disposals through injected seams. This counts what the DOCUMENT is
 * actually left holding after the player starts a match and quits to the menu -- which is
 * the only place the failure #429 exists to prevent becomes visible.
 *
 * WHY IT NEEDS A BROWSER. `startGameWith`'s teardown calls `renderer.forceContextLoss()`
 * (`render/scene.ts`), and a WebGL context does not come back from that. Nothing in the
 * unit fakes constructs a real `WebGLRenderer`, so a session that left its canvas in the
 * DOM -- or a page that stacked one per match -- looks identical to a correct one there.
 * Here it does not: the canvas count and the live-context count are read off the document.
 *
 * ALL FOUR GESTURES, NOT A GENERIC CYCLE. #428 admits exactly four things that may build a
 * session -- Continue, New Game, a Practice level pick and Versus Start -- and each reaches
 * `startGameWith` down a different path: two are one click on the title panel, one goes
 * through the level-select pane, one through the VS setup pane and its validated config.
 * An earlier version of this probe clicked whichever of Continue/New Game happened to be
 * visible, so half the population was never exercised at all.
 *
 * IT NOW RETURNS A VERDICT, where the first version deliberately only reported numbers.
 * The reason for that original choice still holds -- "1 canvas after 3 round trips" versus
 * "4" is the interesting output and a bare pass/fail would hide it -- so every census is
 * still printed in full. What changed is that nothing ran this: it was in no npm script and
 * no workflow, so the evidence existed only when somebody remembered to go and look. A gate
 * needs an exit code, and the numbers above it are what says WHICH gesture moved.
 *
 * Usage: node tools/visual/roundtrip.mjs <dist-dir> [--cycles N]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { resolveRequestPath } from './serve-path.mjs';

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
    const file = resolveRequestPath(dist, req.url);
    if (file === null) {
      res.writeHead(400).end('bad request');
      return;
    }
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

/**
 * The four gestures #428 admits, and the clicks each one takes.
 *
 * ORDER IS LOAD-BEARING. `Continue` needs a campaign run to continue, and the only thing
 * here that creates one is `New Game` -- so running Continue first would find its button
 * hidden and report a probe failure for a game behaving correctly. The Practice pick reaches
 * the same start boundary through the level-select pane, which is why its selector is a
 * level TILE and not the pane's open button: opening the pane is navigation and builds
 * nothing, and stopping there would have exercised no start at all.
 *
 * `:not([disabled])` on the two second-step selectors is the honest wait rather than a
 * convenience. A locked level tile is `disabled` (hud.ts renders it that way so it cannot
 * fire), and `.hud-versus-start` is `disabled` whenever the retained config has a problem --
 * so without it this would click a dead control and then time out waiting for a canvas,
 * reporting a disposal failure for what is really an invalid setup.
 */
const GESTURES = [
  { id: 'new-game', clicks: ['.hud-new-game'] },
  { id: 'continue', clicks: ['.hud-continue'] },
  { id: 'practice', clicks: ['.hud-levelselect-open', '.hud-level-btn:not([disabled])'] },
  { id: 'versus', clicks: ['.hud-versus-open', '.hud-versus-start:not([disabled])'] },
];

/** A control this gesture needs never became clickable. Named so the caller can say which. */
class UnreachableControl extends Error {
  constructor(gesture, selector) {
    super(`${gesture}: "${selector}" never became visible and enabled`);
    this.gesture = gesture;
    this.selector = selector;
  }
}

/**
 * Wait for a control, then click it.
 *
 * WAITS rather than checking once, for the same reason the pause-panel loop below does: a
 * pane crossfades in, so a probe that asked "is Start visible?" the instant it clicked Versus
 * would answer no for a pane that arrives 150ms later. A fixed sleep was tried for the Quit
 * button and found the control on some cycles and not others -- which reads as a lifecycle
 * failure when it is only a race in this file.
 */
async function clickWhenReady(page, gesture, sel, timeout = 10000) {
  try {
    await page.waitForFunction(
      (s) => {
        const el = document.querySelector(s);
        return !!el && el.offsetParent !== null && !el.disabled;
      },
      sel,
      { timeout },
    );
  } catch {
    throw new UnreachableControl(gesture, sel);
  }
  await page.click(sel);
}

/**
 * Return to the application routes the way a player does: pause, then Quit.
 *
 * RETRIES the Escape rather than sleeping on it. A fixed delay found the Quit button on some
 * cycles and not others, which reads as a disposal failure when it is only a race here.
 */
async function quitToMenu(page, gesture) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
    return;
  }
  throw new UnreachableControl(gesture, '.hud-quit');
}

/** One gesture: census before, start, census in match, return, census after. */
async function runGesture(page, gesture) {
  const before = await page.evaluate(CENSUS);
  for (const sel of gesture.clicks) await clickWhenReady(page, gesture.id, sel);

  // The canvas has to be BUILT and SIZED, not merely present: #428's shipped defect was a
  // start that built the board and left the player on the Main Menu, and a zero-width canvas
  // is what that looked like from out here.
  try {
    await page.waitForFunction(
      () => {
        const c = document.querySelector('canvas:not(.hud-preview)');
        return !!c && c.width > 0;
      },
      undefined,
      { timeout: 20000 },
    );
  } catch {
    throw new UnreachableControl(gesture.id, 'a sized gameplay canvas');
  }
  const inMatch = await page.evaluate(CENSUS);

  await quitToMenu(page, gesture.id);
  await page
    .waitForFunction(() => !document.querySelector('canvas:not(.hud-preview)'), undefined, {
      timeout: 5000,
    })
    .catch(() => {});
  const after = await page.evaluate(CENSUS);
  return { before, inMatch, after };
}

/**
 * What each census has to say, stated once so the printed numbers and the exit code cannot
 * drift apart.
 *
 * `canvases <= 2` on every reading, not just at the end: the second is the HUD's persistent
 * Customize preview, which is page-owned and correct to keep, and a third at any point is a
 * gameplay canvas nobody removed. Checking only the final reading would let a match stack a
 * canvas and then have the LAST quit tidy up, which is the accumulation this exists to catch.
 */
function faults({ before, inMatch, after }, id) {
  const out = [];
  if (before.gameplay !== 0 || before.liveContexts !== 0)
    out.push(`${id}: entered with ${before.gameplay} gameplay canvas(es), ${before.liveContexts} live context(s)`);
  if (inMatch.gameplay !== 1 || inMatch.liveContexts !== 1)
    out.push(`${id}: in match with ${inMatch.gameplay} gameplay canvas(es), ${inMatch.liveContexts} live context(s) -- expected exactly 1 of each`);
  if (after.gameplay !== 0 || after.liveContexts !== 0)
    out.push(`${id}: LEAKED ${after.gameplay} gameplay canvas(es) and ${after.liveContexts} live context(s) after the return`);
  for (const [when, c] of [['before', before], ['in match', inMatch], ['after', after]])
    if (c.canvases > 2) out.push(`${id}: ${c.canvases} canvases ${when} -- more than the gameplay canvas and the HUD preview`);
  return out;
}

async function main() {
  const [distArg, ...rest] = process.argv.slice(2);
  const dist = resolve(distArg ?? 'dist');
  const cycles = rest.includes('--cycles') ? Number(rest[rest.indexOf('--cycles') + 1]) : 1;
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

  const problems = [];
  const boot = await page.evaluate(CENSUS);
  console.log('after boot, before any match:', JSON.stringify(boot));
  if (boot.gameplay !== 0 || boot.liveContexts !== 0)
    problems.push(`boot: the page loaded owning ${boot.gameplay} gameplay canvas(es) and ${boot.liveContexts} live context(s)`);

  let ran = 0;
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    for (const gesture of GESTURES) {
      const tag = cycles > 1 ? `cycle ${cycle} ${gesture.id}` : gesture.id;
      let census;
      try {
        census = await runGesture(page, gesture);
      } catch (e) {
        // LOUD, and it does not stop the sweep: one unreachable control must not hide
        // whether the other three gestures leak.
        // The error already names the gesture, so `tag` is prepended only when a repeat
        // count makes "versus" ambiguous -- otherwise this printed "versus: versus: ...".
        const why = e instanceof Error ? e.message : String(e);
        const line = cycles > 1 ? `cycle ${cycle}: ${why}` : why;
        console.log(`FAILED -- ${line}`);
        problems.push(line);
        continue;
      }
      ran += 1;
      console.log(
        `${tag}: before ${JSON.stringify(census.before)} | in match ${JSON.stringify(census.inMatch)} | after ${JSON.stringify(census.after)}`,
      );
      problems.push(...faults(census, tag));
    }
  }

  // The denominator, printed rather than implied: "4 ran" against a silent 2 is the whole
  // difference between a sweep and a sample, and the earlier version of this probe could
  // skip a gesture without ever saying so.
  console.log(`gestures run: ${ran} of ${cycles * GESTURES.length}`);
  console.log('page errors:', errors.length ? errors : 'none');
  if (errors.length) problems.push(`${errors.length} page error(s)`);

  if (problems.length) {
    console.error(`\nFAIL -- ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`\nOK -- ${ran} gesture(s), no accumulation, no page errors`);
  }

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
