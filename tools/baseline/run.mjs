/**
 * Runs the golden trace (tools/baseline/trace.ts) AND the large-magnitude angle probe
 * (tools/baseline/angles.ts) in a REAL browser and prints both fingerprints, per engine.
 * One page load runs both measurements (tools/baseline/page.html) so the cost of starting
 * vite and launching each browser is paid once, not twice.
 *
 * Why the golden trace exists: the sim's cross-engine bit-equality is the single gating
 * measurement for any peer-deterministic multiplayer -- lockstep and rollback both die if
 * two engines disagree by one ULP on Math.hypot or Math.cos, and the sim has 21
 * transcendental calls on 18 lines (docs/research/multiplayer.md). This tool does not
 * ANSWER that question. It makes the answer a one-command check:
 *
 *   npm run trace:browser -- --browser chromium,firefox,webkit
 *
 * Why the angle probe rides along: the golden trace runs 2500 ticks per (arena, seed) and,
 * measured on this checkout, never drives an accumulated bodyAngle/turretAngle past ~5.8
 * rad -- inside its own first reachability band. tools/baseline/angles.ts sweeps sin/cos
 * out to +/-1e8, plus atan2/hypot/sqrt combinatorics, so a clean trace agreement is not
 * mistaken for evidence about the large-magnitude regime issue #133's gate actually needs.
 * See that module's header for the full argument and for what ANGLE_HASH does and does not
 * cover.
 *
 * What a green run proves is bounded, and the bound matters, for BOTH measurements:
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
import { fileURLToPath } from 'node:url';
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

// `.pathname` on a file:// URL is wrong on Windows: it keeps the URL's leading slash
// ("/C:/repo/...", not a path Windows accepts) and leaves %-escapes undecoded.
// fileURLToPath is this repo's established idiom for the same conversion (see
// tools/mutate/run.mjs, tools/icons/render.mjs) and handles both. Windows also has no
// bare `vite` executable in node_modules/.bin -- npm puts a `vite.cmd` shim there --
// and spawning a .cmd/.bat file without `shell: true` throws EINVAL on current Node
// (the CVE-2024-27980 fix). Neither branch has been exercised on a real Windows
// runner; this is a read-the-code fix, not a verified one.
const VITE_PATH = fileURLToPath(new URL('../../node_modules/.bin/vite', import.meta.url));
const VITE_BIN = process.platform === 'win32' ? `${VITE_PATH}.cmd` : VITE_PATH;
const vite = spawn(VITE_BIN, ['--port', String(opts.port), '--strictPort'], {
  stdio: 'ignore',
  shell: process.platform === 'win32',
});
let viteExited = false;
vite.on('exit', () => {
  viteExited = true;
});

let failed = 0;
const results = [];
const angleResults = [];
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
      // are slower still. A timeout here is a real failure, not flake -- report it. Waits
      // for BOTH results: the page sets each independently once it is fully built (see
      // page.html), so waiting on the pair never reads a half-filled object of either.
      await page.waitForFunction(() => !!window.__traceResult && !!window.__angleResult, {
        timeout: 180_000,
      });
      const r = await page.evaluate(() => window.__traceResult);
      const ar = await page.evaluate(() => window.__angleResult);
      for (const e of pageErrors) console.log(`  page error [${name}] -- ${e}`);

      // ---- golden trace: identical reporting to before the angle probe rode along ----
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

      // ---- angle probe: same shape, its own line, prefixed so the two never blur --------
      // NOT wired into `failed`/the exit code on a MISMATCH, unlike the trace above. The
      // trace's BASELINE_HASH is a validated invariant (proven to hold across three real
      // engines when it was pinned), so any deviation is a regression worth a red exit.
      // ANGLE_HASH is not that: it is simply whatever Node's V8 computed, and measured on
      // this checkout, chromium/firefox/webkit never agree with it or with each other on
      // this sweep (see angles.ts's header and the commit that introduced this file). CI's
      // "Baseline trace (chromium)" step runs this file with no arguments -- one engine --
      // and gates the Pages deploy; wiring an unfixable, structural mismatch into `failed`
      // would turn that gate permanently red for a finding, not a defect. A hard error
      // (the sweep throwing, e.g. crypto.subtle missing) is still a real tool failure and
      // still counts.
      angleResults.push({ name, ...ar });
      if (ar.error) {
        failed++;
        console.log(`  FAIL  angle ${name}: ${ar.error}`);
      } else {
        console.log(
          `  ${ar.match ? 'MATCH' : 'MISMATCH'}  angle ${name}  ${ar.hash}  (${ar.ms} ms, ${ar.bands.length} bands)`,
        );
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
    // Host-qualified: on an arm64 macOS runner (the engines.yml matrix) the old
    // unconditional "any non-x86-64 CPU" line would be literally false.
    console.log(
      `This run: ${process.platform}/${process.arch}. Still NOT covered anywhere: ` +
        'shipped Safari and iOS; other platforms/CPUs only as the engines matrix runs them.',
    );
  }

  // ---- angle probe agreement, reported the same way, plus per-band bisection ----
  const angleHashes = new Set(angleResults.filter((r) => r.hash).map((r) => r.hash));
  console.log('');
  if (angleHashes.size > 1) {
    console.log(
      `ANGLE PROBE: ENGINES DISAGREE: ${angleHashes.size} distinct hashes across ` +
        `${angleResults.length} run(s).`,
    );
    console.log('That is a direct, large-magnitude-regime observation for issue #133:');
    console.log('these engines do not agree on sin/cos/atan2/hypot everywhere the sim can');
    console.log('reach, even though they agree on the golden trace.');
    // Bisect: compare every band's own sub-hash across engines, so the report names WHICH
    // function/reachability-band diverges instead of only the rolled-up hash.
    const withBands = angleResults.filter((r) => Array.isArray(r.bands));
    if (withBands.length > 1) {
      const bandNames = withBands[0].bands.map((b) => b.name);
      for (const bandName of bandNames) {
        const perEngine = withBands.map((r) => {
          const b = r.bands.find((x) => x.name === bandName);
          return { name: r.name, hash: b?.hash };
        });
        const distinct = new Set(perEngine.map((e) => e.hash));
        if (distinct.size > 1) {
          const detail = perEngine.map((e) => `${e.name}=${(e.hash ?? '?').slice(0, 12)}`).join('  ');
          console.log(`  DIVERGES  ${bandName}  ${detail}`);
        }
      }
    }
  } else if (angleResults.length > 0 && angleResults.every((r) => !r.error && r.match)) {
    // Only reachable when every engine run this session BOTH agrees with each other
    // (angleHashes.size <= 1, the branch above) AND matches the Node-pinned ANGLE_HASH --
    // `r.match` is checked explicitly here because a single mismatching engine also has
    // angleHashes.size 1 (one hash trivially "agrees" with itself), which would otherwise
    // print this same line while being wrong.
    console.log(
      `angle probe: all ${angleResults.length} engine(s) agree with the pinned baseline: ` +
        `${[...angleHashes][0]}`,
    );
  } else if (angleResults.length > 0 && angleResults.every((r) => !r.error)) {
    console.log(
      `angle probe: does not match the pinned V8 baseline (ANGLE_HASH) on at least one ` +
        'engine -- see the MISMATCH line(s) above.',
    );
  }

  console.log('');
  console.log(failed === 0 ? '' : `${failed} check(s) FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  // On win32 `vite` was spawned with shell: true (see VITE_BIN above), so `vite.pid` is
  // cmd.exe running the .cmd shim, which in turn runs a `node` grandchild that holds the
  // port -- Windows has no process-group SIGTERM the way POSIX does, so killing only the
  // top process would leave that grandchild running. `taskkill /t` kills the whole tree;
  // it ships with every Windows install, so this needs no new dependency. Unverified on a
  // real Windows runner.
  const killVite = (hard) => {
    if (process.platform === 'win32') {
      if (vite.pid) spawn('taskkill', ['/pid', String(vite.pid), '/t', hard ? '/f' : ''].filter(Boolean), { stdio: 'ignore' });
    } else {
      vite.kill(hard ? 'SIGKILL' : 'SIGTERM');
    }
  };
  killVite(false);
  let freed = false;
  for (let i = 0; i < 20; i++) {
    if (!(await respondsOn(BASE, 300))) { freed = true; break; }
    await sleep(250);
  }
  if (!freed) {
    killVite(true);
    for (let i = 0; i < 20; i++) {
      if (!(await respondsOn(BASE, 300))) { freed = true; break; }
      await sleep(250);
    }
  }
  if (!freed) console.error(`warning: ${BASE} still answering after SIGKILL`);
}
