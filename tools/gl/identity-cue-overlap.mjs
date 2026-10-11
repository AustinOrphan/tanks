/**
 * Runs tools/gl/identity-cue-overlap-page.ts in a real browser and prints, per player slot, the
 * pixels the enemy role cue shares with the owner identity marker (issue #1040), for the `shape`
 * marker and for the solid ring. See the page's header for the frame and the footprints.
 *
 * A tool, not a gate, the sibling of tools/gl/role-cue-overlap.mjs and the same
 * vite-then-chromium shape, including its refusal to run against a server it did not start. It
 * exits 1 only when a CONTROL fails or the page throws, because then the table cannot be trusted.
 *
 *   node tools/gl/identity-cue-overlap.mjs
 *   IDENTITY_CUE_DIR=/some/dir node tools/gl/identity-cue-overlap.mjs   # also writes the evidence
 *
 * First it runs the gallery CLI itself, with and without `--enemyRole` per marker, so the page can
 * prove both of its full frames are the CLI's frames to the pixel. That proof needs one rasteriser
 * on both sides, so this browser is launched with the CLI's own SwiftShader flags
 * (tools/gallery/run.mjs) and there is no host-GPU mode. `IDENTITY_CUE_DIR` receives the table as
 * JSON and markdown, the page's frames and the CLI's frames.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadChromium } from '../shared/playwright.mjs';

const PORT = Number(process.env.GL_TEST_PORT ?? 5181);
const BASE = `http://localhost:${PORT}/`;
const OUT = process.env.IDENTITY_CUE_DIR ?? null;
const ROOT = new URL('../../', import.meta.url).pathname;
const MARKERS = ['shape', 'ring'];
/**
 * The four CLI frames the page must reproduce, both frames the counts use per marker: `ring` is no
 * `--identityMarker`, `-nocue` no `--enemyRole`.
 */
const CLI = {
  'shape-cue': ['--identityMarker', 'shape', '--enemyRole', 'both'],
  'ring-cue': ['--enemyRole', 'both'],
  'shape-nocue': ['--identityMarker', 'shape'],
  'ring-nocue': [],
};
const cliArgs = (key) => ['--elements', 'identity', ...CLI[key],
  '--view', 'game', '--w', '640', '--h', '480', '--out', `gallery-out/identity-cue-overlap-${key}`];

const installed = JSON.parse(readFileSync(`${ROOT}node_modules/three/package.json`, 'utf8')).version;

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

const started = Date.now();
const cliFrames = {};
for (const key of Object.keys(CLI)) {
  console.error(`[identity-cue] npm run gallery -- ${cliArgs(key).join(' ')}`);
  const log = execFileSync(process.execPath, [`${ROOT}tools/gallery/run.mjs`, ...cliArgs(key)], { cwd: ROOT }).toString();
  process.stderr.write(log);
  if (!log.includes('pageerrors: none')) throw new Error(`the gallery CLI reported page errors for ${key}`);
  cliFrames[key] = `${ROOT}gallery-out/identity-cue-overlap-${key}/frame.png`;
}

const VITE_BIN = `${ROOT}node_modules/.bin/vite`;
const vite = spawn(VITE_BIN, ['--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
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
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  // NO AudioContext override here, deliberately (issue #877), for role-cue-overlap.mjs's reason:
  // this page is `tools/gl/identity-cue-overlap.html`, not the app, and its module imports the
  // posed gallery (src/render, src/presentation, src/sim) and none of src/audio, so no
  // AudioContext is ever constructed for an override to remove. The gallery CLI this runner
  // calls first installs its own.
  const page = await browser.newPage({ viewport: { width: 1320, height: 1000 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.text().startsWith('[identity-cue]')) console.error(m.text()); });
  const cli = Object.fromEntries(Object.entries(cliFrames).map(([k, f]) => [k, readFileSync(f).toString('base64')]));
  await page.addInitScript((frames) => { window.__identityCueCli = frames; }, cli);
  await page.goto(`${BASE}tools/gl/identity-cue-overlap.html`, { waitUntil: 'load', timeout: 600000 });
  // A module that fails to load raises a page error and never runs, so the wait ends on the
  // first page error as well as on the page's own result.
  const firstPageError = new Promise((_, reject) => page.once('pageerror', (e) => reject(new Error(`page error: ${e}`))));
  await Promise.race([
    page.waitForFunction(() => !!window.__identityCue || window.__identityCueError, undefined, { timeout: 600000, polling: 500 }),
    firstPageError,
  ]);
  const { result, failure } = await page.evaluate(() => ({ result: window.__identityCue, failure: window.__identityCueError }));
  for (const e of pageErrors) console.error(`page error: ${e}`);
  if (failure) throw new Error(`the measurement threw: ${failure}`);
  if (!result) throw new Error('the page produced no table');
  const { rows, controls, width, height, dumps } = result;
  delete result.dumps;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const lines = [];
  lines.push(`three ${installed}, software-gl (SwiftShader), ${width}x${height} frames, view game, dpr 1, `
    + `posed identity element: 4 player tanks (slots 0-3) x 2 markers = ${rows.length} cells, ${seconds} s`);
  lines.push('');
  lines.push('Owner footprint: the pixels that differ when that slot\'s identity-ring is hidden, in the frame with the cue absent and again with it drawn.');
  lines.push('Cue footprint: the pixels that differ when that slot\'s mine-block is hidden, under --enemyRole both. Shared: owner (cue absent) and own cue.');
  lines.push('Covered: of the shared pixels, those outside the cue-drawn owner footprint, i.e. ring pixels the riser hides. Shared, cue-drawn owner: pixels both draw into.');
  lines.push('');
  lines.push('| marker | slot | body angle | owner px, cue absent | owner px, cue drawn | cue px | shared px | covered px | shared px, cue-drawn owner | shared px with other slots\' cues |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    lines.push(`| ${r.marker} | ${r.slot} | ${r.bodyAngle} deg | ${r.ownerNoCue} | ${r.ownerWithCue} | ${r.cue} | ${r.shared} | ${r.covered} | ${r.sharedWithCue} | ${r.sharedOtherSlots} |`);
  }
  lines.push('');
  for (const marker of MARKERS) {
    const nonzero = rows.filter((r) => r.marker === marker && (r.shared > 0 || r.sharedOtherSlots > 0)).map((r) => r.slot);
    lines.push(`Slots with a nonzero shared count, ${marker} (population: 4 slots): ${nonzero.length ? nonzero.join(', ') : 'none'}.`);
  }
  lines.push('');
  for (const key of Object.keys(CLI)) lines.push(`CLI frame, ${key}: npm run gallery -- ${cliArgs(key).join(' ')}`);
  lines.push('');
  lines.push('| control | result | detail |');
  lines.push('| --- | --- | --- |');
  for (const c of controls) lines.push(`| ${c.name} | ${c.pass ? 'pass' : 'FAIL'} | ${c.detail} |`);
  const text = lines.join('\n');
  console.log(text);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/identity-cue-overlap.json`, `${JSON.stringify({ installed, visual: 'software-gl', seconds: Number(seconds), ...result }, null, 2)}\n`);
    writeFileSync(`${OUT}/identity-cue-overlap.md`, `${text}\n`);
    for (const [name, url] of Object.entries(dumps)) writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    for (const [key, file] of Object.entries(cliFrames)) copyFileSync(file, `${OUT}/cli-${key}.png`);
  }
  if (controls.some((c) => !c.pass) || pageErrors.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
