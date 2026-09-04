/**
 * Runs tools/gl/harness.ts in a real browser and reports its results.
 *
 * scene.ts and renderer.ts cannot be constructed under vitest -- they build a
 * WebGLRenderer -- so their tests live here rather than in sibling .test.ts
 * files. This runs in the `visual` CI job, which already has chromium, and
 * locally via `npm run test:gl`.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.GL_TEST_PORT ?? 5177);
const BASE = `http://localhost:${PORT}/`;
/** Something only THIS harness serves, used to prove we are testing our own build. */
const MARKER = '__glResults';

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

// REFUSE to run against a server we did not start. A stale dev server -- from
// another worktree, or a previous run that leaked -- answers a readiness poll
// perfectly happily, and the suite then tests code it never built while
// reporting success. That happened: a sibling worktree's server served an older
// harness and this runner passed 5 checks of 11 without noticing the other 6
// were missing. Failing loudly here is the whole point.
if (await respondsOn(BASE)) {
  console.error(
    `Something is already listening on ${BASE}.\n` +
      'Refusing to run: it would be tested instead of this checkout.\n' +
      "Stop it (pkill -f 'vite --port') or set GL_TEST_PORT to a free port.",
  );
  process.exit(2);
}

// Spawn vite DIRECTLY, not through npx. npx forks the real binary as a
// grandchild, so killing the npx process leaves vite holding the port -- which
// is what caused every "port busy" refusal while developing this, and, worse,
// two false SURVIVED verdicts in a mutation sweep whose runs never actually
// started.
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

  // Belt and braces: prove the server is serving THIS harness.
  const served = await (await fetch(`${BASE}tools/gl/harness.ts`)).text();
  if (!served.includes(MARKER)) {
    throw new Error(`the server on ${BASE} is not serving this checkout's harness`);
  }

  const chromium = await loadChromium();
  browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // `load` is a WEAK readiness signal here and the budget has to reflect that. The harness
  // module uses top-level await, which makes it an async module the load event does not
  // wait for -- so this resolves once vite has transformed and served the graph, long
  // before any check has run, and the real signal is `__glResults` below. Playwright's
  // default 30s is a transform budget rather than a work budget, and on a loaded machine
  // with a cold vite cache it is not enough: this call is what failed, on a tree with no
  // changes to the harness at all, before the guard below was ever reached. 120s, for the
  // same reason the guard below is generous -- a bare TimeoutError with no check output
  // reads as a broken harness rather than a slow one.
  await page.goto(`${BASE}tools/gl/harness.html`, { waitUntil: 'load', timeout: 120000 });
  // A LIVENESS guard, not an assertion: nothing about the checks depends on this number,
  // and a harness that hangs is caught just as well at 600s as at 30s. It has now been
  // raised twice, and the second raise is worth recording in full because the first one's
  // measurement no longer describes any machine anyone runs this on.
  //
  // The 30s -> 90s raise was measured on a 4 GB CI-shaped box with no GPU: 15676 / 15937 /
  // 15977 ms (n=3), so 90s was a comfortable ~5.6x. On a 2026 developer Mac, also under
  // `--use-gl=swiftshader`, the same page took 87.6s -- five and a half times longer than
  // the box the old margin was sized against, and 97% of the budget it was given. It was
  // already failing here on the odd run before anything was added to it.
  //
  // What forced the second raise is not only that this branch's smoke-cost checks add four
  // more WebGLRenderer constructions and their shader compiles. It is the SPREAD. Timed around
  // this call on that Mac, this branch came in at 113s, 175s and (with a mutation applied
  // that made every arm draw smoke) 411s, while the machine was doing other work in
  // parallel -- which a developer's machine always is. A budget sized to the fastest of
  // those turns an ordinary busy afternoon into a bare TimeoutError with no check output,
  // and that reads as a broken harness rather than a slow one.
  //
  // 600s is therefore a ceiling for a HANG, not a budget for the work: the cost of setting
  // it too low is a misleading failure on a page that would have answered, and the cost of
  // setting it too high is waiting on one that never will. CI's own box is the fast case
  // here, not the slow one, so this does not slow the `visual` job down -- it only stops
  // the local run from lying about why it failed.
  await page.waitForFunction(() => !!window.__glResults, undefined, { timeout: 600000 });
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
  // An empty or short result set must not read as success: a harness that dies
  // partway leaves the checks it never reached looking like they passed.
  if (results.length === 0) {
    failed++;
    console.log('  FAIL  the harness produced no results at all');
  }
  console.log(
    failed === 0 ? `\nall ${results.length} GL checks passed` : `\n${failed} GL check(s) FAILED`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  if (browser) await browser.close();
  // SIGTERM is not instant, and the guard above refuses to start while anything
  // is listening -- so without this, two runs back to back have the second one
  // refuse on the first one's dying server. That is not hypothetical: it made a
  // mutation sweep report two false SURVIVED verdicts, because a refused run
  // looks like a passing one to anything that only greps the output.
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
