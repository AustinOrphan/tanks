/**
 * Runs tools/gl/role-cue-overlap-page.ts in a real browser and prints the role-cue overlap
 * table (issue #1018): for each kind, lever, event, preset, motion policy, effect and sampled
 * tick, the cue's no-effect footprint and how much of it still differs under the effect.
 *
 * A tool, not a gate. It exits 1 only when a CONTROL fails or the page throws, because then the
 * table cannot be trusted; what the table says about the cue is for a person to read. Same
 * vite-then-chromium shape as tools/gl/phase-cost.mjs, including its refusal to run against a
 * server it did not start.
 *
 *   node tools/gl/role-cue-overlap.mjs                     # host GPU, the whole table
 *   ROLE_CUE_VISUAL=software-gl node tools/gl/role-cue-overlap.mjs
 *   ROLE_CUE_OUT=table.json ROLE_CUE_MD=table.md node tools/gl/role-cue-overlap.mjs
 *
 * `ROLE_CUE_QUERY` passes page parameters through (`presets=high&motions=full&ticks=0,6`), for
 * a quick run; the published table uses the defaults.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadChromium } from '../shared/playwright.mjs';

const PORT = Number(process.env.GL_TEST_PORT ?? 5181);
const BASE = `http://localhost:${PORT}/`;
const VISUAL = process.env.ROLE_CUE_VISUAL ?? 'host-gpu';
const QUERY = process.env.ROLE_CUE_QUERY ?? '';

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

const launchArgs = VISUAL === 'software-gl'
  ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
  : ['--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];

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
  browser = await chromium.launch({ args: launchArgs });
  // NO AudioContext override here, deliberately (issue #877), for phase-cost.mjs's reason: this
  // page is `tools/gl/role-cue-overlap.html`, not the app, and its module imports src/render and
  // src/sim only, neither of which reaches src/audio (`src/sim/purity.test.ts` keeps the sim's
  // half true), so no AudioContext is ever constructed for an override to remove.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // Progress lines, so a long run on a slow rasteriser shows where it is.
  page.on('console', (m) => { if (m.text().startsWith('[role-cue]')) console.error(m.text()); });
  const started = Date.now();
  await page.goto(`${BASE}tools/gl/role-cue-overlap.html${QUERY ? `?${QUERY}` : ''}`, { waitUntil: 'load', timeout: 900000 });
  // A module that fails to load raises a page error and never runs, so the wait ends on the
  // first page error as well as on the page's own result.
  const firstPageError = new Promise((_, reject) => page.once('pageerror', (e) => reject(new Error(`page error: ${e}`))));
  await Promise.race([
    page.waitForFunction(() => !!window.__roleCue || window.__roleCueError, undefined, { timeout: 1800000, polling: 1000 }),
    firstPageError,
  ]);
  const { result, failure } = await page.evaluate(() => ({ result: window.__roleCue, failure: window.__roleCueError }));
  for (const e of pageErrors) console.error(`page error: ${e}`);
  if (failure) throw new Error(`the measurement threw: ${failure}`);
  if (!result) throw new Error('the page produced no table');
  const { rows, controls, ticks, width, height, dumps } = result;
  delete result.dumps;
  if (process.env.ROLE_CUE_DUMP) {
    mkdirSync(process.env.ROLE_CUE_DUMP, { recursive: true });
    for (const [name, url] of Object.entries(dumps ?? {})) {
      writeFileSync(`${process.env.ROLE_CUE_DUMP}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
  const num = (x) => (x === null ? '-' : x.toFixed(3));
  const lines = [];
  lines.push(`three ${installed}, ${VISUAL}, ${width}x${height} frames, ticks ${ticks.join(', ')}, ${rows.length} cells, ${seconds} s`);
  lines.push('');
  lines.push('| kind | lever | event | preset | motion | pose | effect | tick | footprint px | retained px | retained | dim ratio |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    lines.push(`| ${r.kind} | ${r.lever} | ${r.event} | ${r.preset} | ${r.motion} | ${r.pose} | ${r.effect} | ${r.tick} | ${r.footprint} | ${r.retained} | ${pct(r.retainedFraction)} | ${num(r.dimRatio)} |`);
  }
  lines.push('');
  lines.push('| control | preset | motion | pose | result | detail |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of controls) lines.push(`| ${c.name} | ${c.preset} | ${c.motion} | ${c.pose} | ${c.pass ? 'pass' : 'FAIL'} | ${c.detail} |`);
  const occluded = rows.filter((r) => r.footprint > 0 && r.retained === 0);
  lines.push('');
  lines.push(occluded.length === 0
    ? `Complete occlusion: none. No sampled cell with a nonzero footprint reached a retained fraction of 0 (population: ${rows.filter((r) => r.footprint > 0).length} cells).`
    : `COMPLETE OCCLUSION in ${occluded.length} cell(s): ${occluded.map((r) => `${r.kind} ${r.lever} ${r.event} ${r.preset} ${r.motion} ${r.pose} ${r.effect} t${r.tick}`).join('; ')}`);
  const text = lines.join('\n');
  console.log(text);
  if (process.env.ROLE_CUE_OUT) writeFileSync(process.env.ROLE_CUE_OUT, JSON.stringify({ installed, visual: VISUAL, ...result }, null, 2));
  if (process.env.ROLE_CUE_MD) writeFileSync(process.env.ROLE_CUE_MD, `${text}\n`);
  const failed = controls.filter((c) => !c.pass);
  if (failed.length || pageErrors.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
