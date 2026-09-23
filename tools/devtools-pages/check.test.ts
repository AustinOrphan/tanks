import { describe, expect, it } from 'vitest';

import { PAGES_PREFIX, exitContractFailures, stripPrefix } from './check.mjs';

/**
 * Issue #947. The browser journey lives in `journey.mjs` and is exercised by
 * `npm run devtools:pages`; what is unit-tested here is the two pure decisions it rests on,
 * because both have failure modes a passing journey would not reveal.
 *
 * The exit-URL RULE itself (`developerExitSearch`) is already pinned in
 * `src/game/dev-config.test.ts`. This judges the URL a browser actually landed on, which is
 * a different question: it is what catches the rule being right and the wiring not.
 */

describe('stripPrefix: the deploy shape', () => {
  it('serves the index for the prefix with and without its trailing slash', () => {
    expect(stripPrefix('/tanks/')).toBe('/');
    expect(stripPrefix('/tanks')).toBe('/');
  });

  it('maps a file under the prefix to its path within dist', () => {
    expect(stripPrefix('/tanks/assets/index-abc.js')).toBe('/assets/index-abc.js');
    expect(stripPrefix('/tanks/index.html')).toBe('/index.html');
  });

  it('REFUSES an origin-absolute asset path, which is the whole point of the prefix', () => {
    // A build whose `base` stopped being './' asks for /assets/... The root serve every
    // other browser tool here uses answers that happily; this one must not, or the one
    // deployment shape that matters stays untested. Observed live: rewriting index.html's
    // three './assets/' references to '/assets/' makes `npm run devtools:pages` fail with
    // "the app did not boot under /tanks/" and both 404s named.
    expect(stripPrefix('/assets/index-abc.js')).toBeNull();
    expect(stripPrefix('/index.html')).toBeNull();
    expect(stripPrefix('/')).toBeNull();
  });

  it('is not fooled by a sibling path that merely starts like the prefix', () => {
    expect(stripPrefix('/tanks-evil/secret')).toBeNull();
  });

  it('ignores the query and the hash when deciding', () => {
    expect(stripPrefix('/tanks/?dev=1&ref=keep')).toBe('/');
    expect(stripPrefix('/tanks/index.html#frag')).toBe('/index.html');
  });

  it('defaults to the prefix the deployment actually uses', () => {
    // Pins the constant, not just the parameter: a probe aimed at a made-up prefix would
    // pass while proving nothing about GitHub Pages.
    expect(PAGES_PREFIX).toBe('/tanks/');
    expect(stripPrefix('/other/x', '/other/')).toBe('/x');
  });
});

describe('exitContractFailures: judging where Exit landed', () => {
  const entered = 'http://host/tanks/?dev=1&aimRay=1&ref=keep';
  const DEV = ['dev', 'aimRay'];

  it('passes the exit this build actually performs', () => {
    expect(exitContractFailures(entered, 'http://host/tanks/?ref=keep', DEV)).toEqual([]);
  });

  it('FAILS when a developer parameter survives the exit', () => {
    const failures = exitContractFailures(entered, 'http://host/tanks/?dev=1&ref=keep', DEV);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/left the developer parameter dev=1/);
  });

  it('FAILS when an unrelated parameter is dropped', () => {
    // The half that is easy to lose: stripping developer parameters by rebuilding the
    // query from scratch would pass every "is dev gone" check and silently break a deep
    // link. #238 requires unrelated parameters to be preserved.
    const failures = exitContractFailures(entered, 'http://host/tanks/', DEV);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/dropped or changed the unrelated parameter ref/);
  });

  it('FAILS when an unrelated parameter is altered rather than dropped', () => {
    const failures = exitContractFailures(entered, 'http://host/tanks/?ref=other', DEV);
    expect(failures[0]).toMatch(/"keep" -> "other"/);
  });

  it('FAILS when the exit leaves the deploy path', () => {
    // `location.assign` with a path built from the wrong base would land on the origin
    // root -- a 404 on Pages, and a page that looks fine on a root serve.
    const failures = exitContractFailures(entered, 'http://host/?ref=keep', DEV);
    expect(failures.some((f) => /changed the path: \/tanks\/ -> \//.test(f))).toBe(true);
  });

  it('FAILS when the hash is lost', () => {
    const withHash = 'http://host/tanks/?dev=1&ref=keep#deep';
    expect(exitContractFailures(withHash, 'http://host/tanks/?ref=keep', DEV)[0])
      .toMatch(/changed the hash/);
    expect(exitContractFailures(withHash, 'http://host/tanks/?ref=keep#deep', DEV)).toEqual([]);
  });

  it('reports every breach at once rather than stopping at the first', () => {
    const failures = exitContractFailures(entered, 'http://host/other/?dev=1', DEV);
    expect(failures.length).toBeGreaterThanOrEqual(3);
  });
});
