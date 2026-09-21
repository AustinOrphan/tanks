// The offline half of `npm run lint:workflows` (issue #761): pins, platform refusal, the
// digest check, workflow discovery and the known-bad fixture contract. The download and the
// actionlint run itself are exercised by the command, which required CI runs on every push.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ACTIONLINT_VERSION,
  DOWNLOAD_ATTEMPTS,
  FIXTURES,
  PINS,
  SHELLCHECK_VERSION,
  backoffMs,
  pinsFor,
  retryableStatus,
  unreportedFixtures,
  verifyDigest,
  workflowFiles,
} from './lint.mjs';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('workflow lint pins', () => {
  it('pins both tools, by version and a SHA-256, for every supported platform', () => {
    expect(Object.keys(PINS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
    for (const [platform, pins] of Object.entries(PINS)) {
      expect(pins.actionlint.url, platform).toContain(`/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_`);
      expect(pins.shellcheck.url, platform).toContain(`/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.`);
      for (const pin of [pins.actionlint, pins.shellcheck]) {
        expect(pin.url, platform).toMatch(/^https:\/\/github\.com\/(rhysd\/actionlint|koalaman\/shellcheck)\/releases\/download\//);
        expect(pin.sha256, platform).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    // Eight archives, eight different digests: a digest pasted into the wrong row would
    // otherwise pass every shape check above and fail only on that platform's first run.
    const digests = Object.values(PINS).flatMap((p) => [p.actionlint.sha256, p.shellcheck.sha256]);
    expect(new Set(digests).size).toBe(8);
  });

  it('refuses a platform it has no pin for, naming the ones it has', () => {
    expect(pinsFor('linux', 'x64')).toBe(PINS['linux-x64']);
    expect(() => pinsFor('win32', 'x64')).toThrow(/no pinned actionlint\/shellcheck for win32-x64; supported: linux-x64/);
  });

  it('refuses bytes whose digest is not the pinned one', () => {
    const bytes = Buffer.from('actionlint');
    const good = createHash('sha256').update(bytes).digest('hex');
    expect(verifyDigest(bytes, good, 'fixture')).toBe(good);
    expect(() => verifyDigest(Buffer.from('actionlinT'), good, 'fixture archive')).toThrow(
      /fixture archive has SHA-256 [0-9a-f]{64}, pinned [0-9a-f]{64}; refusing to run it/,
    );
  });
});

describe('workflow lint download retry', () => {
  it('retries the statuses that are transient, and not the ones that mean a wrong pin', () => {
    // 504 is the one that actually happened: `verify (floor)` went red on `main` on
    // 2026-09-21 with HTTP 504 from the shellcheck release asset, on a tree that touched no
    // workflow. 404 is the counter-case -- a wrong pin does not get better on the third try,
    // and retrying it only makes the failure slower and its message less obvious.
    for (const status of [500, 502, 503, 504, 408, 429]) {
      expect(retryableStatus(status), `${status} is transient`).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 410]) {
      expect(retryableStatus(status), `${status} means the pin or the host is wrong`).toBe(false);
    }
  });

  it('tries more than once, and waits longer each time', () => {
    // Stated rather than assumed: with one attempt the retry does nothing, and with a flat
    // zero backoff three attempts land inside the same bad second the first one hit.
    expect(DOWNLOAD_ATTEMPTS).toBeGreaterThan(1);
    const waits = Array.from({ length: DOWNLOAD_ATTEMPTS - 1 }, (_, i) => backoffMs(i + 1));
    expect(waits.every((ms) => ms > 0), `backoffs were ${waits.join(', ')}`).toBe(true);
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i], `backoff ${i + 1} does not exceed backoff ${i}`).toBeGreaterThan(waits[i - 1]);
    }
  });
});

describe('workflow lint scope', () => {
  it('lints every .yml and .yaml file GitHub reads, and nothing else', () => {
    expect(workflowFiles(['b.yaml', 'a.yml', 'README.md', 'c.yml.bak'])).toEqual(['a.yml', 'b.yaml']);
    // The repository today: every file in the directory is a workflow, so none is skipped.
    const names = readdirSync(new URL('../../.github/workflows/', import.meta.url));
    expect(workflowFiles(names)).toHaveLength(names.length);
  });

  it('runs in required CI before the typecheck, through the package script', () => {
    expect(JSON.parse(read('package.json')).scripts['lint:workflows']).toBe('node tools/workflow-lint/run.mjs');
    const ci = read('.github/workflows/ci.yml');
    expect(ci.indexOf('run: npm run lint:workflows')).toBeGreaterThan(0);
    expect(ci.indexOf('run: npm run lint:workflows')).toBeLessThan(ci.indexOf('run: npm run typecheck'));
  });
});

describe('workflow lint known-bad fixtures', () => {
  it('has one committed fixture per entry, covering malformed YAML and an invalid expression', () => {
    const committed = readdirSync(new URL('./fixtures/', import.meta.url)).sort();
    expect(committed).toEqual(FIXTURES.map((f) => f.file).sort());
    expect(FIXTURES.map((f) => f.rule)).toEqual(expect.arrayContaining(['syntax-check', 'expression', 'action', 'shellcheck']));
  });

  it('accepts a fixture run only when every fixture reported its own rule', () => {
    const reported = FIXTURES.map((f) => ({ filepath: `tools/workflow-lint/fixtures/${f.file}`, kind: f.rule }));
    expect(unreportedFixtures(reported)).toEqual([]);
    // One fixture silent: named, with what was reported instead.
    const silent = reported.filter((e) => !e.filepath.endsWith('/invalid-expression.yml'));
    expect(unreportedFixtures(silent).map((m) => [m.fixture.file, m.reported])).toEqual([['invalid-expression.yml', []]]);
    // A fixture that fails for the WRONG rule does not count: YAML that no longer parses
    // would otherwise satisfy the expression fixture.
    const wrongRule = reported.map((e) =>
      e.filepath.endsWith('/invalid-expression.yml') ? { ...e, kind: 'syntax-check' } : e);
    expect(unreportedFixtures(wrongRule).map((m) => m.fixture.file)).toEqual(['invalid-expression.yml']);
    // actionlint prints the path it was given; Windows separators and bare names match too.
    expect(unreportedFixtures([{ filepath: 'fixtures\\malformed-yaml.yml', kind: 'syntax-check' }], [FIXTURES[0]])).toEqual([]);
  });
});
