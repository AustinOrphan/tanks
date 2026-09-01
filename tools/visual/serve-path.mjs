/**
 * Request-path resolution for the round-trip probe's static server (issue #429).
 *
 * SEPARATE MODULE ON PURPOSE. `roundtrip.mjs` calls `main()` at the top level, so importing
 * it *runs the whole probe* -- measured: a bare `await import()` launched Chromium and drove
 * three start/quit cycles. A test that imported the resolver from there would launch a
 * browser as a side effect of unit tests, and on a machine without Playwright `loadChromium`
 * rejects into `main().catch`, which calls `process.exit(1)` and would take the vitest worker
 * with it. Nothing here imports Playwright or touches a socket.
 */
import { resolve, sep } from 'node:path';

/**
 * The request URL as a file inside `dist`, or `null` if it does not name one.
 *
 * Both rejections are real paths, each reproduced against the handler before this guard:
 *
 * - `decodeURIComponent` throws `URIError` on malformed percent-encoding (`GET /%`). It ran
 *   OUTSIDE the handler's try, so the rejection escaped an async handler that nothing awaits,
 *   and the probe died with exit 1 and a bare stack instead of printing a census.
 * - `join(dist, '../outside')` escapes `dist`. A raw socket sending `GET /../outside.txt` was
 *   answered 200 with a file from outside the root. Normalising clients cannot reach it --
 *   WHATWG URL resolution collapses `..` and `%2e%2e` before the request is sent -- which is
 *   why the guard is asserted here rather than through a served `fetch`.
 *
 * Containment is `resolve` plus a `root + sep` prefix, not `startsWith(root)`: a sibling
 * directory whose name merely begins with the root's (`dist-evil`) passes the bare form.
 *
 * @param {string} dist Directory the server is rooted at.
 * @param {string | undefined} url Raw `req.url`.
 * @returns {string | null} Absolute path inside `dist`, or null to refuse the request.
 */
export function resolveRequestPath(dist, url) {
  let path;
  try {
    path = decodeURIComponent((url ?? '/').split('?')[0]);
  } catch {
    return null;
  }
  const root = resolve(dist);
  const file = resolve(root, path === '/' ? 'index.html' : path.replace(/^[/\\]+/, ''));
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}
