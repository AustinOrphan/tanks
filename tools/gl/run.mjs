/**
 * Runs tools/gl/harness.ts in a real browser and reports its results.
 *
 * scene.ts cannot be constructed under vitest -- it builds a WebGLRenderer --
 * so these tests live here instead of in a sibling .test.ts. They run in the
 * `visual` CI job, which already has chromium.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

async function loadChromium() {
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright',
    '/home/dev/.claude/jobs/17681316/tmp/pw/node_modules/playwright/index.mjs'].filter(Boolean)) {
    try { const m = await import(spec); if (m.chromium) return m.chromium; } catch { /* next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_MODULE or npm i -D playwright');
}

const PORT = process.env.GL_TEST_PORT ?? '5177';
const vite = spawn('npx', ['vite', '--port', PORT, '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  // Wait for the dev server rather than sleeping a fixed amount.
  const base = `http://localhost:${PORT}/`;
  for (let i = 0; ; i++) {
    try { await fetch(base); break; } catch {
      if (i > 60) throw new Error('vite did not start');
      await sleep(500);
    }
  }

  const chromium = await loadChromium();
  browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${base}tools/gl/harness.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__glResults, { timeout: 30000 });
  const results = await page.evaluate(() => window.__glResults);

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` -- ${r.detail}`}`);
  }
  for (const e of pageErrors) {
    failed++;
    console.log(`  FAIL  page error -- ${e}`);
  }
  // An empty result set must not read as success.
  if (results.length === 0) {
    failed++;
    console.log('  FAIL  the harness produced no results at all');
  }
  console.log(failed === 0 ? `\nall ${results.length} GL checks passed` : `\n${failed} GL check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
