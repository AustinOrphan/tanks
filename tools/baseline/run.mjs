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
 *   - Playwright's webkit is a JavaScriptCore build, NOT shipped Safari. tools/baseline/
 *     safari.mjs (raw WebDriver against a real `safaridriver`) and this file's `--beacon`
 *     mode (driven by the iOS Simulator leg in .github/workflows/engines.yml) are what
 *     close that gap, on a macOS CI runner -- neither runs from this Linux dev box.
 *   - It says nothing about other CPU architectures beyond what the engines matrix
 *     (.github/workflows/engines.yml) covers.
 *
 * Structure follows tools/gl/run.mjs, including its two hard-won refusals: never test a
 * server we did not start, and spawn vite directly rather than through npx.
 */
import { networkInterfaces } from 'node:os';
import { parseArgs } from './args.mjs';
import {
  refuseIfAnswering,
  reportResult,
  spawnVite,
  startBeaconCollector,
  stopVite,
  verifyServedMarker,
  waitForBeaconReport,
  waitForVite,
} from './harness.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}

const BASE = `http://localhost:${opts.port}/`;

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

function findLanIPv4() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

/**
 * Beacon mode: the driverless path for any browser we can merely OPEN (the iOS Simulator
 * via `xcrun simctl openurl`, a physical device typing a URL, a kiosk browser) rather than
 * drive. This process serves the page (vite, as always) and a tiny second HTTP server (the
 * "beacon collector", tools/baseline/harness.mjs's startBeaconCollector) on ITS OWN port;
 * the URL printed below embeds the collector's address as a `?beacon=` query param, and
 * page.html POSTs its three results there once they are all computed. No new dependency:
 * both servers are vite (already a dependency) and node:http.
 *
 * localhost is the SUPPORTED path -- the iOS Simulator shares the host's own loopback
 * interface, so a simulator opening this exact URL reaches this exact vite/collector pair
 * with no extra plumbing (verified by the real Engines Matrix iOS leg). `--host` additionally
 * binds vite (and, since node:http's default listen has no host argument, the collector)
 * to every interface for a phone on the same LAN -- but crypto.subtle, which every
 * measurement here needs, is a secure-context API and plain http://<lan-ip> is NOT secure.
 * This does not solve that: it prints a clear warning and leaves LAN access best-effort,
 * needing a tunnel/https proxy in front of the printed address to actually work. localhost
 * (and therefore the Simulator) is unaffected -- http://localhost is always a secure
 * context regardless of scheme.
 */
async function runBeaconMode(opts) {
  // Preserves the original run.mjs's exit(2) contract for "something is already
  // listening" -- refuseIfAnswering throws (it is shared with safari.mjs, which has its
  // own reason to want a rejection rather than a direct process.exit), so this is the one
  // place that turns it back into the clean two-line message + exit 2 this tool always
  // gave for a taken port, instead of an unhandled-rejection stack trace at a different
  // exit code.
  try {
    await refuseIfAnswering(BASE);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(2);
  }
  const displayHost = opts.host ? findLanIPv4() ?? 'localhost' : 'localhost';
  const collectorBase = `http://${displayHost}:${opts.beaconPort}`;
  const pageBase = `http://${displayHost}:${opts.port}`;
  const beaconUrl = `${pageBase}/tools/baseline/page.html?beacon=${encodeURIComponent(`${collectorBase}/report`)}`;

  const vite = spawnVite(opts.port, { host: opts.host });
  const { server: collector, reportPromise } = await startBeaconCollector(opts.beaconPort);
  try {
    // The iOS runner starts this immediately after booting a Simulator. Measured macOS
    // runner contention has pushed Vite beyond the generic 30s allowance, while the
    // Playwright and safaridriver paths do not need that extra budget. Keep the relaxation
    // scoped to beacon mode rather than changing waitForVite's shared default.
    await waitForVite(BASE, vite, { timeoutMs: 90_000 });
    await verifyServedMarker(BASE);

    console.log(`BEACON_URL ${beaconUrl}`);
    console.log('Open that URL in the browser/engine you want to measure.');
    console.log(`Waiting up to ${opts.timeout}ms for its report to arrive at ${collectorBase}/report ...`);
    if (opts.host) {
      console.log('');
      console.log(`--host was passed: vite and the beacon collector are bound to every interface.`);
      console.log(
        displayHost === 'localhost'
          ? 'No non-internal IPv4 address was found on this machine -- LAN access is unavailable; use localhost/the Simulator instead.'
          : `LAN address in use: ${displayHost}`,
      );
      console.log(
        'WARNING: crypto.subtle requires a secure context. Plain http://<lan-ip> is NOT one, and',
      );
      console.log(
        'the page will report a hard error on that path (see page.html\'s own secure-context check).',
      );
      console.log(
        'localhost (the iOS Simulator shares the host loopback) is the supported path; LAN needs a',
      );
      console.log('tunnel or an https proxy in front of the address above to actually work.');
    }

    const report = await waitForBeaconReport(reportPromise, opts.timeout);
    console.log('');
    console.log(`report received from: ${report.userAgent ?? '(no userAgent in report)'}`);
    const failed = reportResult(
      'beacon',
      report.traceResult ?? { error: 'report is missing traceResult' },
      report.angleResult ?? { error: 'report is missing angleResult' },
      report.vendoredAngleResult ?? { error: 'report is missing vendoredAngleResult' },
    );
    console.log('');
    console.log(failed === 0 ? '' : `${failed} check(s) FAILED`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    collector.close();
    await stopVite(vite, BASE);
  }
}

async function runPlaywrightMode(opts) {
  // Same exit(2) contract as runBeaconMode above -- see its comment.
  try {
    await refuseIfAnswering(BASE);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(2);
  }

  const vite = spawnVite(opts.port);
  let failed = 0;
  const results = [];
  const angleResults = [];
  const vendoredAngleResults = [];
  try {
    await waitForVite(BASE, vite);
    await verifyServedMarker(BASE);

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
        // for ALL THREE results: the page sets each independently once it is fully built
        // (see page.html), so waiting on the trio never reads a half-filled object of any.
        await page.waitForFunction(
          () => !!window.__traceResult && !!window.__angleResult && !!window.__vendoredAngleResult,
          undefined,
          { timeout: 180_000 },
        );
        const r = await page.evaluate(() => window.__traceResult);
        const ar = await page.evaluate(() => window.__angleResult);
        const vr = await page.evaluate(() => window.__vendoredAngleResult);
        for (const e of pageErrors) console.log(`  page error [${name}] -- ${e}`);

        results.push({ name, ...r, pageErrors: pageErrors.length });
        angleResults.push({ name, ...ar });
        vendoredAngleResults.push({ name, ...vr });
        failed += reportResult(name, r, ar, vr);
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
        `This run: ${process.platform}/${process.arch}. Still NOT covered here: shipped Safari ` +
          'and iOS -- see tools/baseline/safari.mjs and this file\'s --beacon mode.',
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

    // ---- vendored angle probe agreement (issue #133): the pin this file's build ----
    // guarantee is actually FOR. A mismatch here is already counted into `failed` above;
    // this block only narrates it, plus the same per-band bisection the native block does.
    const vendoredHashes = new Set(vendoredAngleResults.filter((r) => r.hash).map((r) => r.hash));
    console.log('');
    if (vendoredHashes.size > 1) {
      console.log(
        `VENDORED ANGLE PROBE: ENGINES DISAGREE: ${vendoredHashes.size} distinct hashes ` +
          `across ${vendoredAngleResults.length} run(s).`,
      );
      console.log('That is a REGRESSION for issue #133: the vendored math is built only from');
      console.log('exactly-specified ECMA-262 operations, so every conformant engine should');
      console.log('compute the identical bit pattern -- this construction guarantee does not');
      console.log('hold on this run.');
      const withBands = vendoredAngleResults.filter((r) => Array.isArray(r.bands));
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
    } else if (vendoredAngleResults.length > 0 && vendoredAngleResults.every((r) => !r.error && r.match)) {
      console.log(
        `vendored angle probe: all ${vendoredAngleResults.length} engine(s) agree with the ` +
          `pinned baseline: ${[...vendoredHashes][0]}`,
      );
    } else if (vendoredAngleResults.length > 0 && vendoredAngleResults.every((r) => !r.error)) {
      console.log(
        'vendored angle probe: does not match the pinned baseline (VENDORED_ANGLE_HASH) on ' +
          'at least one engine -- see the MISMATCH line(s) above. Counted into failed.',
      );
    }

    console.log('');
    console.log(failed === 0 ? '' : `${failed} check(s) FAILED`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await stopVite(vite, BASE);
  }
}

if (opts.beacon) {
  await runBeaconMode(opts);
} else {
  await runPlaywrightMode(opts);
}
