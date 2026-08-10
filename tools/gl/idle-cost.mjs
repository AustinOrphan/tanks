/**
 * Measures what the Customize preview's idle spin costs, in a real browser.
 *
 * A tool, not a gate: it prints numbers and exits 0. See tools/gl/idle-cost.ts for what
 * is timed and what is left out. Same vite-then-chromium shape as tools/gl/run.mjs,
 * including its refusal to run against a server it did not start.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.GL_TEST_PORT ?? 5178);
const BASE = `http://localhost:${PORT}/`;

async function respondsOn(url, ms = 1000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return false;
  }
}

async function loadChromium() {
  const tried = [];
  for (const spec of [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/home/dev/.claude/jobs/17681316/tmp/pw/node_modules/playwright/index.mjs',
  ].filter(Boolean)) {
    try {
      const m = await import(spec);
      if (m.chromium) return m.chromium;
      tried.push(`${spec}: no chromium export`);
    } catch (e) {
      tried.push(`${spec}: ${e.code ?? e.message}`);
    }
  }
  throw new Error(`playwright not found. Tried:\n  ${tried.join('\n  ')}`);
}

if (await respondsOn(BASE)) {
  console.error(`Something is already listening on ${BASE}. Refusing to run.`);
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
    if (i > 60) throw new Error(`vite did not start on ${BASE} within 30s`);
    await sleep(500);
  }

  const chromium = await loadChromium();
  browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', String(e)));
  await page.goto(`${BASE}tools/gl/idle-cost.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__idleCost, { timeout: 120000 });
  const { samples, notes } = await page.evaluate(() => window.__idleCost);

  const pad = (s, n) => String(s).padStart(n);
  console.log(
    `${'sample'.padEnd(46)} ${pad('frames', 7)} ${pad('fps', 6)} ${pad('mean ms', 8)} ${pad('p50', 7)} ${pad('p95', 7)} ${pad('max', 7)} ${pad('main-thread %', 14)}`,
  );
  for (const s of samples) {
    console.log(
      `${s.label.padEnd(46)} ${pad(s.frames, 7)} ${pad(s.fps.toFixed(1), 6)} ${pad(s.meanMs.toFixed(3), 8)} ${pad(s.p50Ms.toFixed(3), 7)} ${pad(s.p95Ms.toFixed(3), 7)} ${pad(s.maxMs.toFixed(3), 7)} ${pad(s.mainThreadPct.toFixed(2), 14)}`,
    );
  }
  for (const n of notes) console.log(`note: ${n}`);

  // The visibility probe: start the loop, background this tab, count what still runs.
  await page.evaluate(() => window.__vis.start());
  await sleep(1000);
  const visibleFrames = await page.evaluate(() => window.__vis.mark());
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await sleep(3000);
  const hidden = await page.evaluate(() => window.__vis.read());
  await page.bringToFront();
  await sleep(1000);
  const back = await page.evaluate(() => window.__vis.read());
  await page.evaluate(() => window.__vis.stop());
  console.log(
    `\nvisibility: ${visibleFrames} frames in the first 1000ms (foreground), ` +
      `${hidden.frames - visibleFrames} frames in the next 3000ms while ` +
      `document.visibilityState reported "${hidden.visibility}", ` +
      `${back.frames - hidden.frames} frames in the 1000ms after refocusing ` +
      `(state "${back.visibility}")`,
  );
  await other.close();

  // The browser's OWN accounting, which sees the compositing and raster tasks the
  // in-page rAF timer cannot: renderer-process main-thread TaskDuration over the same
  // window, spin on vs spin off.
  console.log('');
  for (const [label, query] of [
    ['preview, spin ON        ', 'kind=preview&reduced=0'],
    ['preview, spin OFF (ctrl)', 'kind=preview&reduced=1'],
    ['bare rAF loop, no WebGL ', 'kind=raf'],
    ['nothing at all   (ctrl) ', 'kind=none'],
  ]) {
    const p = await context.newPage();
    await p.goto(`${BASE}tools/gl/idle-cost.html?mode=probe&${query}`, {
      waitUntil: 'load',
    });
    await p.waitForFunction(() => !!window.__vis, { timeout: 60000 });
    const cdp = await context.newCDPSession(p);
    await cdp.send('Performance.enable');
    const read = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    };
    await p.evaluate(() => window.__vis.start());
    const before = await read();
    await sleep(10000);
    const after = await read();
    const frames = await p.evaluate(() => window.__vis.mark());
    await p.evaluate(() => window.__vis.stop());
    console.log(
      `task accounting, ${label}: ` +
        `${frames} frames, TaskDuration +${((after.TaskDuration - before.TaskDuration) * 1000).toFixed(1)}ms, ` +
        `ScriptDuration +${((after.ScriptDuration - before.ScriptDuration) * 1000).toFixed(1)}ms, ` +
        `LayoutDuration +${((after.LayoutDuration - before.LayoutDuration) * 1000).toFixed(1)}ms ` +
        `over ${((after.Timestamp - before.Timestamp)).toFixed(2)}s wall`,
    );
    await cdp.detach();
    await p.close();
  }
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
  for (let i = 0; i < 20; i++) {
    if (!(await respondsOn(BASE, 300))) break;
    await sleep(250);
  }
}
