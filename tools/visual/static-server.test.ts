import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { serveStatic, staticHandler } from './static-server.mjs';

/**
 * Issue #692: `verify.mjs` (run by the required `visual` job) and both `tools/uikit` scripts
 * served `dist` through the block `serve-path.mjs` was extracted to replace. Those scripts
 * call `main()` at the top level, so their handlers could not be tested where they stood;
 * they now serve through this one, and these cases are the malformed-URL and traversal
 * cases the issue asks each of them to gain.
 *
 * The handler is driven directly with a raw request URL, for the reason `serve-path.test.ts`
 * gives: a normalising client collapses `..` before sending, so a `fetch` would never reach
 * the escape. The listening case checks only that `serveStatic` wires this handler.
 *
 * The "original block" named in each negative control is, verbatim:
 *   const url = decodeURIComponent(req.url.split('?')[0]);
 *   const path = join(root, url === '/' ? 'index.html' : url);
 *   if (!path.startsWith(root) || !existsSync(path)) return 404;
 */

const scratch = mkdtempSync(join(tmpdir(), 'static-server-'));
const dist = join(scratch, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<h1>built</h1>');
writeFileSync(join(scratch, 'outside.txt'), 'OUTSIDE');
mkdirSync(join(scratch, 'dist-evil'));
writeFileSync(join(scratch, 'dist-evil', 'secret.txt'), 'SECRET');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TYPES = { '.html': 'text/html' };

/** What the handler wrote for one raw request URL. */
async function respond(url: string) {
  const sent = { status: 0, type: undefined as string | undefined, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      sent.status = status;
      sent.type = headers?.['Content-Type'];
      return res;
    },
    end(body?: unknown) {
      sent.body = body === undefined ? '' : String(body);
      return res;
    },
  };
  await staticHandler(dist, TYPES)({ url }, res);
  return sent;
}

describe('static-server.mjs: staticHandler', () => {
  it('serves the root as index.html with its content type', async () => {
    // Negative control: refusing every request fails this, so the refusals below cannot
    // pass by serving nothing.
    expect(await respond('/')).toEqual({ status: 200, type: 'text/html', body: '<h1>built</h1>' });
  });

  it('answers 404 for a file that is not there', async () => {
    expect((await respond('/missing.js')).status).toBe(404);
  });

  it('answers 404 instead of rejecting on malformed percent-encoding', async () => {
    // Negative control: the original block's decodeURIComponent throws URIError, and the
    // handler's promise rejects -- in a real server, an unhandled rejection that ends the tool.
    expect(await respond('/%')).toEqual({ status: 404, type: undefined, body: 'not found' });
  });

  it('refuses a sibling directory whose name begins with dist', async () => {
    // Negative control: the original block's `startsWith(root)` accepts
    // <scratch>/dist-evil/secret.txt and answers 200 with SECRET.
    expect(await respond('/../dist-evil/secret.txt')).toEqual({ status: 404, type: undefined, body: 'not found' });
  });

  it('refuses a literal .. escape out of dist', async () => {
    expect(await respond('/../outside.txt')).toEqual({ status: 404, type: undefined, body: 'not found' });
  });
});

describe('static-server.mjs: serveStatic', () => {
  it('listens on loopback and answers through the handler', async () => {
    // Negative control: passing `{}` for the types answers application/octet-stream.
    const server = await serveStatic(dist, TYPES);
    try {
      const { port } = server.address() as AddressInfo;
      const answer = await new Promise<{ status?: number; type?: string; body: string }>((ok, fail) => {
        get(`http://127.0.0.1:${port}/index.html`, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], body }));
        }).on('error', fail);
      });
      expect(answer).toEqual({ status: 200, type: 'text/html', body: '<h1>built</h1>' });
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
