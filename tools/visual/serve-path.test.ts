import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveRequestPath } from './serve-path.mjs';

/**
 * `roundtrip.mjs` serves `dist` over loopback for the duration of one probe run. Its request
 * handler built a file path straight out of `req.url`, and both halves of that were reachable
 * rather than theoretical -- each was reproduced against the original handler before this
 * guard existed:
 *
 * - `GET /%` threw `URIError` from `decodeURIComponent`, which sat outside the handler's
 *   `try`. Nothing awaits an async request handler, so the rejection was unhandled and the
 *   process died with exit 1 -- a probe that reports a stack instead of a canvas census.
 * - A raw socket sending `GET /../outside.txt` was answered `200` with the file's contents
 *   from outside `dist`.
 *
 * The traversal is NOT reachable through a normalising client: `fetch('/../x')` and
 * `fetch('/%2e%2e/x')` both arrive as `/x`, because WHATWG URL resolution collapses `..` and
 * its percent-encoded spelling before the request is sent. That is why the raw-socket case is
 * asserted here at the function rather than through a served request -- a test driven by
 * `fetch` would pass against the unhardened handler and prove nothing.
 */

const ROOT = resolve('/srv/probe/dist');

describe('roundtrip.mjs: resolveRequestPath', () => {
  it('maps the root to index.html', () => {
    expect(resolveRequestPath(ROOT, '/')).toBe(`${ROOT}${sep}index.html`);
  });

  it('resolves an ordinary asset inside dist', () => {
    // Negative control: returning null unconditionally would fail here, so the guard
    // cannot pass by rejecting everything.
    expect(resolveRequestPath(ROOT, '/assets/app.js')).toBe(`${ROOT}${sep}assets${sep}app.js`);
  });

  it('drops the query string before resolving', () => {
    expect(resolveRequestPath(ROOT, '/index.html?v=2')).toBe(`${ROOT}${sep}index.html`);
  });

  it('returns null instead of throwing on malformed percent-encoding', () => {
    // Negative control: delete the try/catch around decodeURIComponent and this throws
    // URIError rather than returning null -- which is exactly how the probe died.
    expect(() => resolveRequestPath(ROOT, '/%')).not.toThrow();
    expect(resolveRequestPath(ROOT, '/%')).toBeNull();
  });

  it('rejects a literal .. escape, the form a raw socket can send', () => {
    // Negative control: restore `join(dist, ...)` with no containment check and this
    // returns /srv/probe/outside.txt, which the handler then reads and serves.
    expect(resolveRequestPath(ROOT, '/../outside.txt')).toBeNull();
  });

  it('rejects a percent-encoded .. escape', () => {
    expect(resolveRequestPath(ROOT, '/%2e%2e/outside.txt')).toBeNull();
  });

  it('rejects an escape buried mid-path', () => {
    expect(resolveRequestPath(ROOT, '/assets/../../outside.txt')).toBeNull();
  });

  it('rejects a sibling directory that merely shares the root prefix', () => {
    // Negative control for the containment check SHAPE, not just its presence: with
    // `file.startsWith(root)` instead of `root + sep`, /srv/probe/dist-evil/secret is
    // accepted. Every other case here passes under the bare form, so this is the only
    // assertion that distinguishes them.
    expect(resolveRequestPath(ROOT, '/../dist-evil/secret')).toBeNull();
  });

  it('does not treat a leading-slash run as an absolute path outside dist', () => {
    // `resolve(root, '/etc/passwd')` would ignore root entirely; the leading-separator
    // strip is what keeps the join relative.
    expect(resolveRequestPath(ROOT, '//etc/passwd')).toBe(`${ROOT}${sep}etc${sep}passwd`);
  });
});
