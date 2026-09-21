/**
 * Runs tools/gl/harness.ts in a real browser and reports its results.
 *
 * scene.ts and renderer.ts cannot be constructed under vitest -- they build a
 * WebGLRenderer -- so their tests live here rather than in sibling .test.ts
 * files. This runs in the `visual` CI job, which already has chromium, and
 * locally via `npm run test:gl`.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadChromium } from '../shared/playwright.mjs';

const PORT = Number(process.env.GL_TEST_PORT ?? 5177);
const BASE = `http://localhost:${PORT}/`;
/** Something only THIS harness serves, used to prove we are testing our own build. */
const MARKER = '__glResults';
/**
 * The three version these timings belong to, read from the INSTALLED package (issue #867).
 * `npm i --no-save three@0.169.0` moves the install and leaves package.json's `^0.186.0`
 * alone, so a profile labelled from the manifest would label both arms identically -- the
 * dead-knob failure that makes an A/B look like one sample twice.
 */
const threeVersion = JSON.parse(
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
  // NO AudioContext override here, deliberately (issue #877). This page is
  // `tools/gl/harness.html`, not the app: nothing on it runs the boot path, so neither of
  // the two constructions that made the app wedge (Howler's, and `engine.ts`'s `ensureCtx`)
  // happens. `harness.ts` DOES import `src/audio/synth`, `music` and `music-data` -- the
  // table in #877 has that wrong -- but every context it builds is an
  // `OfflineAudioContext` (harness.ts's `renderOffline`), which the override leaves alone
  // and which never touches the audio device. Installing it here would therefore change
  // nothing except what a reader has to verify.
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
  //
  // THE THIRD RAISE, 120s -> 600s, is three r186's (issue #800), and its original rationale
  // was WRONG about the mechanism. That rationale said the page waits on the browser parsing
  // and evaluating vite's pre-bundled `three` -- 17.8s on 0.169 against 92.9s on 0.186. Issue
  // #812 re-measured it on this tree (vite 8.3.0, node 24, one box, three restored and read
  // back between arms) and the dependency is not the cost:
  //
  //                                        0.169.0        0.186.0      ratio
  //   harness page to `load`               8,158 ms      48,246 ms      5.9x
  //   `load` to `__glResults`             93.5-97.9 s   218.0-220.5 s   2.3x
  //   requests during load                 100            100           1.0x
  //   of those, three-related                1              1           same
  //   content-length total                 9.19 MB       11.23 MB       1.22x
  //   deps/three.js                        1,120,664 B   1,895,457 B    1.69x
  //   in-page import of deps/three.js,
  //     first load, proven uncached          104.3 ms      193.0 ms     1.85x
  //
  // So the regression IS real -- the page takes about six times longer to load -- but the
  // pre-bundled dependency accounts for ~89 ms of roughly 40,000 ms, about 0.2% of it. The
  // request count is identical in both arms and only one request is three's, so it is not a
  // module storm either, and transfer grew 1.22x against a 5.9x slowdown.
  //
  // WHERE IT DOES GO, read from the browser's own timing rather than by subtraction:
  //
  //                                        0.169.0        0.186.0
  //   responseEnd (the HTML document)        85.7 ms        94.1 ms
  //   summed resource duration (UPPER
  //     bound; requests overlap)          9,863 ms       13,522 ms
  //   domContentLoaded                    7,931 ms       48,169 ms
  //   slowest single resource               169 ms          221 ms
  //
  // The document arrives in under 100 ms and no single request stalls. Every extra second falls
  // between `responseEnd` and `domContentLoaded`, and the summed fetch is an upper bound of
  // 13.5s across OVERLAPPING requests -- so the bulk is MAIN-THREAD EVALUATION of the
  // application's own module graph, not fetching and not the dependency. Issue #812 holds the
  // tables and what is still unexplained: why evaluating those modules got ~6x slower when the
  // dependency they all import got 89 ms slower.
  //
  // A SECOND regression the original note missed: the GL phase AFTER `load` also more than
  // doubled, 93.5-97.9s to 218.0-220.5s, which no bundle size explains.
  //
  // WHERE THAT PHASE GOES, per check (issue #867, and see that issue's own comments, which hold
  // the deeper probes). Every check is now timed around its own body and the table is written
  // by `GL_PROFILE_OUT=<path> npm run test:gl`, labelled with the INSTALLED three read from
  // node_modules -- `npm i --no-save three@x` moves the install and leaves package.json's
  // `^0.186.0` alone, so a manifest label would label both arms identically.
  //
  // IT IS EVERY CHECK, not one. One sample per arm on this box, both in one session, three
  // swapped and read back, `vite optimize --force` before each, 94 checks passing in both:
  //
  //                                        0.169.0        0.186.0      ratio
  //   summed time inside check bodies      116.3 s        477.4 s       4.11x
  //   checks slower / faster                                          87 / 7 of 94
  //   median per-check ratio (the 74
  //     checks >=200 ms in the old arm)                                  7.30x
  //
  // The ten biggest absolute growers are 36% of the added 361 s, and the most expensive check
  // in BOTH arms grew least (1.48x) -- so the biggest number in the profile is not the
  // regression, and optimising it would be optimising the wrong thing.
  //
  // WHAT THE MECHANISM IS NOT. #867's own comments measured the primitives directly and ruled
  // out renderer construction (`new WebGLRenderer` + dispose, 0.96-1.09x), `createScene` at
  // both shipped presets (0.99x / 1.12x), scene-graph construction in node (1.02x over 300
  // rounds), steady-state rasterization (1.02-1.08x) and readback (1.17-1.33x) -- every
  // primitive between 0.96x and 1.36x while the harness sits at 2.3-4.1x. The same work is
  // charged more, and SwiftShader charges it at the first call that blocks, which here is
  // `readPixels`. Do not read a per-check number as the cost of what that check's body
  // textually contains: the queue it drains was filled earlier.
  //
  // The absolute seconds here are larger than the two-sample-per-arm run recorded on the issue
  // on 2026-09-20 (103.9 s -> 273.5 s, 2.63x). Same instrument, same box, different day and
  // different load. Treat the ratio as the contrast and nothing here as a per-machine cost.
  //
  // WHY 600s SURVIVES THAT CORRECTION. A whole run on 0.186 is about 48s to `load` plus 218s
  // to results, so ~266s; 600s is ~2.3x that, which is the margin a hang ceiling wants and
  // matches the guard below. The number was right; only the reason for it was not.
  //
  // This is a DEVELOPMENT SERVER cost, not a shipped one: the production build tree-shakes
  // the same import down to a 1.17 MB bundle, and `npm run visual` (which runs against
  // `dist`) was unaffected.
  await page.goto(`${BASE}tools/gl/harness.html`, { waitUntil: 'load', timeout: 600000 });
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
  // WHERE THE POST-LOAD PHASE GOES (issue #867). The phase from `load` to `__glResults` is the
  // larger half of a run here, and an aggregate cannot tell one check that grew 50x from every
  // check growing 2x. Printed always rather than behind a flag: it is two lines, and a number
  // nobody can see is a number nobody compares. `ms` is measured inside the page, around each
  // check's own body, so it excludes module evaluation and the runner's own round trips --
  // which is why the sum below is less than the phase the runner times.
  const timed = results.filter((r) => typeof r.ms === 'number');
  if (timed.length > 0) {
    const total = timed.reduce((a, r) => a + r.ms, 0);
    const slowest = [...timed].sort((a, b) => b.ms - a.ms).slice(0, 10);
    console.log(`\n  ${timed.length} timed check(s), ${(total / 1000).toFixed(1)}s inside check bodies`);
    for (const r of slowest) {
      console.log(`    ${(r.ms / 1000).toFixed(2).padStart(7)}s  ${((r.ms / total) * 100).toFixed(1).padStart(5)}%  ${r.name}`);
    }
    // The top ten answer "is it one check or all of them"; comparing two ARMS needs all 94,
    // because a check outside one arm's top ten can be the one that grew most. Opt-in by
    // path so an ordinary run writes nothing.
    if (process.env.GL_PROFILE_OUT) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.GL_PROFILE_OUT, JSON.stringify({
        three: threeVersion,
        totalMs: total,
        checks: timed.map((r) => ({ name: r.name, ms: r.ms, pass: r.pass })),
      }, null, 2));
      console.log(`    profile written to ${process.env.GL_PROFILE_OUT}`);
    }
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
