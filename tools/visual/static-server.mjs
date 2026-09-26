/**
 * The static server the browser tools put in front of a built `dist` (issue #692).
 *
 * `serve-path.mjs`'s `resolveRequestPath` was extracted after two measured defects in this
 * handler's original block: a malformed percent-encoding threw out of an async handler
 * nothing awaits, and a `startsWith(root)` check let a sibling directory named like the root
 * (`dist-evil`) be served. `roundtrip.mjs` and `screens/run.mjs` had adopted the resolver;
 * `verify.mjs` and both `tools/uikit` scripts still carried the original block. The handler
 * lives here so every one of them serves through the same guard, and all of them now do.
 *
 * SEPARATE MODULE for the reason `serve-path.mjs` gives: each of those scripts calls `main()`
 * at the top level, so a test that imported one would run it. Nothing here listens until
 * `serveStatic` is called.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';

import { resolveRequestPath } from './serve-path.mjs';

/**
 * A request handler serving files inside `dist`.
 *
 * A refused path (malformed, or outside `dist`) and a missing file are both 404; a file that
 * exists but cannot be read is 500. The returned promise settles once the response has ended.
 *
 * @param {string} dist
 * @param {Record<string, string>} types content type by extension, per tool
 */
export function staticHandler(dist, types) {
  return async (req, res) => {
    const file = resolveRequestPath(dist, req.url);
    if (file === null || !existsSync(file)) return void res.writeHead(404).end('not found');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(500).end('error');
    }
  };
}

/**
 * Serve `dist` on an ephemeral loopback port.
 *
 * @param {string} dist
 * @param {Record<string, string>} types
 * @returns {Promise<import('node:http').Server>} listening; read the port from `address()`
 */
export function serveStatic(dist, types) {
  const server = createServer(staticHandler(dist, types));
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}
