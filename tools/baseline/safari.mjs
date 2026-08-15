/**
 * Runs tools/baseline/page.html in SHIPPED SAFARI via `safaridriver`, Apple's own
 * WebDriver implementation -- the half of the cross-engine question Playwright's
 * "webkit" cannot answer, because that build is JavaScriptCore, not Safari (see
 * run.mjs's header). Only ships on macOS; `sudo safaridriver --enable` must have been run
 * once already (a one-time, privileged step -- .github/workflows/engines.yml's Safari leg
 * does it before invoking this file; it is deliberately NOT done here).
 *
 * No new dependency: this speaks the W3C WebDriver HTTP protocol directly over `fetch`
 * (Node 22 ships it), the same four calls any WebDriver client library wraps --
 * POST /session, POST /session/:id/url, POST /session/:id/execute/sync (polled), DELETE
 * /session/:id -- rather than pulling in `selenium-webdriver` or `webdriverio` for four
 * HTTP calls. Reuses run.mjs's vite spawn/wait/verify/teardown and its reportResult exit-
 * code semantics via tools/baseline/harness.mjs, so this file adds only the WebDriver leg.
 *
 * Usage:
 *   node tools/baseline/safari.mjs                          # spawns safaridriver itself
 *   node tools/baseline/safari.mjs --driver-url http://localhost:4444  # talks to one
 *                                                             # already running (this is
 *                                                             # how safari.test.ts verifies
 *                                                             # the WebDriver client against
 *                                                             # a mock server on Linux,
 *                                                             # where safaridriver does not
 *                                                             # exist)
 *
 * UNPROVEN until engines.yml's Safari leg actually runs on a macOS runner: safaridriver's
 * exact startup timing, whether `browserName: 'safari'` alone is a sufficient capability,
 * and the shape of a real Safari session's `capabilities` object (the version field is
 * read defensively below, from three possible keys, for exactly this reason). Everything
 * else here (the HTTP framing, the polling loop, the exit-code wiring) is proven against
 * the mock server in safari.test.ts.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  refuseIfAnswering,
  reportResult,
  spawnVite,
  stopVite,
  verifyServedMarker,
  waitForVite,
} from './harness.mjs';

function parseSafariArgs(argv) {
  const out = { port: 5178, driverPort: 4444, driverUrl: null, timeout: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--driver-port') out.driverPort = Number(argv[++i]);
    else if (a === '--driver-url') out.driverUrl = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!Number.isInteger(out.port) || out.port <= 0) throw new Error('--port needs a port number');
  if (!Number.isInteger(out.driverPort) || out.driverPort <= 0) throw new Error('--driver-port needs a port number');
  if (!Number.isInteger(out.timeout) || out.timeout <= 0) throw new Error('--timeout needs a positive number of milliseconds');
  return out;
}

/** Minimal W3C WebDriver client: the four calls this file needs, nothing else. */
class WebDriverSession {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
    this.id = null;
  }

  async #req(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${method} ${path} -- non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      const msg = json?.value?.message ?? json?.value?.error ?? text;
      throw new Error(`${method} ${path} -- HTTP ${res.status}: ${msg}`);
    }
    return json;
  }

  async start(capabilities) {
    const json = await this.#req('POST', '/session', { capabilities: { alwaysMatch: capabilities } });
    // W3C wraps in `value`; a couple of real drivers have shipped bugs that omit it, so
    // fall back to the bare body defensively.
    const value = json.value ?? json;
    this.id = value.sessionId;
    this.capabilities = value.capabilities ?? {};
    if (!this.id) throw new Error(`no sessionId in new-session response: ${JSON.stringify(json)}`);
    return this.capabilities;
  }

  async navigate(url) {
    await this.#req('POST', `/session/${this.id}/url`, { url });
  }

  async executeSync(script, args = []) {
    const json = await this.#req('POST', `/session/${this.id}/execute/sync`, { script, args });
    return json.value;
  }

  async end() {
    if (!this.id) return;
    try {
      await this.#req('DELETE', `/session/${this.id}`);
    } finally {
      this.id = null;
    }
  }
}

/** Version string from whichever capability key this driver actually populated. */
function safariVersion(caps) {
  return caps.browserVersion ?? caps.version ?? caps['safari.version'] ?? '(unknown)';
}

async function main() {
  let opts;
  try {
    opts = parseSafariArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exitCode = 2;
    return;
  }

  const BASE = `http://localhost:${opts.port}/`;
  // Same exit(2) contract run.mjs gives "something is already listening" -- see its
  // matching comment. refuseIfAnswering throws rather than exiting directly (shared
  // helper, tools/baseline/harness.mjs), so this is what turns that back into a clean
  // message at the right exit code instead of an unhandled-rejection stack trace.
  try {
    await refuseIfAnswering(BASE);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(2);
  }

  const vite = spawnVite(opts.port);
  let driverProc = null;
  const driverBase = opts.driverUrl ?? `http://localhost:${opts.driverPort}`;
  const session = new WebDriverSession(driverBase);
  let failed = 0;
  try {
    await waitForVite(BASE, vite);
    await verifyServedMarker(BASE);

    if (!opts.driverUrl) {
      driverProc = spawn('safaridriver', ['--port', String(opts.driverPort)], { stdio: 'ignore' });
      // safaridriver has no readiness endpoint documented; poll the session endpoint's
      // TCP listener the same way run.mjs polls vite -- any HTTP response (even a 404)
      // proves something is listening.
      let up = false;
      for (let i = 0; i < 40; i++) {
        try {
          await fetch(`${driverBase}/status`, { signal: AbortSignal.timeout(500) });
          up = true;
          break;
        } catch {
          await sleep(250);
        }
      }
      if (!up) throw new Error(`safaridriver did not start listening on ${driverBase} within 10s`);
    }

    const caps = await session.start({ browserName: 'safari' });
    console.log(`Safari version: ${safariVersion(caps)}`);
    console.log(`capabilities: ${JSON.stringify(caps)}`);

    await session.navigate(`${BASE}tools/baseline/page.html`);

    const readyCheck =
      'return !!(window.__traceResult && window.__angleResult && window.__vendoredAngleResult);';
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < opts.timeout) {
      ready = await session.executeSync(readyCheck);
      if (ready) break;
      await sleep(500);
    }
    if (!ready) throw new Error(`page did not finish all three measurements within ${opts.timeout}ms`);

    const result = await session.executeSync(
      'return { trace: window.__traceResult, angle: window.__angleResult, vendored: window.__vendoredAngleResult };',
    );

    failed = reportResult('safari', result.trace, result.angle, result.vendored);
    console.log('');
    console.log(failed === 0 ? '' : `${failed} check(s) FAILED`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error(`FAIL: ${e.message ?? e}`);
    process.exitCode = 1;
  } finally {
    await session.end().catch(() => {});
    if (driverProc) driverProc.kill('SIGTERM');
    await stopVite(vite, BASE);
  }
}

await main();
