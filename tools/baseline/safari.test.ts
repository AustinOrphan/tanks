// Proves safari.mjs's WebDriver client end to end -- session create, navigate, poll,
// execute/sync, session delete, and the exit-code wiring through reportResult -- against
// a MOCK WebDriver server, since this Linux dev box has no `safaridriver` to test against
// for real. What this does NOT prove, and cannot from here: that a real safaridriver
// speaks the exact same shapes back (see safari.mjs's header for what is still open until
// engines.yml's Safari leg runs on an actual macOS runner).
//
// safari.mjs spawns a REAL vite (via harness.mjs, same as run.mjs) and only the WebDriver
// half is mocked -- `--driver-url` points it at this test's mock server instead of
// spawning `safaridriver`, which does not exist on this platform.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BASELINE_HASH } from './trace';
import { ANGLE_HASH, VENDORED_ANGLE_HASH } from './angles';

const SAFARI_MJS = fileURLToPath(new URL('./safari.mjs', import.meta.url));

/** A trace/angle/vendored-angle result shaped exactly like page.html produces one. */
function fakeResult(hash: string, expected: string, extra: Record<string, unknown>) {
  return { hash, expected, match: hash === expected, ms: 1, userAgent: 'mock-safari/1.0', ...extra };
}

function startMockWebDriver() {
  let readinessPolls = 0;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');

      if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200);
        res.end(JSON.stringify({ value: { ready: true } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/session') {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            value: {
              sessionId: 'mock-session-1',
              capabilities: { browserName: 'safari', browserVersion: '17.4' },
            },
          }),
        );
        return;
      }
      if (req.method === 'POST' && /\/session\/[^/]+\/url$/.test(req.url ?? '')) {
        res.writeHead(200);
        res.end(JSON.stringify({ value: null }));
        return;
      }
      if (req.method === 'POST' && /\/session\/[^/]+\/execute\/sync$/.test(req.url ?? '')) {
        const parsed = JSON.parse(body || '{}');
        const script: string = parsed.script ?? '';
        if (script.includes('__traceResult && window.__angleResult')) {
          // Exercise the polling loop: false once, then true.
          readinessPolls++;
          res.writeHead(200);
          res.end(JSON.stringify({ value: readinessPolls >= 2 }));
          return;
        }
        if (script.includes('trace: window.__traceResult')) {
          res.writeHead(200);
          res.end(
            JSON.stringify({
              value: {
                trace: fakeResult(BASELINE_HASH, BASELINE_HASH, { textLength: 100 }),
                angle: fakeResult(ANGLE_HASH, ANGLE_HASH, { bands: [] }),
                vendored: fakeResult(VENDORED_ANGLE_HASH, VENDORED_ANGLE_HASH, { bands: [] }),
              },
            }),
          );
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ value: null }));
        return;
      }
      if (req.method === 'DELETE' && /\/session\/[^/]+$/.test(req.url ?? '')) {
        res.writeHead(200);
        res.end(JSON.stringify({ value: null }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ value: { error: 'not found', message: `no mock route for ${req.method} ${req.url}` } }));
    });
  });
  return new Promise<{ base: string; close: () => void; calls: string[] }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close(), calls });
    });
  });
}

function runSafariMjs(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn(process.execPath, [SAFARI_MJS, ...args], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c));
    proc.stderr.on('data', (c) => (stderr += c));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('safari.mjs against a mock WebDriver server', () => {
  let mock: Awaited<ReturnType<typeof startMockWebDriver>> | null = null;

  afterEach(() => {
    mock?.close();
    mock = null;
  });

  it('drives the full session lifecycle and reports MATCH on all three pinned hashes', async () => {
    mock = await startMockWebDriver();
    const { code, stdout } = await runSafariMjs([
      '--port',
      '5183',
      '--driver-url',
      mock.base,
      '--timeout',
      '10000',
    ]);

    expect(stdout).toContain('Safari version: 17.4');
    expect(stdout).toContain(`MATCH  safari  ${BASELINE_HASH}`);
    expect(stdout).toContain(`vendored angle safari  ${VENDORED_ANGLE_HASH}`);
    expect(code).toBe(0);

    // The lifecycle actually happened in this order, not just "some requests arrived".
    expect(mock.calls[0]).toBe('POST /session');
    expect(mock.calls).toContain('POST /session/mock-session-1/url');
    expect(mock.calls.at(-1)).toBe('DELETE /session/mock-session-1');
    // The readiness poll really polled (false, then true), proving the loop, not a
    // single lucky check.
    expect(mock.calls.filter((c) => c.includes('/execute/sync')).length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('a trace MISMATCH from the mock still completes the session and fails the exit code', async () => {
    mock = await startMockWebDriver();
    // Monkeypatch: reuse the same mock but have the client hit a variant. Simplest: start
    // a second server whose trace hash is deliberately wrong.
    mock.close();
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url === '/status') return void (res.writeHead(200), res.end('{}'));
        if (req.method === 'POST' && req.url === '/session') {
          res.writeHead(200);
          res.end(JSON.stringify({ value: { sessionId: 's1', capabilities: { browserVersion: '17.0' } } }));
          return;
        }
        if (req.method === 'POST' && /\/url$/.test(req.url ?? '')) return void (res.writeHead(200), res.end('{"value":null}'));
        if (req.method === 'POST' && /execute\/sync$/.test(req.url ?? '')) {
          const parsed = JSON.parse(body || '{}');
          const script: string = parsed.script ?? '';
          if (script.includes('__traceResult && window.__angleResult')) {
            res.writeHead(200);
            res.end(JSON.stringify({ value: true }));
            return;
          }
          res.writeHead(200);
          res.end(
            JSON.stringify({
              value: {
                trace: fakeResult('deadbeef', BASELINE_HASH, { textLength: 1 }),
                angle: fakeResult(ANGLE_HASH, ANGLE_HASH, { bands: [] }),
                vendored: fakeResult(VENDORED_ANGLE_HASH, VENDORED_ANGLE_HASH, { bands: [] }),
              },
            }),
          );
          return;
        }
        if (req.method === 'DELETE') return void (res.writeHead(200), res.end('{"value":null}'));
        res.writeHead(404);
        res.end('{}');
      });
    });
    const base = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

    const { code, stdout } = await runSafariMjs(['--port', '5184', '--driver-url', base, '--timeout', '10000']);
    server.close();

    expect(stdout).toContain('MISMATCH  safari  deadbeef');
    expect(stdout).toContain('check(s) FAILED');
    expect(code).toBe(1);
  }, 30_000);
});
