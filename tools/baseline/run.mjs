/**
 * Runs the golden trace (tools/baseline/trace.ts) in a REAL browser and prints its
 * fingerprint, per engine.
 *
 * Why this exists: the sim's cross-engine bit-equality is the single gating measurement
 * for any peer-deterministic multiplayer -- lockstep and rollback both die if two engines
 * disagree by one ULP on Math.hypot or Math.cos, and the sim has 21 transcendental calls
 * on 18 lines (docs/research/multiplayer.md). This tool does not ANSWER that question. It
 * makes the answer a one-command check:
 *
 *   npm run trace:browser -- --browser chromium,firefox,webkit
 *
 * What a green run proves is bounded, and the bound matters:
 *   - Playwright's webkit is a JavaScriptCore build, NOT shipped Safari, and there is no
 *     iOS engine here at all. The Safari/iOS half of the question stays OPEN however this
 *     exits. Take that half by opening tools/baseline/page.html by hand on the device
 *     (`npx vite` then http://localhost:5173/tools/baseline/page.html -- localhost is
 *     required, crypto.subtle is secure-context only).
 *   - It says nothing about other CPU architectures; every run here is x86-64.
 *
 * Structure follows tools/gl/run.mjs, including its two hard-won refusals: never test a
 * server we did not start, and spawn vite directly rather than through npx.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from './args.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}

const BASE = `http://localhost:${opts.port}/`;
/** Something only THIS page serves, used to prove we are testing our own checkout. */
const MARKER = '__traceResult';

async function respondsOn(url, ms = 1000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return false;
  }
}

async function loadPlaywright() {
  const tried = [];
  for (const spec of [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/home/dev/.claude/jobs/17681316/tmp/pw/node_modules/playwright/index.mjs',
  ].filter(Boolean)) {
    try {
      const m = await import(spec);
      if (m.chromium) return m;
      tried.push(`${spec}: no chromium export`);
    } catch (e) {
      tried.push(`${spec}: ${e.code ?? e.message}`);
    }
  }
  throw new Error(`playwright not found. Tried:\n  ${tried.join('\n  ')}`);
}

if (await respondsOn(BASE)) {
  console.error(
    `Something is already listening on ${BASE}.\n` +
      'Refusing to run: it would be traced instead of this checkout.\n' +
      "Stop it (pkill -f 'vite --port') or pass --port with a free port.",
  );
  process.exit(2);
}

const VITE_BIN = new URL('../../node_modules/.bin/vite', import.meta.url).pathname;
const vite = spawn(VITE_BIN, ['--port', String(opts.port), '--strictPort'], { stdio: 'ignore' });
let viteExited = false;
vite.on('exit', () => {
  viteExited = true;
});

let failed = 0;
const results = [];
try {
  for (let i = 0; ; i++) {
    if (viteExited) throw new Error('vite exited before serving; is the port taken?');
    if (await respondsOn(BASE)) break;
    if (i > 60) throw new Error(`vite did not start on ${BASE} within 30s`);
    await sleep(500);
  }

  const served = await (await fetch(`${BASE}tools/baseline/page.html`)).text();
  if (!served.includes(MARKER)) {
    throw new Error(`the server on ${BASE} is not serving this checkout's page`);
  }

  const playwright = await loadPlaywright();

  for (const name of opts.browsers) {
    let browser;
    try {
      browser = await playwright[name].launch();
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(`${BASE}tools/baseline/page.html`, { waitUntil: 'load' });
      // Generous: the trace is ~4 s of blocked main thread under Node and slower engines
      // are slower still. A timeout here is a real failure, not flake -- report it.
      await page.waitForFunction(() => !!window.__traceResult, { timeout: 180_000 });
      const r = await page.evaluate(() => window.__traceResult);
      for (const e of pageErrors) console.log(`  page error [${name}] -- ${e}`);
      results.push({ name, ...r, pageErrors: pageErrors.length });
      if (r.error) {
        failed++;
        console.log(`  FAIL  ${name}: ${r.error}`);
      } else {
        console.log(
          `  ${r.match ? 'MATCH' : 'MISMATCH'}  ${name}  ${r.hash}  (${r.ms} ms, ${r.textLength} chars)`,
        );
        console.log(`        ${r.userAgent}`);
        if (!r.match) failed++;
      }
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}: ${e.message ?? e}`);
    } finally {
      if (browser) await browser.close();
    }
  }

  // An empty result set must not read as success -- the same trap tools/gl/run.mjs names.
  if (results.length === 0) {
    failed++;
    console.log('  FAIL  no browser produced a result at all');
  }

  const hashes = new Set(results.filter((r) => r.hash).map((r) => r.hash));
  console.log('');
  if (hashes.size > 1) {
    console.log(`ENGINES DISAGREE: ${hashes.size} distinct hashes across ${results.length} run(s).`);
    console.log('That is the answer to docs/research/multiplayer.md open question 1 for');
    console.log('these engines: peer-deterministic netcode needs the sim quantized first.');
  } else if (failed === 0) {
    console.log(
      `all ${results.length} engine(s) agree with the pinned baseline: ${[...hashes][0]}`,
    );
    console.log('Engines covered: ' + opts.browsers.join(', ') + '.');
    console.log('NOT covered: shipped Safari, iOS, and any non-x86-64 CPU.');
  }
  console.log(failed === 0 ? '' : `${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  vite.kill('SIGTERM');
  let freed = false;
  for (let i = 0; i < 20; i++) {
    if (!(await respondsOn(BASE, 300))) { freed = true; break; }
    await sleep(250);
  }
  if (!freed) {
    vite.kill('SIGKILL');
    for (let i = 0; i < 20; i++) {
      if (!(await respondsOn(BASE, 300))) { freed = true; break; }
      await sleep(250);
    }
  }
  if (!freed) console.error(`warning: ${BASE} still answering after SIGKILL`);
}
