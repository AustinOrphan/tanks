// #1013 two-arm request-list probe against a built dist, served by `vite preview`.
//   node probe-requests-1013.mjs <worktree> <out.json> [<screenshot.png>]
//
// Method as recorded for #1012 (memory note two-arm-request-probe): `vite preview` spawned
// directly (not npx), the swiftshader args of tools/visual/verify.mjs, a fresh context per arm,
// every `.js` request recorded, the splash dismissed with Space, and the AudioContext override
// every browser tool installs (tools/shared/audio-context.mjs).
//
// Arm 1 (ordinary URL): past the splash to the Main Menu. Records every .js requested and the
//   child-element count of `.hud-selftest-list`.
// Arm 2 (?dev=1, positive control): past the splash, the screen recipe's `mixed` synthetic pads
//   installed through tools/screens/steps.mjs, Developer Tools opened through its real button
//   (requests snapshotted there), then Controller Self-Test opened through its real button until
//   a pad row is BUILT. The readout and the Copy report are read back.
import { spawn } from 'node:child_process';
import { statSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const [root, out, shot] = process.argv.slice(2);
if (!root || !out) throw new Error('usage: node probe-requests-1013.mjs <worktree> <out.json> [<shot.png>]');
const require = createRequire(join(root, 'package.json'));
const { chromium } = require('playwright');
const { audioContextOverrideSource } = await import(join(root, 'tools/shared/audio-context.mjs'));
const { runStep } = await import(join(root, 'tools/screens/steps.mjs'));
const PORT = 4396;
const base = `http://127.0.0.1:${PORT}/`;
const SELFTEST_CHUNK = /^controller-selftest-[A-Za-z0-9_-]+\.js$/;

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
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
log(`preview up on ${PORT}, pid ${server.pid}`);

const assets = join(root, 'dist', 'assets');
const sizeOf = (name) => { try { return statSync(join(assets, name)).size; } catch { return null; } };
const allJs = readdirSync(assets).filter((f) => f.endsWith('.js')).sort();
const withBytes = (list) => {
  const u = [...new Set(list)];
  return { js: u.map((f) => ({ file: f, bytes: sizeOf(f) })), jsBytes: u.reduce((n, f) => n + (sizeOf(f) ?? 0), 0) };
};

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
log(`chromium ${browser.version()}`);

async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(audioContextOverrideSource());
  const page = await context.newPage();
  const js = [];
  const errors = [];
  const failed = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith('.js')) js.push(basename(u.pathname));
  });
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, js, errors, failed };
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

async function ordinaryArm() {
  log('arm 1 (ordinary): start');
  const { context, page, js, errors, failed } = await freshPage();
  await pastSplash(page, '');
  log('arm 1: splash dismissed');
  await page.waitForSelector('.hud-panel:not(.hud-panel--hidden)', { timeout: 30000 });
  await page.waitForTimeout(2000); // let any trailing request land
  const facts = await page.evaluate(() => {
    const list = document.querySelector('.hud-selftest-list');
    const dev = document.querySelector('.hud-devtools-open');
    return {
      url: location.href,
      mainMenuShown: !document.querySelector('.hud-panel')?.classList.contains('hud-panel--hidden'),
      selfTestListExists: list !== null,
      selfTestListChildElements: list?.childElementCount ?? null,
      selfTestListChildNodes: list?.childNodes.length ?? null,
      selfTestPaneHidden: document.querySelector('.hud-selftest')?.classList.contains('hud-selftest--hidden') ?? null,
      devToolsEntryRendered: !!dev && getComputedStyle(dev).display !== 'none',
      builtBodyNodes: document.querySelectorAll('.hud-selftest-empty, .hud-selftest-pads, .hud-selftest-pad').length,
    };
  });
  await context.close();
  const req = withBytes(js);
  return {
    name: 'ordinary', query: '', facts, errors, failed,
    selftestChunkRequested: req.js.some((j) => SELFTEST_CHUNK.test(j.file)),
    ...req,
  };
}

async function devArm() {
  log('arm 2 (?dev=1): start');
  const { context, page, js, errors, failed } = await freshPage();
  await pastSplash(page, '?dev=1');
  log('arm 2: splash dismissed');
  // The screen state's own steps from here (tools/screens/states.mjs,
  // screen.devtools.controller-selftest), driven through the shared runner.
  await runStep(page, { fakeGamepads: 'mixed' }, 30000);
  await runStep(page, { click: '.hud-devtools-open' }, 30000);
  await runStep(page, { waitVisible: '.hud-devtools' }, 30000);
  log('arm 2: Developer Tools open');
  await page.waitForTimeout(1500); // anything Developer Tools itself requests lands here
  const atDevTools = withBytes(js);
  const listAtDevTools = await page.evaluate(
    () => document.querySelector('.hud-selftest-list')?.childElementCount ?? null,
  );
  const requestsBeforeOpen = js.length;
  await runStep(page, { click: '.hud-selftest-open' }, 30000);
  await runStep(page, { waitVisible: '.hud-selftest' }, 30000);
  log('arm 2: Controller Self-Test pane visible');
  let reached = false;
  try {
    await runStep(page, { waitVisible: '.hud-selftest-pad' }, 30000);
    reached = true;
    log('arm 2: pad row built (positive control reached)');
  } catch (e) {
    log(`arm 2: pad row NOT built: ${e.message}`);
  }
  await page.waitForTimeout(500);
  const requestedOnOpen = [...new Set(js.slice(requestsBeforeOpen))];
  const readout = await page.evaluate(() => {
    const list = document.querySelector('.hud-selftest-list');
    return {
      paneHidden: document.querySelector('.hud-selftest')?.classList.contains('hud-selftest--hidden') ?? null,
      listChildElements: list?.childElementCount ?? null,
      listChildClasses: Array.from(list?.children ?? []).map((c) => c.className),
      emptyHidden: document.querySelector('.hud-selftest-empty')?.classList.contains('hud-selftest-empty--hidden') ?? null,
      padRows: document.querySelectorAll('.hud-selftest-pad').length,
      padNames: Array.from(document.querySelectorAll('.hud-selftest-pad-name')).map((n) => n.textContent),
      channels: document.querySelectorAll('.hud-selftest-channel').length,
      channelValues: Array.from(document.querySelectorAll('.hud-selftest-channel-value')).map((n) => n.textContent),
      downChannels: document.querySelectorAll('.hud-selftest-channel--down').length,
      failedLine: document.querySelector('.hud-selftest-failed')?.textContent ?? null,
    };
  });
  if (shot) {
    await page.locator('.hud-selftest').screenshot({ path: shot });
    log(`arm 2: pane screenshot -> ${shot}`);
  }
  await page.click('.hud-selftest-copy');
  await page.waitForTimeout(300);
  const report = await page.evaluate(() => {
    const r = document.querySelector('.hud-selftest-report');
    const value = r?.value ?? null;
    return {
      shown: !!r && !r.classList.contains('hud-selftest-report--hidden') && getComputedStyle(r).display !== 'none',
      focused: document.activeElement === r,
      chars: value?.length ?? null,
      firstLines: value?.split('\n').slice(0, 6) ?? null,
    };
  });
  await context.close();
  const all = withBytes(js);
  return {
    name: 'dev-selftest', query: '?dev=1', reached, errors, failed,
    atDevTools: {
      ...atDevTools,
      selftestChunkRequested: atDevTools.js.some((j) => SELFTEST_CHUNK.test(j.file)),
      selfTestListChildElements: listAtDevTools,
    },
    requestedOnOpen: requestedOnOpen.map((f) => ({ file: f, bytes: sizeOf(f) })),
    selftestChunkRequestedOnOpen: requestedOnOpen.some((f) => SELFTEST_CHUNK.test(f)),
    readout, report,
    ...all,
  };
}

try {
  const a = await ordinaryArm();
  const b = await devArm();
  const result = {
    port: PORT,
    chromium: browser.version(),
    dist: {
      jsFiles: allJs.map((f) => ({ file: f, bytes: sizeOf(f) })),
      jsBytes: allJs.reduce((n, f) => n + sizeOf(f), 0),
    },
    arms: [a, b],
  };
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log('');
  console.log(`ARM 1 ordinary: chunkRequested=${a.selftestChunkRequested} errors=${a.errors.length} failed=${a.failed.length}`);
  console.log(`   facts=${JSON.stringify(a.facts)}`);
  for (const j of a.js) console.log(`   ${j.file} ${j.bytes}`);
  console.log(`   = ${a.jsBytes} bytes of JS requested (${a.js.length} file(s))`);
  console.log(`ARM 2 ?dev=1: reached=${b.reached} errors=${b.errors.length} failed=${b.failed.length}`);
  console.log(`   at Developer Tools: chunkRequested=${b.atDevTools.selftestChunkRequested} listChildElements=${b.atDevTools.selfTestListChildElements} files=${b.atDevTools.js.map((j) => j.file).join(' ')}`);
  console.log(`   requested on Self-Test open: ${b.requestedOnOpen.map((j) => `${j.file} ${j.bytes}`).join(', ') || '(none)'}`);
  console.log(`   readout: padRows=${b.readout.padRows} channels=${b.readout.channels} down=${b.readout.downChannels} emptyHidden=${b.readout.emptyHidden} listChildren=${JSON.stringify(b.readout.listChildClasses)} failedLine=${b.readout.failedLine}`);
  console.log(`   pads: ${JSON.stringify(b.readout.padNames)}`);
  console.log(`   copy report: shown=${b.report.shown} focused=${b.report.focused} chars=${b.report.chars}`);
  for (const j of b.js) console.log(`   ${j.file} ${j.bytes}`);
  console.log(`   = ${b.jsBytes} bytes of JS requested (${b.js.length} file(s))`);
  console.log(`DIST: ${result.dist.jsFiles.length} js files, ${result.dist.jsBytes} bytes`);
  for (const j of result.dist.jsFiles) console.log(`   ${j.file} ${j.bytes}`);
} finally {
  await browser.close();
  server.kill();
}
