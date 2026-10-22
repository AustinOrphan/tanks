// #946 criterion 2 and #251 criterion 3: drive every developer surface on a built dist and
// press a control of each kind, recording every request, response status, failed request,
// page error and download per phase.
// usage: node devtools-journey.mjs <root|pages|remote> <dist dir | base URL> <out.json>
//   root   `vite preview` of <dist>'s tree, spawned directly, serving at /
//   pages  the repository's own Pages-shaped server (tools/devtools-pages/check.mjs,
//          servePagesShape), serving <dist> under /tanks/ and 404ing anything off-prefix
import { spawn } from 'node:child_process';
import { writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/austinorphan/src/tanks/.claude/worktrees/closing-946';
const [mode, distArg, out] = process.argv.slice(2);
const dist = distArg;
const require = createRequire(`${REPO}/package.json`);
const { chromium } = require('playwright');
const { audioContextOverrideSource } = await import(pathToFileURL(`${REPO}/tools/shared/audio-context.mjs`).href);

let base;
let stop;
if (mode === 'root') {
  const tree = dirname(dist);
  const port = 4720;
  const server = spawn(join(tree, 'node_modules/.bin/vite'),
    ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--outDir', dist],
    { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] });
  base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  stop = () => server.kill();
} else if (mode === 'pages') {
  const { servePagesShape, PAGES_PREFIX } = await import(pathToFileURL(`${REPO}/tools/devtools-pages/check.mjs`).href);
  const server = await servePagesShape(dist);
  base = `http://127.0.0.1:${server.address().port}${PAGES_PREFIX}`;
  stop = () => server.close();
} else if (mode === 'remote') {
  // the deployed site itself: <dist> is its base URL, ending in '/'
  base = distArg;
  stop = () => {};
} else {
  throw new Error(`unknown mode ${mode}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
await context.addInitScript(audioContextOverrideSource());
const page = await context.newPage();

const result = { mode, base, chromium: browser.version(), steps: [], requests: [], responses: [], failed: [], errors: [], downloads: [] };
let phase = 'load';
let last = Date.now();
page.on('request', (r) => { result.requests.push({ phase, url: r.url(), type: r.resourceType() }); last = Date.now(); });
page.on('response', (r) => { result.responses.push({ phase, url: r.url(), status: r.status() }); });
page.on('requestfailed', (r) => result.failed.push({ phase, url: r.url(), why: r.failure()?.errorText }));
page.on('pageerror', (e) => result.errors.push({ phase, error: String(e) }));
page.on('download', async (d) => {
  const entry = { phase, suggested: d.suggestedFilename(), bytes: null };
  result.downloads.push(entry);
  try { entry.bytes = statSync(await d.path()).size; } catch (e) { entry.bytes = `unreadable: ${e}`; }
});

const quiet = async (ms = 1000, max = 15000) => {
  const start = Date.now();
  while (Date.now() - last < ms && Date.now() - start < max) await page.waitForTimeout(100);
};
const step = async (label, fn) => {
  phase = label;
  let ok = true;
  let note = null;
  try { note = (await fn()) ?? null; } catch (e) { ok = false; note = String(e).split('\n')[0]; }
  await quiet();
  const js = result.requests.filter((r) => r.phase === label && r.url.endsWith('.js')).map((r) => r.url.replace(base, ''));
  result.steps.push({ phase: label, ok, note, js });
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${label} ${note === null ? '' : JSON.stringify(note)}${js.length ? `\n       js: ${js.join(', ')}` : ''}`);
};
const visible = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  for (let n = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
}, sel);
const value = (sel) => page.evaluate((s) => document.querySelector(s)?.value ?? null, sel);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const waitValueChange = (sel, before, timeout = 15000) => page.waitForFunction(
  ([s, b]) => { const v = document.querySelector(s)?.value ?? ''; return v !== '' && v !== b; }, [sel, before], { timeout });
const head = (s, n = 2) => (s ?? '').split('\n').slice(0, n).join(' | ');
const ensureDevTools = async () => {
  if (!(await visible('.hud-devtools'))) {
    if (await visible('.hud-devtools-open')) await page.click('.hud-devtools-open');
    else await page.click('.hud-devbadge');
    await page.waitForSelector('.hud-devtools', { state: 'visible', timeout: 30000 });
    return 'reopened';
  }
  return 'still open';
};
const withDownload = async (sel) => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click(sel)]);
  return d.suggestedFilename();
};

const entered = `${base}?dev=1&ref=keep`;
try {
  await step('load', async () => {
    await page.goto(entered, { waitUntil: 'load', timeout: 120000 });
    await page.waitForSelector('canvas', { state: 'attached', timeout: 60000 });
  });
  await step('past-splash', async () => {
    await page.keyboard.press('Space');
    await page.waitForSelector('.hud-splash', { state: 'hidden', timeout: 60000 });
  });
  await step('entry-visible', async () => {
    await page.waitForSelector('.hud-devtools-open', { state: 'visible', timeout: 30000 });
    return { entry: await visible('.hud-devtools-open'), badge: await visible('.hud-devbadge') };
  });
  await step('devtools-open', async () => {
    await page.click('.hud-devtools-open');
    await page.waitForSelector('.hud-devtools', { state: 'visible', timeout: 30000 });
    return { pane: true };
  });
  await step('diag-copy (menu)', async () => {
    await page.click('.hud-diag-copy');
    await waitValueChange('.hud-diag-out', '');
    const v = await value('.hud-diag-out');
    return { lines: v.split('\n').length, head: head(v, 3) };
  });
  await step('export-diagnostics (menu)', async () => {
    const before = await value('.hud-diag-out');
    const file = await withDownload('.hud-export-diagnostics');
    await waitValueChange('.hud-diag-out', before);
    return { file, note: head(await value('.hud-diag-out'), 1) };
  });
  await step('config-open', async () => {
    await page.click('.hud-devcfg-open');
    await page.waitForSelector('.hud-devcfg-presets', { state: 'visible', timeout: 30000 });
    return page.evaluate(() => ({
      bodyChildren: document.querySelector('.hud-devcfg-body').children.length,
      buttons: document.querySelectorAll('.hud-devcfg-body button').length,
      presets: [...document.querySelectorAll('.hud-devcfg-preset')].map((b) => b.dataset.preset),
    }));
  });
  await step('config-preset-and-copy', async () => {
    const before = await text('.hud-devcfg-url');
    const presets = await page.$$('.hud-devcfg-preset');
    let after = before;
    let chosen = null;
    for (const p of presets) {
      await p.click();
      after = await text('.hud-devcfg-url');
      if (after !== before) { chosen = await p.getAttribute('data-preset'); break; }
    }
    await page.click('.hud-devcfg-copy');
    await page.waitForFunction(() => {
      const f = document.querySelector('.hud-devcfg-copyfield');
      return f && !f.classList.contains('hud-devcfg-copyfield--hidden') && f.value !== '';
    }, null, { timeout: 15000 });
    return { urlBefore: before, preset: chosen, urlAfter: after, copyField: await value('.hud-devcfg-copyfield') };
  });
  await step('config-back', async () => {
    await page.click('.hud-devcfg-back');
    await page.waitForSelector('.hud-devcfg', { state: 'hidden', timeout: 15000 });
    return { devtoolsVisibleAfterBack: await visible('.hud-devtools'), mainMenu: await visible('.hud-new-game') };
  });
  await step('selftest-open', async () => {
    const how = await ensureDevTools();
    await page.click('.hud-selftest-open');
    await page.waitForFunction(() => (document.querySelector('.hud-selftest-list')?.children.length ?? 0) > 0, null, { timeout: 30000 });
    return { devtools: how, listChildren: await page.evaluate(() => document.querySelector('.hud-selftest-list').children.length),
      listText: head(await text('.hud-selftest-list'), 1).slice(0, 120) };
  });
  await step('selftest-copy-report', async () => {
    await page.click('.hud-selftest-copy');
    await waitValueChange('.hud-selftest-report', '');
    const v = await value('.hud-selftest-report');
    return { reportLines: v.split('\n').length, head: head(v, 2).slice(0, 160) };
  });
  await step('selftest-back', async () => {
    await page.click('.hud-selftest-back');
    await page.waitForSelector('.hud-selftest', { state: 'hidden', timeout: 15000 });
    return { devtoolsVisibleAfterBack: await visible('.hud-devtools') };
  });
  await step('gallery-open', async () => {
    const how = await ensureDevTools();
    await page.click('.hud-gallery-open');
    await page.waitForFunction(() => {
      const b = document.querySelector('.hud-gallery-body');
      return b && b.children.length > 0 && b.querySelector('canvas') !== null;
    }, null, { timeout: 60000 });
    return { devtools: how, bodyChildren: await page.evaluate(() => document.querySelector('.hud-gallery-body').children.length),
      link: await value('.hud-gallery-link') };
  });
  await step('gallery-select-subject', async () => {
    const before = await value('.hud-gallery-link');
    const options = await page.$$eval('select.hud-gallery-select[data-field="subject"] option', (os) => os.map((o) => o.value));
    const current = await page.$eval('select.hud-gallery-select[data-field="subject"]', (s) => s.value);
    const next = options.find((o) => o !== current && o.startsWith('elements:')) ?? options.find((o) => o !== current);
    await page.selectOption('select.hud-gallery-select[data-field="subject"]', next);
    await waitValueChange('.hud-gallery-link', before);
    return { from: current, to: next, linkBefore: before, linkAfter: await value('.hud-gallery-link'),
      command: await value('.hud-gallery-command') };
  });
  await step('gallery-download-still', async () => {
    if (!(await visible('.hud-gallery-still'))) return { still: 'not offered' };
    return { file: await withDownload('.hud-gallery-still') };
  });
  await step('gallery-to-devtools', async () => {
    await page.click('.hud-gallery-devtools');
    await page.waitForSelector('.hud-devtools', { state: 'visible', timeout: 15000 });
    return { galleryBodyChildrenAfterLeave: await page.evaluate(() => document.querySelector('.hud-gallery-body').children.length) };
  });
  await step('devtools-back-to-menu', async () => {
    await page.click('.hud-devtools-back');
    await page.waitForSelector('.hud-new-game', { state: 'visible', timeout: 15000 });
    return { mainMenu: true };
  });
  await step('round', async () => {
    await page.click('.hud-new-game');
    await page.waitForSelector('.hud-panel', { state: 'hidden', timeout: 30000 });
    await page.waitForTimeout(2000);
    return { badge: await visible('.hud-devbadge') };
  });
  await step('badge-open (in round)', async () => {
    await page.click('.hud-devbadge');
    await page.waitForSelector('.hud-devtools', { state: 'visible', timeout: 30000 });
    await page.waitForSelector('.hud-devact[data-action="restart-same-seed"]', { state: 'visible', timeout: 15000 });
    return { actionsVisible: await page.$$eval('.hud-devact', (bs) => bs.filter((b) => !b.hidden).map((b) => b.dataset.action)) };
  });
  await step('diag-pin (in round)', async () => {
    const before = await value('.hud-diag-out');
    await page.click('.hud-diag-pin');
    await waitValueChange('.hud-diag-out', before);
    return { pinned: await value('.hud-diag-out') };
  });
  await step('action restart-same-seed', async () => {
    const sel = '.hud-devact[data-action="restart-same-seed"]';
    const label = await text(sel);
    await page.click(sel);
    const armed = await text(sel);
    const before = await value('.hud-diag-out');
    await page.click(sel);
    await waitValueChange('.hud-diag-out', before);
    return { label, armed, out: await value('.hud-diag-out') };
  });
  await step('action reroll-seed', async () => {
    const sel = '.hud-devact[data-action="reroll-seed"]';
    const label = await text(sel);
    await page.click(sel);
    const armed = await text(sel);
    const before = await value('.hud-diag-out');
    await page.click(sel);
    await waitValueChange('.hud-diag-out', before);
    return { label, armed, out: await value('.hud-diag-out') };
  });
  await step('export-screenshot (in round)', async () => {
    const before = await value('.hud-diag-out');
    const file = await withDownload('.hud-export-screenshot');
    await waitValueChange('.hud-diag-out', before);
    return { file, note: head(await value('.hud-diag-out'), 1) };
  });
  await step('export-replay (in round)', async () => {
    const before = await value('.hud-diag-out');
    await page.click('.hud-export-replay');
    await waitValueChange('.hud-diag-out', before);
    return { note: head(await value('.hud-diag-out'), 1) };
  });
  await step('exit', async () => {
    await Promise.all([
      page.waitForURL((url) => !url.searchParams.has('dev'), { timeout: 60000 }),
      page.click('.hud-devtools-exit'),
    ]);
    await page.waitForSelector('canvas', { state: 'attached', timeout: 60000 });
    await page.keyboard.press('Space');
    await page.waitForSelector('.hud-splash', { state: 'hidden', timeout: 60000 });
    await page.waitForSelector('.hud-new-game', { state: 'visible', timeout: 30000 });
    return { landed: page.url(), entryVisible: await visible('.hud-devtools-open'), badgeVisible: await visible('.hud-devbadge') };
  });
} finally {
  await browser.close();
  stop();
}

const prefix = new URL(base).pathname;
const offPrefix = result.requests.filter((r) => r.url.startsWith('http') && !new URL(r.url).pathname.startsWith(prefix));
const bad = result.responses.filter((r) => r.status >= 400);
const jsAll = [...new Set(result.requests.filter((r) => r.url.endsWith('.js')).map((r) => r.url.replace(base, '')))];
result.summary = {
  steps: result.steps.length, stepsFailed: result.steps.filter((s) => !s.ok).map((s) => s.phase),
  requests: result.requests.length, responses: result.responses.length, responses4xx5xx: bad.length,
  failedRequests: result.failed.length, pageErrors: result.errors.length, downloads: result.downloads.length,
  offPrefixRequests: offPrefix.length, distinctJs: jsAll.length,
};
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary));
if (bad.length) console.log('4xx/5xx:', JSON.stringify(bad));
if (result.failed.length) console.log('failed:', JSON.stringify(result.failed));
if (result.errors.length) console.log('page errors:', JSON.stringify(result.errors));
if (offPrefix.length) console.log('off prefix:', JSON.stringify(offPrefix));
console.log('downloads:', JSON.stringify(result.downloads));
