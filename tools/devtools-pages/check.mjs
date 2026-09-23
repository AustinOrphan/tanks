/**
 * Developer Tools on a Pages-shaped build (issue #947).
 *
 * WHAT WAS ALREADY COVERED, so this does not re-test it. `npm run portability` reads the
 * BUILT TEXT and proves no asset URL is origin-absolute. `developerExitSearch` is a pure
 * function with its own `describe` block in `src/game/dev-config.test.ts`, so the rule
 * "strip every developer parameter, keep everything else" is pinned.
 *
 * WHAT NOTHING COVERED is the join between them: that the app BOOTS from a subdirectory,
 * that `?dev=1` reaches the Developer Tools button there, that the menu opens and a pane
 * inside it opens, and that Exit actually lands on the stripped URL and boots again. Every
 * one of those is wiring -- `exitDeveloperMode` in `src/game/loop.ts` composes the tested
 * function with `location.assign`, and a test that fakes the HUD cannot see it. That is the
 * shape this repository has been bitten by before: the pure half tested, the seam that uses
 * it not.
 *
 * WHY A SUBDIRECTORY AND NOT THE ROOT. GitHub Pages serves this game below `/tanks/`. Every
 * other browser tool here serves `dist` at `/`, where an origin-absolute asset URL resolves
 * perfectly and the one deployment shape that matters is the one never exercised. This
 * mounts the same `dist` under a prefix, so a regression in `base` fails as a blank page
 * rather than passing quietly.
 */
import { extname } from 'node:path';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { resolveRequestPath } from '../visual/serve-path.mjs';

/** The deploy prefix this mirrors: the real one, so the shape is not invented. */
export const PAGES_PREFIX = '/tanks/';

/** Enough of a MIME table for a built page; anything else is served as a byte stream. */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
};

/**
 * Strip the deploy prefix from a request, or refuse the request.
 *
 * Returning null for anything outside the prefix is the point rather than tidiness: it is
 * what makes an origin-absolute `/assets/...` a 404 instead of a hit, so a build whose
 * `base` stopped being relative fails here loudly.
 *
 * @param {string} url
 * @param {string} prefix
 * @returns {string | null} the path within `dist`, or null when the request is off-prefix
 */
export function stripPrefix(url, prefix = PAGES_PREFIX) {
  const path = (url ?? '').split('?')[0].split('#')[0];
  if (path === prefix.replace(/\/$/, '')) return '/';
  if (!path.startsWith(prefix)) return null;
  return `/${path.slice(prefix.length)}`;
}

/** A request handler serving `dist` under `prefix` and nothing outside it. */
export function subpathHandler(dist, prefix = PAGES_PREFIX, types = MIME) {
  return async (req, res) => {
    const within = stripPrefix(req.url, prefix);
    if (within === null) return void res.writeHead(404).end('off-prefix');
    const file = resolveRequestPath(dist, within === '/' ? '/index.html' : within);
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

/** Serve `dist` under `prefix` on an ephemeral loopback port. */
export function servePagesShape(dist, prefix = PAGES_PREFIX) {
  const server = createServer(subpathHandler(dist, prefix));
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/**
 * Judge the URL Exit Developer Mode landed on.
 *
 * Separate from the driving so it can be tested against URLs no browser has to produce,
 * including the ones that would mean the exit had gone wrong.
 *
 * @param {string} before the URL the session was entered at
 * @param {string} after the URL after Exit
 * @param {string[]} devParams the developer parameters that must be gone
 * @returns {string[]} one message per breach; empty means the contract held
 */
export function exitContractFailures(before, after, devParams) {
  const failures = [];
  const from = new URL(before);
  const to = new URL(after);

  if (to.pathname !== from.pathname) {
    failures.push(`exit changed the path: ${from.pathname} -> ${to.pathname}`);
  }
  for (const name of devParams) {
    if (to.searchParams.has(name)) {
      failures.push(`exit left the developer parameter ${name}=${to.searchParams.get(name)} in the address`);
    }
  }
  for (const [name, value] of from.searchParams) {
    if (devParams.includes(name)) continue;
    if (to.searchParams.get(name) !== value) {
      failures.push(
        `exit dropped or changed the unrelated parameter ${name}: ` +
          `${JSON.stringify(value)} -> ${JSON.stringify(to.searchParams.get(name))}`,
      );
    }
  }
  if (to.hash !== from.hash) failures.push(`exit changed the hash: ${from.hash} -> ${to.hash}`);
  return failures;
}
