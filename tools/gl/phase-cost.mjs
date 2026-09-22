/**
 * Runs tools/gl/phase-cost.ts in a real browser and prints one row per phase.
 *
 * A tool, not a gate: it prints numbers and exits 0. See tools/gl/phase-cost.ts for what
 * each phase is and why every one of them ends with a blocking readback. Same
 * vite-then-chromium shape as tools/gl/run.mjs, including its refusal to run against a
 * server it did not start.
 *
 * `PHASE_COST_ROUNDS` sets how many rounds to run (default 6). `PHASE_COST_OUT` writes the
 * raw rounds as JSON, which is what an A/B between two `three` versions wants: run each arm
 * to its own file and diff the medians rather than eyeballing two tables.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadChromium } from '../shared/playwright.mjs';

const PORT = Number(process.env.GL_TEST_PORT ?? 5179);
const BASE = `http://localhost:${PORT}/`;
const ROUNDS = Number(process.env.PHASE_COST_ROUNDS ?? 6);

/**
 * The three version these timings belong to, read from the INSTALLED package, for the
 * reason tools/gl/run.mjs records at its own version label: `npm i --no-save three@x`
 * moves the install and leaves package.json's caret alone, so a manifest-derived label
 * would label both arms of an A/B identically.
 */
const installed = JSON.parse(
  readFileSync(new URL('../../node_modules/three/package.json', import.meta.url), 'utf8'),
).version;

async function respondsOn(url, ms = 1000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return false;
  }
}

if (await respondsOn(BASE)) {
  console.error(
    `Something is already listening on ${BASE}.\n` +
      'Refusing to run: it would be measured instead of this checkout.\n' +
      "Stop it (pkill -f 'vite --port') or set GL_TEST_PORT to a free port.",
  );
  process.exit(2);
}

const VITE_BIN = new URL('../../node_modules/.bin/vite', import.meta.url).pathname;
const vite = spawn(VITE_BIN, ['--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
let viteExited = false;
vite.on('exit', () => {
  viteExited = true;
});

let browser;
try {
  for (let i = 0; ; i++) {
    if (viteExited) throw new Error('vite exited before serving; is the port taken?');
    if (await respondsOn(BASE)) break;
    if (i > 120) throw new Error(`vite did not start on ${BASE} within 60s`);
    await sleep(500);
  }

  const chromium = await loadChromium();
  browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  // NO AudioContext override here, deliberately (issue #877). This page is
  // `tools/gl/phase-cost.html`, which loads one module whose imports are `three`,
  // `src/render/scene`, `src/render/renderer` and two `src/sim` modules. Nothing under
  // `src/render` or `src/sim` imports `src/audio` at all -- `src/sim/purity.test.ts` is what
  // keeps that true -- so neither of the two constructions that made the app wedge is
  // reachable, and there is no context here for an override to remove.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // This module has NO top-level await, so its whole loop runs before `load` fires and
  // the two waits below are one wait. The 900s ceiling is a hang ceiling, not a budget,
  // for the same reason tools/gl/run.mjs gives its own: a bare TimeoutError with no rows
  // reads as a broken probe rather than a slow one, and this page's own subject is a
  // phase that was measured at 3s a round.
  await page.goto(`${BASE}tools/gl/phase-cost.html?rounds=${ROUNDS}`, {
    waitUntil: 'load',
    timeout: 900000,
  });
  await page.waitForFunction(() => !!window.__phaseCost, undefined, { timeout: 900000 });
  const { revision, rounds } = await page.evaluate(() => window.__phaseCost);

  for (const e of pageErrors) console.error(`page error: ${e}`);

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const keys = Object.keys(rounds[0]);
  const pad = (s, n) => String(s).padStart(n);

  console.log(`three ${installed} (THREE.REVISION ${revision}), ${rounds.length} rounds\n`);
  console.log(`${'phase'.padEnd(16)} ${pad('median ms', 10)} ${pad('min', 8)} ${pad('max', 8)}`);
  for (const k of keys) {
    const v = rounds.map((r) => r[k]);
    console.log(
      `${k.padEnd(16)} ${pad(median(v).toFixed(1), 10)} ${pad(Math.min(...v).toFixed(1), 8)} ${pad(Math.max(...v).toFixed(1), 8)}`,
    );
  }
  const whole = rounds.map((r) => keys.reduce((s, k) => s + r[k], 0));
  console.log(`${'whole round'.padEnd(16)} ${pad(median(whole).toFixed(1), 10)}`);

  if (process.env.PHASE_COST_OUT) {
    writeFileSync(process.env.PHASE_COST_OUT, JSON.stringify({ installed, revision, rounds }, null, 2));
    console.log(`\nwrote ${process.env.PHASE_COST_OUT}`);
  }
  if (pageErrors.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
