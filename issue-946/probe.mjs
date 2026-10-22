// Two-arm request probe for #946's closing measurement (issue #1016).
// usage: node probe.mjs <tree dir with dist/> <port> <out.json>
// Serves <tree>/dist with that tree's own `vite preview`, spawned directly, and records every
// request Chromium makes in three fresh contexts:
//   ordinary  `/`                         past the splash, the main menu, then New Game (a round)
//   devpanes  `/?dev=1`                   Developer Tools, then Configuration, then Self-Test
//   gallery   `/?dev=1&gallery=scene:fire` the gallery workbench, which that route opens itself
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [tree, portArg, out] = process.argv.slice(2);
const port = Number(portArg);
const require = createRequire((process.env.TANKS_REPO ?? process.cwd()) + '/package.json');
const { chromium } = require('playwright');
const { audioContextOverrideSource } = await import(
  (process.env.TANKS_REPO ?? process.cwd()) + '/tools/shared/audio-context.mjs'
);

const server = spawn(join(tree, 'node_modules/.bin/vite'),
  ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 100; i++) {
  try { const r = await fetch(base); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const result = { tree, base, chromium: browser.version(), arms: {} };

async function arm(name, path, steps) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(audioContextOverrideSource());
  const page = await context.newPage();
  const requests = [];
  const failed = [];
  const errors = [];
  const marks = [];
  let phase = 'load';
  let last = Date.now();
  page.on('request', (r) => { requests.push({ phase, url: r.url(), type: r.resourceType() }); last = Date.now(); });
  page.on('requestfailed', (r) => failed.push({ phase, url: r.url(), why: r.failure()?.errorText }));
  page.on('pageerror', (e) => errors.push(String(e)));
  const quiet = async (ms = 1000, max = 15000) => {
    const start = Date.now();
    while (Date.now() - last < ms && Date.now() - start < max) await page.waitForTimeout(100);
  };
  const mark = async (label, fn) => {
    phase = label;
    let ok = true;
    let note = null;
    try { note = (await fn()) ?? null; } catch (e) { ok = false; note = String(e).split('\n')[0]; }
    await quiet();
    marks.push({ phase: label, ok, note });
  };
  await mark('load', async () => {
    await page.goto(base + path, { waitUntil: 'load', timeout: 120000 });
    await page.waitForSelector('canvas', { state: 'attached', timeout: 60000 });
  });
  await mark('past-splash', async () => {
    await page.keyboard.press('Space');
    await page.waitForSelector('.hud-splash', { state: 'hidden', timeout: 60000 });
  });
  for (const [label, fn] of steps) await mark(label, () => fn(page));
  result.arms[name] = { path, marks, requests, failed, errors };
  await context.close();
}

const childCount = (page, sel) => page.evaluate((s) => document.querySelector(s)?.children.length ?? -1, sel);

try {
  await arm('ordinary', '', [
    ['menu', async (page) => {
      await page.waitForSelector('.hud-new-game', { state: 'visible', timeout: 30000 });
      return {
        devcfgBodyChildren: await childCount(page, '.hud-devcfg-body'),
        selftestListChildren: await childCount(page, '.hud-selftest-list'),
        galleryBodyChildren: await childCount(page, '.hud-gallery-body'),
      };
    }],
    ['round', async (page) => {
      await page.click('.hud-new-game');
      await page.waitForSelector('.hud-panel', { state: 'hidden', timeout: 30000 });
      await page.waitForTimeout(3000);
      return { playing: true };
    }],
  ]);
  await arm('devpanes', '?dev=1', [
    ['devtools-open', async (page) => {
      await page.waitForSelector('.hud-devtools-open', { state: 'visible', timeout: 30000 });
      await page.click('.hud-devtools-open');
      await page.waitForSelector('.hud-devtools', { state: 'visible', timeout: 30000 });
      return { opened: true };
    }],
    ['config-open', async (page) => {
      await page.click('.hud-devcfg-open');
      await page.waitForSelector('.hud-devcfg-presets', { state: 'visible', timeout: 30000 });
      const n = await childCount(page, '.hud-devcfg-body');
      const buttons = await page.evaluate(() => document.querySelectorAll('.hud-devcfg-body button').length);
      await page.click('.hud-devcfg-back');
      return { devcfgBodyChildren: n, devcfgButtons: buttons };
    }],
    ['selftest-open', async (page) => {
      if (!(await page.isVisible('.hud-devtools'))) {
        await page.click('.hud-devtools-open');
        await page.waitForSelector('.hud-devtools', { state: 'visible', timeout: 30000 });
      }
      await page.click('.hud-selftest-open');
      await page.waitForFunction(() => (document.querySelector('.hud-selftest-list')?.children.length ?? 0) > 0,
        null, { timeout: 30000 });
      return { selftestListChildren: await childCount(page, '.hud-selftest-list') };
    }],
  ]);
  await arm('gallery', '?dev=1&gallery=scene:fire', [
    ['gallery-open', async (page) => {
      await page.waitForFunction(() => {
        const body = document.querySelector('.hud-gallery-body');
        return body !== null && body.children.length > 0 && body.querySelector('canvas') !== null;
      }, null, { timeout: 60000 });
      return { galleryBodyChildren: await childCount(page, '.hud-gallery-body') };
    }],
  ]);
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(out, JSON.stringify(result, null, 2));
for (const [name, a] of Object.entries(result.arms)) {
  console.log(`== ${name} ${a.path}`);
  for (const m of a.marks) console.log(`  ${m.phase}: ${m.ok ? 'ok' : 'FAILED'} ${m.note ? JSON.stringify(m.note) : ''}`);
  const js = a.requests.filter((r) => r.url.endsWith('.js'));
  for (const r of js) console.log(`  [${r.phase}] ${r.type} ${r.url.replace(base, '/')}`);
  console.log(`  failed requests: ${a.failed.length}, page errors: ${a.errors.length}`);
}
