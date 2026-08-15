/**
 * Shared, side-effect-free helpers for tools/baseline/run.mjs and tools/baseline/safari.mjs
 * -- the vite spawn/wait/verify/teardown dance and the per-result MATCH/MISMATCH/exit-code
 * logic, factored out so a WebDriver-speaking runner (safari.mjs) and a driverless
 * beacon collector (run.mjs's --beacon mode) can reuse exactly what the Playwright runner
 * already does, rather than three copies of "did the trace match" drifting apart.
 *
 * Deliberately side-effect-free at import time (no top-level spawn/listen/fetch), the same
 * rule args.mjs documents for itself: importing this from a test must not start a server.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** Something only tools/baseline/page.html serves, used to prove we are testing our own checkout. */
export const MARKER = '__traceResult';

export async function respondsOn(url, ms = 1000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return false;
  }
}

/** Throws if something already answers on `base` -- never trace a server we did not start. */
export async function refuseIfAnswering(base) {
  if (await respondsOn(base)) {
    throw new Error(
      `Something is already listening on ${base}.\n` +
        'Refusing to run: it would be traced instead of this checkout.\n' +
        "Stop it (pkill -f 'vite --port') or pass a different port.",
    );
  }
}

// See run.mjs's original comment (preserved here, the only place this logic now lives):
// `.pathname` on a file:// URL is wrong on Windows, and Windows has no bare `vite`
// executable in node_modules/.bin -- npm puts a `vite.cmd` shim there -- and spawning a
// .cmd/.bat file without `shell: true` throws EINVAL on current Node (the CVE-2024-27980
// fix). Neither branch has been exercised on a real Windows runner.
export function resolveViteBin() {
  const VITE_PATH = fileURLToPath(new URL('../../node_modules/.bin/vite', import.meta.url));
  return process.platform === 'win32' ? `${VITE_PATH}.cmd` : VITE_PATH;
}

/**
 * Spawns vite on `port`. `host` is undefined (localhost only, vite's default), `true`
 * (bind every interface, vite's bare `--host`) or a string address to bind explicitly.
 */
export function spawnVite(port, { host } = {}) {
  const args = ['--port', String(port), '--strictPort'];
  if (host === true) args.push('--host');
  else if (typeof host === 'string') args.push('--host', host);
  const proc = spawn(resolveViteBin(), args, {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  const handle = { proc, exited: false };
  proc.on('exit', () => {
    handle.exited = true;
  });
  return handle;
}

export async function waitForVite(base, handle, { timeoutMs = 30_000, pollMs = 500 } = {}) {
  const started = Date.now();
  for (;;) {
    if (handle.exited) throw new Error('vite exited before serving; is the port taken?');
    if (await respondsOn(base)) return;
    if (Date.now() - started > timeoutMs) throw new Error(`vite did not start on ${base} within ${timeoutMs}ms`);
    await sleep(pollMs);
  }
}

export async function verifyServedMarker(base, path = 'tools/baseline/page.html', marker = MARKER) {
  const served = await (await fetch(`${base}${path}`)).text();
  if (!served.includes(marker)) {
    throw new Error(`the server on ${base} is not serving this checkout's page`);
  }
}

/** Same graceful-then-hard kill dance run.mjs always did, now shared with safari.mjs. */
export async function stopVite(handle, base) {
  const killVite = (hard) => {
    if (process.platform === 'win32') {
      if (handle.proc.pid) {
        spawn('taskkill', ['/pid', String(handle.proc.pid), '/t', hard ? '/f' : ''].filter(Boolean), {
          stdio: 'ignore',
        });
      }
    } else {
      handle.proc.kill(hard ? 'SIGKILL' : 'SIGTERM');
    }
  };
  killVite(false);
  let freed = false;
  for (let i = 0; i < 20; i++) {
    if (!(await respondsOn(base, 300))) {
      freed = true;
      break;
    }
    await sleep(250);
  }
  if (!freed) {
    killVite(true);
    for (let i = 0; i < 20; i++) {
      if (!(await respondsOn(base, 300))) {
        freed = true;
        break;
      }
      await sleep(250);
    }
  }
  if (!freed) console.error(`warning: ${base} still answering after SIGKILL`);
}

/**
 * Prints one result set (trace + native angle + vendored angle, the same trio
 * page.html/run.mjs always computed together) in exactly the format run.mjs printed
 * inline before this file existed, and returns how many of the three FAILED the exit
 * code.
 *
 * Exit-code semantics, unchanged from run.mjs and now shared by every consumer
 * (Playwright per-engine, safari.mjs, the beacon collector):
 *   - golden trace: a MISMATCH against BASELINE_HASH counts as failed (regression).
 *   - native angle probe: NEVER counts, even on MISMATCH -- structural, not a regression
 *     (see angles.ts's header and run.mjs's original comment on this point).
 *   - vendored angle probe: a MISMATCH against VENDORED_ANGLE_HASH counts as failed --
 *     the whole construction guarantee issue #133 exists to hold.
 *   - a hard error in any of the three (r.error/ar.error/vr.error) always counts.
 */
export function reportResult(name, r, ar, vr) {
  let failed = 0;

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

  if (ar.error) {
    failed++;
    console.log(`  FAIL  angle ${name}: ${ar.error}`);
  } else {
    console.log(
      `  ${ar.match ? 'MATCH' : 'MISMATCH'}  angle ${name}  ${ar.hash}  (${ar.ms} ms, ${ar.bands.length} bands)`,
    );
  }

  if (vr.error) {
    failed++;
    console.log(`  FAIL  vendored angle ${name}: ${vr.error}`);
  } else {
    console.log(
      `  ${vr.match ? 'MATCH' : 'MISMATCH'}  vendored angle ${name}  ${vr.hash}  (${vr.ms} ms, ${vr.bands.length} bands)`,
    );
    if (!vr.match) failed++;
  }

  return failed;
}

/**
 * The beacon collector (mechanism 1 of the Safari/iOS CI work): a tiny native HTTP
 * server on its OWN port, separate from vite. Vite serves static files and ES modules
 * only -- it has no request handler for an arbitrary POST without writing a vite plugin,
 * and a plugin would make the beacon behaviour depend on vite.config.ts for every OTHER
 * consumer of page.html (the Playwright path above, a developer opening it by hand). A
 * second plain node:http server, given its own port and told apart by CORS, is the
 * simplest thing that can receive a cross-origin POST from a page vite served.
 *
 * Listens on every interface (Node's `server.listen(port)` default, no host argument) so
 * a LAN device can reach it too, matching whatever host page.html's `beacon=` URL used.
 *
 * Resolves `reportPromise` with the parsed JSON body of the first well-formed POST to
 * `/report`; a malformed body gets a 400 and does NOT resolve/reject, so one bad request
 * (a stray scanner, a retry) does not end the wait -- the caller applies its own overall
 * timeout.
 */
export function startBeaconCollector(port, path = '/report') {
  let resolveReport;
  const reportPromise = new Promise((res) => {
    resolveReport = res;
  });
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = req.url.split('?')[0];
    if (req.method !== 'POST' || url !== path) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        resolveReport(parsed);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`bad json: ${e.message}`);
      }
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, () => ok({ server, reportPromise }));
  });
}
