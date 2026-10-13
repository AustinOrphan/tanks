// #1014 two-arm request-list probe against a built dist, served by `vite preview`.
//   node probe-requests-1014.mjs <tree> <out.json> <downloadsDir> [--supplementary]
//
// Method as recorded for #1012 and #1013 (memory note two-arm-request-probe): `vite preview`
// spawned directly (not npx) on 127.0.0.1:4396 with --strictPort, the swiftshader args of
// tools/visual/verify.mjs, a fresh browser context per arm, every `.js` request recorded, the
// splash dismissed with keyboard Space and `.hud-splash--hidden` waited for, and the AudioContext
// override every browser tool installs (tools/shared/audio-context.mjs). Clicks and visibility
// waits go through the screen harness's own `runStep` (tools/screens/steps.mjs), so each click is
// a real pointer click on a visible control.
//
// Arm 1 (ordinary URL): past the splash to the Main Menu (snapshot), then Start Campaign into a
//   round (snapshot). Every JS file requested is read off disk and searched for the probe strings.
// Arm 2 (?dev=1, the positive control): snapshots at the Main Menu before Developer Tools opens
//   and with it open before any press; then Copy Diagnostics, Pin Current Seed and the three
//   exports at the Main Menu; then Back, Start Campaign, the pane reopened from the DEV badge,
//   the same five presses in the round, and every danger control ARMED ONLY: one press, the
//   label read, the 4 s lapse waited out and the resting label read back. Nothing is confirmed.
//   One more pair of presses shows another control's arm disarming the first. Copy is pressed
//   again at the end, and its seed compared with the first in-round Copy, so the arming is shown
//   not to have rebuilt the world.
// --supplementary adds two arms that only make sense where the modules are separate chunks:
//   Arm 3 (?dev=1, the load held back 2.5 s by page.route): Copy, Download Screenshot and
//   Download Diagnostics clicked in one task in a round BEFORE the load lands, and Download
//   Diagnostics clicked again once it has; the ticks in the saved file names say when each read
//   the round. The field is sampled every 25 ms in the page, and pass-through observers record
//   each select() on the field and each clipboard write with how it settled.
//   Arm 4 (?dev=1, the three chunks aborted by page.route): the failed load is reported into the
//   field, and a Copy pressed afterwards is reported the same way; page errors are recorded.
import { spawn } from 'node:child_process';
import { statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const supplementary = args.includes('--supplementary');
const [root, out, downloadsDir] = args.filter((a) => !a.startsWith('--'));
if (!root || !out || !downloadsDir) {
  throw new Error('usage: node probe-requests-1014.mjs <tree> <out.json> <downloadsDir> [--supplementary]');
}
mkdirSync(downloadsDir, { recursive: true });
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright');
const { audioContextOverrideSource } = await import(join(root, 'tools/shared/audio-context.mjs'));
const { runStep } = await import(join(root, 'tools/screens/steps.mjs'));
const PORT = 4396;
const base = `http://127.0.0.1:${PORT}/`;
const T = 30000;

// Each occurs among shipped source (src/, non-test) only in its module, by `git grep -F` over
// every tracked file at HEAD (probe-grep.log). The other hits are test files and, for the
// diagnostics heading, tools/screens/flow.mjs, which is never bundled.
const PROBES = {
  'dev-actions': ['Restart, losing this round?', 'Reroll, losing this round?', 'Restart this round?'],
  'dev-diagnostics': ['Session: none simulating (no seed to report)', '## Tanks! session diagnostics'],
  'dev-exports': ['has not simulated a tick yet', 'there is no game canvas to save'],
};
const DEV_CHUNK = /^dev-(actions|diagnostics|exports)-[A-Za-z0-9_-]+\.js$/;

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);
const server = spawn(
  join(root, 'node_modules', '.bin', 'vite'),
  ['preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += String(d); });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`preview did not start: ${serverErr}`)), 30000);
  server.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) { clearTimeout(t); resolve(); } });
  server.on('exit', (c) => reject(new Error(`preview exited ${c}: ${serverErr}`)));
});
log(`preview up on ${PORT}, pid ${server.pid}, serving ${root}/dist`);

const assets = join(root, 'dist', 'assets');
const sizeOf = (name) => { try { return statSync(join(assets, name)).size; } catch { return null; } };
const textOf = (name) => { try { return readFileSync(join(assets, name), 'utf8'); } catch { return ''; } };
const allJs = readdirSync(assets).filter((f) => f.endsWith('.js')).sort();
/** Every probe string found in `files`, as `module -> ["file: string", ...]`. */
const probesIn = (files) => {
  const found = {};
  for (const [mod, strings] of Object.entries(PROBES)) {
    for (const s of strings) for (const f of files) if (textOf(f).includes(s)) (found[mod] ??= []).push(`${f}: ${s}`);
  }
  return found;
};
const population = (list) => {
  const u = [...new Set(list)];
  return {
    files: u.map((f) => ({ file: f, bytes: sizeOf(f) })),
    bytes: u.reduce((n, f) => n + (sizeOf(f) ?? 0), 0),
    devChunks: u.filter((f) => DEV_CHUNK.test(f)),
    probes: probesIn(u),
  };
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
log(`chromium ${browser.version()}`);

async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.addInitScript(audioContextOverrideSource());
  const page = await context.newPage();
  const rec = { js: [], errors: [], failed: [], downloads: [], saves: [], snaps: [] };
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith('.js')) rec.js.push(basename(u.pathname));
  });
  page.on('requestfailed', (r) => rec.failed.push(`${basename(new URL(r.url()).pathname)}: ${r.failure()?.errorText ?? '?'}`));
  page.on('pageerror', (e) => rec.errors.push(String(e)));
  page.on('download', (d) => {
    rec.downloads.push(d.suggestedFilename());
    rec.saves.push(d.saveAs(join(downloadsDir, d.suggestedFilename())));
  });
  /** Snapshot: what has been requested so far, and what is new since the previous snapshot. */
  rec.snap = (label) => {
    const prev = rec.snaps.at(-1)?.count ?? 0;
    const s = { label, count: rec.js.length, newSincePrevious: [...new Set(rec.js.slice(prev))], cumulative: population(rec.js) };
    rec.snaps.push(s);
    log(`   snapshot "${label}": new=${JSON.stringify(s.newSincePrevious)} devChunks=${JSON.stringify(s.cumulative.devChunks)}`);
    return s;
  };
  return { context, page, rec };
}

async function pastSplash(page, query) {
  await page.goto(base + query, { waitUntil: 'load' });
  await page.waitForSelector('.hud-splash', { timeout: 60000 });
  await page.keyboard.press('Space');
  await page.waitForFunction(
    () => document.querySelector('.hud-splash')?.classList.contains('hud-splash--hidden'),
    undefined,
    { timeout: 60000 },
  );
}
const step = (page, s) => runStep(page, s, T);
const SENTINEL = '__probe-1014__';
const field = (page) => page.evaluate(() => {
  const f = document.querySelector('.hud-diag-out');
  const v = f?.value ?? null;
  return {
    head: v === null ? null : v.split('\n').slice(0, 3).join(' | ').slice(0, 160),
    chars: v?.length ?? null,
    shown: !!f && !f.classList.contains('hud-diag-out--hidden') && getComputedStyle(f).display !== 'none',
    focused: document.activeElement === f,
    wholeTextSelected: !!f && v.length > 0 && f.selectionStart === 0 && f.selectionEnd === v.length,
  };
});
const labels = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.hud-devact'), (b) => ({
  id: b.dataset.action, hidden: b.hidden, text: b.textContent,
})));
/** A real click on `sel`, then wait until the output field holds something other than the sentinel. */
async function press(page, sel) {
  await page.evaluate((s) => { const f = document.querySelector('.hud-diag-out'); if (f) f.value = s; }, SENTINEL);
  await step(page, { click: sel });
  await page.waitForFunction((s) => {
    const f = document.querySelector('.hud-diag-out');
    return !!f && f.value !== s && f.value !== '';
  }, SENTINEL, { timeout: T });
  return field(page);
}
/** One press on a danger control, its label read, the 4 s lapse waited out, and the label read again. */
async function armOnly(page, sel) {
  const visible = await page.evaluate((s) => {
    const b = document.querySelector(s);
    return !!b && !b.hidden && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0;
  }, sel);
  if (!visible) return { sel, visible };
  const read = () => page.evaluate((s) => {
    const b = document.querySelector(s);
    return { text: b.textContent, armed: b.classList.contains('hud-danger--armed') };
  }, sel);
  const resting = await read();
  await step(page, { click: sel });
  const armed = await read();
  await page.waitForTimeout(4500);
  const lapsed = await read();
  return { sel, visible, resting, armed, lapsed };
}
const seedOf = (text) => /- Seed: (\d+)/.exec(text ?? '')?.[1] ?? null;

async function ordinaryArm() {
  log('arm 1 (ordinary URL): start');
  const { context, page, rec } = await freshPage();
  await pastSplash(page, '');
  await step(page, { waitVisible: '.hud-panel' });
  await page.waitForTimeout(2000); // let any trailing request land
  const menuFacts = await page.evaluate(() => {
    const shown = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; };
    return {
      url: location.href,
      mainMenuShown: shown('.hud-panel'),
      developerToolsEntryShown: shown('.hud-devtools-open'),
      devBadgeShown: shown('.hud-devbadge'),
    };
  });
  rec.snap('main menu');
  await step(page, { click: '.hud-new-game' });
  await step(page, { waitHidden: '.hud-panel' });
  await page.waitForTimeout(3000); // a round running
  const roundFacts = await page.evaluate(() => ({
    panelHidden: getComputedStyle(document.querySelector('.hud-panel')).display === 'none',
    devBadgeShown: getComputedStyle(document.querySelector('.hud-devbadge')).display !== 'none',
  }));
  rec.snap('in a round, 3 s after Start Campaign');
  await context.close();
  return { name: 'ordinary', query: '', menuFacts, roundFacts, errors: rec.errors, failed: rec.failed, snaps: rec.snaps, requested: population(rec.js) };
}

async function devArm() {
  log('arm 2 (?dev=1): start');
  const { context, page, rec } = await freshPage();
  await pastSplash(page, '?dev=1');
  await step(page, { waitVisible: '.hud-panel' });
  await page.waitForTimeout(1500);
  const actionsAtMenuBeforeOpen = await labels(page);
  rec.snap('main menu, before Developer Tools');

  await step(page, { click: '.hud-devtools-open' });
  await step(page, { waitVisible: '.hud-devtools' });
  await page.waitForTimeout(1500); // anything the open requests lands here
  rec.snap('Developer Tools open from the Main Menu, before any press');
  const menu = {};
  menu.copy = await press(page, '.hud-diag-copy');
  menu.pin = await press(page, '.hud-diag-pin');
  menu.exportDiagnostics = await press(page, '.hud-export-diagnostics');
  menu.exportReplay = await press(page, '.hud-export-replay');
  menu.exportScreenshot = await press(page, '.hud-export-screenshot');
  // The same Copy, clicked and read inside ONE task: once the modules are there, the press does
  // not wait on anything before it writes and selects.
  menu.copySameTask = await page.evaluate((s) => {
    const f = document.querySelector('.hud-diag-out');
    f.value = s;
    document.querySelector('.hud-diag-copy').click();
    return {
      changedInTheSameTask: f.value !== s,
      head: f.value.split('\n')[0],
      focused: document.activeElement === f,
      wholeTextSelected: f.value.length > 0 && f.selectionStart === 0 && f.selectionEnd === f.value.length,
    };
  }, SENTINEL);
  const actionsAtMenu = await labels(page);
  rec.snap('after the five Main Menu presses');

  await step(page, { click: '.hud-devtools-back' });
  await step(page, { waitVisible: '.hud-panel' });
  await step(page, { click: '.hud-new-game' });
  await step(page, { waitHidden: '.hud-panel' });
  await page.waitForTimeout(2000);
  rec.snap('in a round, before the DEV badge');
  await step(page, { click: '.hud-devbadge' });
  await step(page, { waitVisible: '.hud-devtools' });
  await step(page, { waitVisible: '.hud-devact[data-action="restart-same-seed"]' });
  await step(page, { waitVisible: '.hud-devact[data-action="reroll-seed"]' });
  await step(page, { waitVisible: '.hud-devact[data-action="restart-round"]' });
  const actionsInRound = await labels(page);
  rec.snap('Developer Tools reopened from the DEV badge');
  const round = {};
  round.copy = await press(page, '.hud-diag-copy');
  const seedBefore = seedOf(await page.evaluate(() => document.querySelector('.hud-diag-out').value));
  round.pin = await press(page, '.hud-diag-pin');
  round.exportDiagnostics = await press(page, '.hud-export-diagnostics');
  round.exportReplay = await press(page, '.hud-export-replay');
  round.exportScreenshot = await press(page, '.hud-export-screenshot');

  const arming = [];
  for (const sel of [
    '.hud-devact[data-action="restart-same-seed"]',
    '.hud-devact[data-action="reroll-seed"]',
    '.hud-devact[data-action="restart-round"]',
    '.hud-prodsave',
    '.hud-devreset',
  ]) {
    const a = await armOnly(page, sel);
    arming.push(a);
    log(`   armed ${sel}: ${JSON.stringify(a)}`);
  }
  // Another control's arm disarms the first; then the second is left to lapse.
  const first = '.hud-devact[data-action="restart-same-seed"]';
  const second = '.hud-devact[data-action="reroll-seed"]';
  await step(page, { click: first });
  const firstArmed = await page.textContent(first);
  await step(page, { click: second });
  const crossArm = {
    firstArmed,
    firstAfterSecondArmed: await page.textContent(first),
    secondArmed: await page.textContent(second),
  };
  await page.waitForTimeout(4500);
  crossArm.secondLapsed = await page.textContent(second);
  log(`   cross-arm: ${JSON.stringify(crossArm)}`);

  round.copyAfterArming = await press(page, '.hud-diag-copy');
  const seedAfter = seedOf(await page.evaluate(() => document.querySelector('.hud-diag-out').value));
  await page.waitForTimeout(1000);
  rec.snap('end of the arm');
  await Promise.all(rec.saves);
  await context.close();
  return {
    name: 'dev', query: '?dev=1', errors: rec.errors, failed: rec.failed, downloads: rec.downloads, snaps: rec.snaps,
    actionsAtMenuBeforeOpen, actionsAtMenu, actionsInRound, menu, round, arming, crossArm,
    seedBefore, seedAfter, worldNotRebuilt: seedBefore !== null && seedBefore === seedAfter,
    requested: population(rec.js),
  };
}

/** Starts sampling the field every 25 ms in the page; `stop` returns each distinct value with its time. */
const startSampling = (page) => page.evaluate(() => {
  const w = window;
  w.__fieldLog = [];
  let last = null;
  w.__fieldTimer = setInterval(() => {
    const f = document.querySelector('.hud-diag-out');
    const v = f ? `${f.classList.contains('hud-diag-out--hidden') ? '[hidden] ' : ''}${f.value.split('\n')[0].slice(0, 110)}` : null;
    // `ms` is performance.now(), the same clock as the press timestamps.
    if (v !== last) { w.__fieldLog.push({ ms: Math.round(performance.now()), v }); last = v; }
  }, 25);
});
const stopSampling = (page) => page.evaluate(() => { clearInterval(window.__fieldTimer); return window.__fieldLog; });

async function heldLoadArm() {
  log('arm 3 (?dev=1, the load held back 2.5 s): start');
  const { context, page, rec } = await freshPage();
  const held = [];
  await page.route(/\/assets\/dev-(actions|diagnostics|exports)-[^/]+\.js$/, async (route) => {
    held.push({ file: basename(new URL(route.request().url()).pathname), at: Date.now() });
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await pastSplash(page, '?dev=1');
  await step(page, { waitVisible: '.hud-panel' });
  await step(page, { click: '.hud-new-game' });
  await step(page, { waitHidden: '.hud-panel' });
  await page.waitForTimeout(2000);
  rec.snap('in a round, before the DEV badge');
  await startSampling(page);
  await step(page, { click: '.hud-devbadge' });
  await step(page, { waitVisible: '.hud-devtools' });
  // Pressed while the chunks are held (the actions are still hidden, so the catalogue is not
  // here): Copy, Download Screenshot and Download Diagnostics, clicked in ONE task so the two
  // exports read the round at the same instant. The round keeps simulating while the pane is
  // open from the badge (arm 2's two in-round exports read different ticks), so a frame or a
  // round read when the load lands would carry a later tick than this press.
  const beforeLoad = { actions: await labels(page), field: await field(page) };
  // Observers, installed by the probe: every select() on the field (Copy's selection), with the
  // text it selected, and every clipboard write with how it settled. They change nothing the page
  // does -- each calls through to the original.
  await page.evaluate(() => {
    const w = window;
    w.__selects = [];
    w.__clipboard = [];
    const select = HTMLTextAreaElement.prototype.select;
    HTMLTextAreaElement.prototype.select = function () {
      const r = select.call(this);
      if (this.classList.contains('hud-diag-out')) {
        w.__selects.push({
          ms: Math.round(performance.now()), head: this.value.split('\n')[0], chars: this.value.length,
          wholeTextSelected: this.selectionStart === 0 && this.selectionEnd === this.value.length,
          focused: document.activeElement === this,
        });
      }
      return r;
    };
    const cb = navigator.clipboard;
    if (cb && typeof cb.writeText === 'function') {
      const write = cb.writeText.bind(cb);
      cb.writeText = (text) => {
        const entry = { ms: Math.round(performance.now()), head: String(text).split('\n')[0], settled: 'pending' };
        w.__clipboard.push(entry);
        const p = write(text);
        p.then(() => { entry.settled = 'resolved'; }, (e) => { entry.settled = `rejected: ${e?.name ?? ''} ${e?.message ?? e}`; });
        return p;
      };
    }
  });
  const atPress = await page.evaluate(() => {
    const t = performance.now();
    for (const s of ['.hud-diag-copy', '.hud-export-screenshot', '.hud-export-diagnostics']) document.querySelector(s).click();
    const f = document.querySelector('.hud-diag-out');
    return { ms: Math.round(t), fieldValueAfterTheClicks: f.value, fieldHidden: f.classList.contains('hud-diag-out--hidden') };
  });
  await step(page, { waitVisible: '.hud-devact[data-action="reroll-seed"]' });
  // The same export pressed again, as soon as the load has landed: it reads the round now.
  const afterLand = await page.evaluate(() => {
    const t = performance.now();
    document.querySelector('.hud-export-diagnostics').click();
    return { ms: Math.round(t) };
  });
  await page.waitForFunction(() => /^Saved tanks-canvas/.test(document.querySelector('.hud-diag-out')?.value ?? ''), undefined, { timeout: T })
    .catch(() => { /* the field log below shows what it said instead */ });
  await page.waitForTimeout(1500);
  const fieldLog = await stopSampling(page);
  const end = { actions: await labels(page), field: await field(page) };
  const observed = await page.evaluate(() => ({ selects: window.__selects, clipboard: window.__clipboard }));
  rec.snap('after the held load landed');
  await Promise.all(rec.saves);
  await context.close();
  const tickOf = (name) => Number(/-tick(\d+)/.exec(name)?.[1] ?? NaN);
  const shot = rec.downloads.find((d) => d.startsWith('tanks-canvas'));
  const diags = rec.downloads.filter((d) => d.startsWith('tanks-diagnostics'));
  const ticks = {
    screenshotPressedBeforeLoad: tickOf(shot),
    diagnosticsPressedBeforeLoad: tickOf(diags[0]),
    diagnosticsPressedAfterLoad: tickOf(diags[1]),
    msBetweenThePresses: afterLand.ms - atPress.ms,
  };
  ticks.ticksBetweenThePresses = ticks.diagnosticsPressedAfterLoad - ticks.diagnosticsPressedBeforeLoad;
  return {
    name: 'dev-held-load', query: '?dev=1', held: held.map((h) => h.file),
    beforeLoad, atPress, afterLand, fieldLog, observed, end, ticks, downloads: rec.downloads, errors: rec.errors, failed: rec.failed, snaps: rec.snaps,
  };
}

async function failedLoadArm() {
  log('arm 4 (?dev=1, the three chunks aborted): start');
  const { context, page, rec } = await freshPage();
  const aborted = [];
  await page.route(/\/assets\/dev-(actions|diagnostics|exports)-[^/]+\.js$/, async (route) => {
    aborted.push(basename(new URL(route.request().url()).pathname));
    await route.abort('internetdisconnected');
  });
  await pastSplash(page, '?dev=1');
  await step(page, { waitVisible: '.hud-panel' });
  await step(page, { click: '.hud-devtools-open' });
  await step(page, { waitVisible: '.hud-devtools' });
  await page.waitForFunction(() => {
    const f = document.querySelector('.hud-diag-out');
    return !!f && !f.classList.contains('hud-diag-out--hidden') && f.value.length > 0;
  }, undefined, { timeout: T });
  const afterOpen = await page.evaluate(() => document.querySelector('.hud-diag-out').value);
  const copyAfterFailure = await press(page, '.hud-diag-copy');
  const copyText = await page.evaluate(() => document.querySelector('.hud-diag-out').value);
  await page.waitForTimeout(1000);
  const actions = await labels(page);
  rec.snap('after the failed load and a Copy');
  await context.close();
  return {
    name: 'dev-failed-load', query: '?dev=1', aborted, afterOpen, copyAfterFailure, copyText, actions,
    errors: rec.errors, failed: rec.failed, snaps: rec.snaps,
  };
}

try {
  const arms = [await ordinaryArm(), await devArm()];
  if (supplementary) arms.push(await heldLoadArm(), await failedLoadArm());
  const result = {
    root, port: PORT, chromium: browser.version(), probes: PROBES,
    dist: {
      ...population(allJs),
      // The script and modulepreload tags only (a comment in index.html also says `assets/index-<hash>.js`).
      namedByIndexHtml: [...readFileSync(join(root, 'dist', 'index.html'), 'utf8').matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\.\/assets\/([^"]+\.js)"[^>]*>/g)]
        .map((m) => `${m[1]} (${/rel="modulepreload"/.test(m[0]) ? 'modulepreload' : 'script'})`),
    },
    arms,
  };
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  const [a, b] = arms;
  console.log('');
  console.log(`DIST ${result.dist.files.length} js files, ${result.dist.bytes} B; index.html names ${JSON.stringify(result.dist.namedByIndexHtml)}`);
  for (const f of result.dist.files) console.log(`   ${f.file} ${f.bytes}`);
  console.log(`   probe strings in dist: ${JSON.stringify(result.dist.probes)}`);
  console.log(`ARM 1 ordinary: errors=${a.errors.length} failed=${a.failed.length} devChunks=${JSON.stringify(a.requested.devChunks)} probes=${JSON.stringify(a.requested.probes)}`);
  console.log(`   menu=${JSON.stringify(a.menuFacts)} round=${JSON.stringify(a.roundFacts)}`);
  for (const s of a.snaps) console.log(`   [${s.label}] ${s.cumulative.files.length} file(s), ${s.cumulative.bytes} B; new: ${s.newSincePrevious.join(' ') || '(none)'}`);
  for (const f of a.requested.files) console.log(`   ${f.file} ${f.bytes}`);
  console.log(`ARM 2 ?dev=1: errors=${JSON.stringify(b.errors)} failed=${b.failed.length} downloads=${JSON.stringify(b.downloads)}`);
  for (const s of b.snaps) console.log(`   [${s.label}] ${s.cumulative.files.length} file(s), ${s.cumulative.bytes} B; new: ${s.newSincePrevious.join(' ') || '(none)'}; probes so far: ${Object.keys(s.cumulative.probes).join(',') || 'none'}`);
  console.log(`   actions at menu before open: ${JSON.stringify(b.actionsAtMenuBeforeOpen)}`);
  console.log(`   actions in round: ${JSON.stringify(b.actionsInRound)}`);
  for (const [k, v] of Object.entries(b.menu)) console.log(`   menu.${k}: ${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(b.round)) console.log(`   round.${k}: ${JSON.stringify(v)}`);
  for (const r of b.arming) console.log(`   arm ${r.sel}: ${JSON.stringify(r.visible ? { resting: r.resting, armed: r.armed, lapsed: r.lapsed } : { visible: false })}`);
  console.log(`   cross-arm: ${JSON.stringify(b.crossArm)}`);
  console.log(`   seed before arming ${b.seedBefore}, after ${b.seedAfter}: worldNotRebuilt=${b.worldNotRebuilt}`);
  for (const f of b.requested.files) console.log(`   ${f.file} ${f.bytes}`);
  console.log(`   requested-file probes: ${JSON.stringify(b.requested.probes)}`);
  for (const x of arms.slice(2)) {
    const { snaps, ...rest } = x;
    console.log(`ARM ${x.name}:`);
    for (const [k, v] of Object.entries(rest)) console.log(`   ${k}: ${JSON.stringify(v)}`);
    for (const s of snaps) console.log(`   [${s.label}] new: ${s.newSincePrevious.join(' ') || '(none)'}`);
  }
} finally {
  await browser.close();
  server.kill();
}
