/**
 * Verifies the WHOLE beacon mechanism end to end, for real: spawns `run.mjs --beacon` (a
 * real vite + a real beacon collector, exactly as engines.yml's iOS Simulator leg will),
 * reads the BEACON_URL it prints, opens that URL in a REAL Playwright chromium (standing
 * in for "any browser we can merely open" -- the Simulator's Mobile Safari is
 * architecture-specific and cannot run on this Linux box, but the mechanism it will
 * exercise -- vite serving the page, the page computing all three results, POSTing them
 * cross-origin with CORS to the collector, the collector resolving and run.mjs exiting on
 * the pinned hashes -- is identical regardless of which engine opens the URL). This is the
 * strongest local proof available for beacon mode; only a real macOS run can additionally
 * prove Mobile Safari specifically behaves the same way when opened via `xcrun simctl
 * openurl`.
 *
 * Deliberately NOT a *.test.ts file: vite.config.ts's vitest `include` is
 * `tools/**\/*.test.ts`, and CI's `verify` job runs `npx vitest run` on a machine with NO
 * Playwright installed (only the separate `visual` and `engines` jobs install it -- see
 * ci.yml's own comment on why Playwright is not a devDependency). A `.test.ts` here would
 * pass locally and break the `verify` job on every push. tools/gl/ set this precedent
 * already: its browser-dependent checks run via `npm run test:gl`, a plain script, not a
 * vitest file -- this follows the same shape.
 *
 * Usage: node tools/baseline/beacon-check.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN_MJS = fileURLToPath(new URL('./run.mjs', import.meta.url));

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

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function main() {
  const proc = spawn(
    process.execPath,
    [RUN_MJS, '--beacon', '--port', '5185', '--beacon-port', '5186', '--timeout', '60000'],
    { stdio: 'pipe' },
  );
  let stdout = '';
  proc.stdout.on('data', (c) => {
    stdout += c;
    process.stdout.write(c);
  });
  let stderr = '';
  proc.stderr.on('data', (c) => {
    stderr += c;
    process.stderr.write(c);
  });

  try {
    const url = await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const m = /^BEACON_URL (\S+)$/m.exec(stdout);
        if (m) {
          clearInterval(timer);
          resolve(m[1]);
        } else if (Date.now() - started > 20_000) {
          clearInterval(timer);
          reject(new Error(`no BEACON_URL within 20s. stdout so far:\n${stdout}\nstderr:\n${stderr}`));
        }
      }, 200);
    });
    assert(
      url.includes('?beacon=http%3A%2F%2Flocalhost%3A5186%2Freport'),
      `beacon URL did not embed the collector address as expected: ${url}`,
    );

    const chromium = await loadChromium();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load' });
      // Wait for the page's own beacon script to report success, so the browser is not
      // closed while its keepalive POST might still be in flight.
      await page.waitForFunction(() => document.body.textContent?.includes('beacon: reported to'), {
        timeout: 60_000,
      });
    } finally {
      await browser.close();
    }

    const exitCode = await new Promise((resolve) => proc.on('close', resolve));
    // Not asserted against the literal pinned hash strings: this script cannot import
    // trace.ts/angles.ts (plain `node`, no TS loader, unlike safari.test.ts/harness.test.ts
    // which run under vitest and can). Checking for the MATCH/MISMATCH word reportResult
    // prints is enough to prove the mechanism -- the hash VALUE itself is already pinned
    // and checked by trace.test.ts/angles.test.ts under `npm test`, on the same checkout.
    assert(/^ {2}MATCH {2}beacon {2}[0-9a-f]+/m.test(stdout), 'stdout did not report a trace MATCH');
    assert(!/^ {2}MISMATCH {2}beacon {2}/m.test(stdout), 'stdout reported a trace MISMATCH');
    assert(
      /^ {2}MATCH {2}vendored angle beacon {2}[0-9a-f]+/m.test(stdout),
      'stdout did not report a vendored-angle MATCH',
    );
    assert(
      !/^ {2}MISMATCH {2}vendored angle beacon {2}/m.test(stdout),
      'stdout reported a vendored-angle MISMATCH',
    );
    // The NATIVE angle probe (plain "angle beacon", not "vendored angle beacon") is
    // EXPECTED to mismatch chromium against Node's pinned ANGLE_HASH -- see angles.ts's
    // header and run.mjs's reportResult: it is structural, not wired into the exit code,
    // and deliberately not asserted against here.
    assert(/report received from: .*Chrome/.test(stdout), 'stdout did not attribute the report to chromium');
    assert(!/check\(s\) FAILED/.test(stdout), 'stdout reported failed checks');
    assert(exitCode === 0, `run.mjs --beacon exited ${exitCode}, expected 0`);

    console.log('\nbeacon-check: PASS -- the whole mechanism round-tripped through a real browser.');
    process.exitCode = 0;
  } catch (e) {
    console.error(`\nbeacon-check: FAIL -- ${e.message ?? e}`);
    process.exitCode = 1;
  } finally {
    if (!proc.killed) proc.kill('SIGKILL');
  }
}

await main();
