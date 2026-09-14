#!/usr/bin/env node
/**
 * Runs the `versus-bots` benchmark workload on the BUILT page in headless Chromium, several times
 * per arm, and saves each report (issue #738, part of #721).
 *
 *   node tools/bench/runs.mjs --dist dist --out bench-out --runs 3 --arms high,low
 *
 * An arm is a quality preset, optionally with overrides: `low`, `high`, or
 * `high+shadowMapSize=512`. Runs are interleaved across arms (round 1 every arm, then round 2), so
 * drift over the sitting lands on every arm alike rather than on whichever ran last.
 *
 * Each run follows the device procedure's own steps: a fresh page on the workload's query plus the
 * arm's flags, a key press at the splash, Start Campaign, then `__tanks.bench()` polled until its
 * phase is `done`. The report is written as `<out>/r<round>-<arm>.json`, serialized in the page with
 * `JSON.stringify` as the console copy would be.
 *
 * WHAT THIS IS NOT. It measures software GL on whatever machine runs it. A figure from it describes
 * that machine and says nothing about a device's frame-time budget.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadChromium } from '../shared/playwright.mjs';
import { serveStatic } from '../visual/static-server.mjs';

const WORKLOAD_QUERY = '?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7';
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

/** `high+shadowMapSize=512` -> `&quality=high&shadowMapSize=512`. */
export function armQuery(arm) {
  const [quality, ...overrides] = arm.split('+');
  if (!/^(low|medium|high)$/.test(quality)) throw new Error(`arm "${arm}": starts with low, medium or high`);
  for (const o of overrides) {
    if (!/^[A-Za-z]+=[A-Za-z0-9.]+$/.test(o)) throw new Error(`arm "${arm}": "${o}" is not flag=value`);
  }
  return [`&quality=${quality}`, ...overrides.map((o) => `&${o}`)].join('');
}

/** Round-robin order: every arm once per round. */
export function runOrder(arms, runs) {
  const order = [];
  for (let round = 1; round <= runs; round++) for (const arm of arms) order.push({ round, arm });
  return order;
}

async function oneRun(browser, base, arm, timeoutMs) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`${base}${WORKLOAD_QUERY}${armQuery(arm)}`, { waitUntil: 'load' });
    await page.waitForSelector('.hud-splash', { state: 'visible', timeout: 30_000 });
    await page.keyboard.press('Space');
    const start = page.getByRole('button', { name: 'Start Campaign' });
    await start.waitFor({ state: 'visible', timeout: 30_000 });
    await start.click();
    const t0 = Date.now();
    for (;;) {
      const phase = await page.evaluate(() => globalThis.__tanks?.bench?.().phase ?? null);
      if (phase === 'done') break;
      if (Date.now() - t0 > timeoutMs) throw new Error(`phase still ${JSON.stringify(phase)} after ${timeoutMs} ms`);
      await page.waitForTimeout(2000);
    }
    if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
    return await page.evaluate(() => JSON.stringify(globalThis.__tanks.bench(), null, 2));
  } finally {
    await context.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string', default: 'dist' },
      out: { type: 'string', default: 'bench-out' },
      runs: { type: 'string', default: '3' },
      arms: { type: 'string', default: 'high,low' },
      timeout: { type: 'string', default: '180000' },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${values.runs}`);
  const arms = values.arms.split(',').filter(Boolean);
  for (const arm of arms) armQuery(arm);
  await mkdir(values.out, { recursive: true });
  const chromium = await loadChromium();
  const server = await serveStatic(resolve(values.dist), TYPES);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
  try {
    for (const { round, arm } of runOrder(arms, runs)) {
      const started = Date.now();
      const json = await oneRun(browser, base, arm, Number(values.timeout));
      const file = `${values.out}/r${round}-${arm}.json`;
      await writeFile(file, json);
      console.log(`${file} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invoked) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
