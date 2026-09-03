import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAt } from './lib.mjs';
import { runManifest, computeExitCode, STATUS } from './orchestrate.mjs';
import { formatResult, runTestsReal, readReachabilityReport, relatedFilesForAll } from './run.mjs';
import { collectReachability } from './reachability.mjs';
import type { ManifestEntry } from './lib.mjs';

/**
 * The harness's own tests. Three layers, on purpose:
 *
 * - lib.mjs and orchestrate.mjs, exercised with FAKE deps (in-memory strings, no real
 *   fs/git/vitest). Fast, and what makes edge cases like "ambiguous find" or "restore
 *   verification fails" cheap to hit deliberately.
 * - run.mjs's own pure pieces (parseArgs, formatResult, dirtyReport, reachability
 *   report validation), unit tested directly against values -- no subprocess needed
 *   for CLI-argument, message-formatting, or worker-schema logic. The reachability
 *   worker's one-context/many-source lifecycle is also tested with a fake context,
 *   then its transitive per-source result is checked once against a REAL Vitest graph.
 * - a few REAL end-to-end cases that run runOne/runManifest with REAL fs and a REAL
 *   vitest subprocess (run.mjs's own runTestsReal), against a throwaway fixture
 *   .test.ts file generated with a unique name for each one and deleted in a finally.
 *
 *   That file is deliberately NOT a member of the normal `npm test` suite, and not
 *   reused by anything else: it is created (with a name unique to this process/run)
 *   only after `vitest run`'s own one-shot startup glob has already resolved, so this
 *   suite's own copy of itself never discovers or imports it, and nothing else in the
 *   tree ever reads it while the harness has it mid-mutation. Earlier drafts of this
 *   file used a small fixture pair COMMITTED under tools/mutate/fixtures/ -- but a
 *   committed file matching `tools/**\/*.test.ts` is *also* collected and run by the
 *   outer `npm test` process as an ordinary test file, in parallel with this one, which
 *   raced: the outer worker's own copy of that fixture test could import the file while
 *   THIS test had it mutated on disk mid-flight, and see the mutated (temporarily
 *   "wrong") content. A uniquely-named, created-then-deleted file has no such sibling
 *   to race against. The dirty-check (`gitPorcelain`) is stubbed for this one test
 *   rather than backed by real git, because a freshly-created scratch file is
 *   necessarily untracked -- `git status --porcelain` on it is never empty, which the
 *   harness correctly (for real manifest entries, which always target long-committed
 *   files) treats as "dirty, refuse". That refusal path is covered separately, with
 *   fakes, in "runOne > refuses a dirty file before touching it" below.
 *
 * "A guard is worth what its own tests prove" (CLAUDE.md) -- so every negative control
 * this tool's own doc comment promises has a test here: a find that does not match
 * must report FAILED-TO-APPLY, not SURVIVED; a manifest whose declared outcome is
 * wrong must produce a non-zero exit code; a pre-existing red test in scope must
 * report BASELINE-RED rather than blaming the mutation (proven fake AND real); a
 * mutation scoped to test files that do not reach it must refuse to start rather than
 * report SURVIVES; and a suite that fails to COLLECT under a mutation must count as
 * killed even when it drives `failed`/`total` to 0.
 */

const ROOT = new URL('../../', import.meta.url).pathname;

// Several suites below spawn a REAL vitest subprocess (the end-to-end apply/run/restore
// cases, the shared reachability graph, the real related-files worker). Alone they take
// 1.5 to 2.5 s each; under the mutation pool, where up to nine harness workers each run
// vitest at once (issue #502), the same subprocess can take longer than vitest's default
// 5 s per-test budget, and the whole file then reads as BASELINE-RED for every entry
// scoped to it -- seen on 2026-09-02 as 1 of 112 failing in one worker only. The budget
// here is for contention, not for slowness in the code under test; a hang still trips
// the harness's own 180 s subprocess kill first.
vi.setConfig({ testTimeout: 60_000 });

// ---------------------------------------------------------------------------
// lib.mjs: pure text surgery and manifest validation
// ---------------------------------------------------------------------------





// ---------------------------------------------------------------------------
// orchestrate.mjs: runOne / runManifest / computeExitCode, against fake deps
// ---------------------------------------------------------------------------

/**
 * A standalone `runOne` calls `runTests` TWICE when it gets far enough -- once for the
 * pre-mutation baseline, once after the mutation is applied. `runManifest` may reuse
 * the first result for later entries with the exact same scope. This fake primarily
 * serves the standalone cases and distinguishes the two phases by call order:
 *   - `overrides.baseline`: the FIRST call's result (default: a healthy 3-test run).
 *   - `overrides.baselineThrow`: an Error to throw on the first call instead.
 *   - `overrides.runTests`: the function used for every call AFTER the first (the
 *     post-mutation check) -- this is what most existing tests already set, and
 *     keeping it as "the post-mutation result" is what lets them stay unchanged.
 */
type TestRunResult = { failed: number; total: number; failedSuites?: number };
type FakeDepsOverrides = {
  initialFiles?: [string, string][];
  runTests?: (tests: string[]) => TestRunResult;
  dirty?: string;
  corruptRestore?: boolean;
  baselineThrow?: unknown;
  baseline?: TestRunResult;
  extraDeps?: Record<string, unknown>;
};
function fakeDeps(overrides: FakeDepsOverrides = {}) {
  const files = new Map(overrides.initialFiles ?? [['f.ts', 'const X = 1;']]);
  const calls = { readFile: 0, applyToDisk: 0, restoreToDisk: 0, runTests: 0 };
  const post = overrides.runTests ?? (() => ({ failed: 1, total: 3, failedSuites: 0 }));
  let runTestsCalls = 0;
  return {
    calls,
    files,
    readFile: vi.fn((file: string) => {
      calls.readFile++;
      // Non-null assertion, not a fallback: every test here sets up `files` to already
      // contain the key it reads, so an undefined `.get()` would be a genuine fixture
      // bug -- a fallback like `?? ''` would hide that behind a passing-looking read
      // instead of surfacing it as the type error / runtime mismatch it should be.
      return files.get(file)!;
    }),
    gitPorcelain: vi.fn(() => overrides.dirty ?? ''),
    applyToDisk: vi.fn((file, content) => {
      calls.applyToDisk++;
      files.set(file, content);
    }),
    restoreToDisk: vi.fn((file, content) => {
      calls.restoreToDisk++;
      files.set(file, overrides.corruptRestore ? content + '\n// corrupted' : content);
    }),
    runTests: vi.fn((tests) => {
      calls.runTests++;
      runTestsCalls++;
      if (runTestsCalls === 1) {
        if (overrides.baselineThrow) throw overrides.baselineThrow;
        return overrides.baseline ?? { failed: 0, total: 3, failedSuites: 0 };
      }
      return post(tests);
    }),
    onResult: vi.fn(),
    ...overrides.extraDeps,
  };
}

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: 'e1', file: 'f.ts', find: 'const X = 1;', replace: 'const X = 2;',
  why: 'test', expect: 'killed', tests: ['f.test.ts'], ...over,
});




// ---------------------------------------------------------------------------
// run.mjs's own pure pieces: CLI args, result formatting, the dirty-check message
// ---------------------------------------------------------------------------








// ---------------------------------------------------------------------------
// End-to-end: real fs + a real vitest subprocess (run.mjs's own runTestsReal),
// against a throwaway fixture created and destroyed within this one test.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// End-to-end: relatedFilesForAll against REAL broken subprocesses -- this preserves
// the exact failure boundary review found live while replacing many cold Vitest
// processes with one worker. A failed worker must never fall through to an empty map
// and claim "nothing tests this file at all." Reproduced with real stub executables,
// not fakes, to prove the actual spawnSync/existsSync wiring and not just the pure
// classifier tested above.
// ---------------------------------------------------------------------------


// The worktree pool's pure pieces (issue #502): how `--jobs` is read, how entries are
// dealt to workers, and how the workers' exit codes fold into one.



// `killedBy` (issue #504): the validation rules, the pure report reader, and the verdict
// through fake deps, so the contract is pinned without spawning vitest.





// The per-area manifest directory (issue #505): a pure merge that refuses an id in two
// files, and the loader that reads a file or every *.json in a directory by name.


// The pull-request selection (issue #506): four rules and an always-run list, each with
// a change that must NOT select as its negative control.

describe('shared Vitest reachability graph', () => {
  const fixturesDir = join(ROOT, 'tools/mutate/fixtures');

  function removeReachabilityFixtures() {
    if (!existsSync(fixturesDir)) return;
    for (const file of readdirSync(fixturesDir)) {
      if (file.startsWith('tmp-reachability-')) rmSync(join(fixturesDir, file), { force: true });
    }
  }

  beforeAll(removeReachabilityFixtures);
  afterAll(removeReachabilityFixtures);

  const validReport = () => ({
    version: 1 as const,
    sourceCount: 2,
    testSpecificationCount: 17,
    durationMs: 42,
    relatedByFile: {
      'src/a.ts': ['src/a.test.ts'],
      'src/b.ts': ['src/b.test.ts'],
    },
  });

  it('validates and preserves a distinct related-test set for every source (never a union)', () => {
    const { relatedByFile } = readReachabilityReport(validReport(), ['src/a.ts', 'src/b.ts']);
    expect(relatedByFile.get('src/a.ts')).toEqual(new Set(['src/a.test.ts']));
    expect(relatedByFile.get('src/b.ts')).toEqual(new Set(['src/b.test.ts']));
    expect(relatedByFile.get('src/a.ts')?.has('src/b.test.ts')).toBe(false);
  });

  it('rejects missing, malformed, and inconsistent worker reports instead of treating them as zero coverage', () => {
    const missing = validReport();
    delete (missing.relatedByFile as Partial<typeof missing.relatedByFile>)['src/b.ts'];
    expect(() => readReachabilityReport(missing, ['src/a.ts', 'src/b.ts']))
      .toThrow(/no per-source result for src\/b\.ts/);

    const malformed = validReport();
    (malformed.relatedByFile as Record<string, unknown>)['src/b.ts'] = [null];
    expect(() => readReachabilityReport(malformed, ['src/a.ts', 'src/b.ts']))
      .toThrow(/invalid per-source result for src\/b\.ts/);

    expect(() => readReachabilityReport({ ...validReport(), sourceCount: 1 }, ['src/a.ts', 'src/b.ts']))
      .toThrow(/invalid or inconsistent metadata/);
    expect(() => readReachabilityReport({ ...validReport(), durationMs: -1 }, ['src/a.ts', 'src/b.ts']))
      .toThrow(/invalid or inconsistent metadata/);
  });

  it('creates and closes one context while querying each source separately', async () => {
    const sourceA = 'src/a.ts';
    const sourceB = 'src/b.ts';
    const seenRelated: string[][] = [];
    const close = vi.fn(async () => {});
    const context = {
      config: { related: undefined as string[] | undefined },
      globTestSpecifications: vi.fn(async () => [
        { moduleId: join(ROOT, 'src/a.test.ts') },
        { moduleId: join(ROOT, 'src/b.test.ts') },
      ]),
      getRelevantTestSpecifications: vi.fn(async () => {
        seenRelated.push([...(context.config.related ?? [])]);
        const moduleId = context.config.related?.[0] === join(ROOT, sourceA)
          ? join(ROOT, 'src/a.test.ts')
          : join(ROOT, 'src/b.test.ts');
        return [{ moduleId }, { moduleId }]; // duplicate proves normalization too
      }),
      close,
    };
    const createContext = vi.fn(async () => context);

    const report = await collectReachability([sourceA, sourceB, sourceA], ROOT, {
      createContext: createContext as never,
    });

    expect(createContext).toHaveBeenCalledTimes(1);
    expect(context.globTestSpecifications).toHaveBeenCalledTimes(1);
    expect(context.getRelevantTestSpecifications).toHaveBeenCalledTimes(2);
    expect(seenRelated).toEqual([
      [join(ROOT, sourceA)],
      [join(ROOT, sourceB)],
    ]);
    expect(report.sourceCount).toBe(2);
    expect(report.relatedByFile[sourceA]).toEqual(['src/a.test.ts']);
    expect(report.relatedByFile[sourceB]).toEqual(['src/b.test.ts']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still closes the shared context if a per-source query fails', async () => {
    const close = vi.fn(async () => {});
    const context = {
      config: { related: undefined as string[] | undefined },
      globTestSpecifications: vi.fn(async () => []),
      getRelevantTestSpecifications: vi.fn(async () => { throw new Error('graph transform failed'); }),
      close,
    };
    const createContext = vi.fn(async () => context);

    await expect(collectReachability(['src/a.ts'], ROOT, { createContext: createContext as never }))
      .rejects.toThrow('graph transform failed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('matches Vitest\'s real transitive graph independently for two temporary sources', async () => {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = `tools/mutate/fixtures/tmp-reachability-${id}`;
    const sourceA = `${base}-a.ts`;
    const bridgeA = `${base}-a-bridge.ts`;
    const sourceB = `${base}-b.ts`;
    const testA = `${base}-a.test.ts`;
    const testB = `${base}-b.test.ts`;
    const paths = [sourceA, bridgeA, sourceB, testA, testB];
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(join(ROOT, sourceA), 'export const sourceA = 1;\n');
    writeFileSync(join(ROOT, bridgeA), `export { sourceA } from './tmp-reachability-${id}-a.ts';\n`);
    writeFileSync(join(ROOT, sourceB), 'export const sourceB = 2;\n');
    writeFileSync(
      join(ROOT, testA),
      `import { expect, it } from 'vitest';\nimport { sourceA } from './tmp-reachability-${id}-a-bridge.ts';\nit('uses source A transitively', () => expect(sourceA).toBe(1));\n`,
    );
    writeFileSync(
      join(ROOT, testB),
      `import { expect, it } from 'vitest';\nimport { sourceB } from './tmp-reachability-${id}-b.ts';\nit('uses source B directly', () => expect(sourceB).toBe(2));\n`,
    );

    try {
      const report = await collectReachability([sourceA, sourceB], ROOT);
      expect(report.relatedByFile[sourceA]).toContain(testA);
      expect(report.relatedByFile[sourceA]).not.toContain(testB);
      expect(report.relatedByFile[sourceB]).toContain(testB);
      expect(report.relatedByFile[sourceB]).not.toContain(testA);
    } finally {
      for (const path of paths) rmSync(join(ROOT, path), { force: true });
    }
  }, 30_000);
});

describe('end-to-end: real apply -> real vitest subprocess -> real restore', () => {
  const fixturesDir = join(ROOT, 'tools/mutate/fixtures');

  // Self-healing safety net: every fixture below is cleaned up in its own `finally`,
  // but a genuinely CRASHED run (the process killed outright, not just a failing
  // assertion) skips finally blocks too. A leftover `tmp-e2e-*.test.ts` matches
  // vite.config.ts's `tools/**/*.test.ts` include glob, so the NEXT `npm test` would
  // silently pick it up and run it as if it were a real suite member. Swept once, up
  // front, for ANY pid's leftovers -- not just this process's own, since the whole
  // point is defending against a PREVIOUS run that never got to clean up.
  beforeAll(() => {
    if (!existsSync(fixturesDir)) return;
    for (const f of readdirSync(fixturesDir)) {
      if (f.startsWith('tmp-e2e-')) rmSync(join(fixturesDir, f), { force: true });
    }
  });

  function makeFixture(greeting: string) {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rel = `tools/mutate/fixtures/tmp-e2e-${id}.test.ts`;
    const abs = join(ROOT, rel);
    mkdirSync(fixturesDir, { recursive: true });
    const source =
      "import { describe, it, expect } from 'vitest';\n" +
      `function greet(name: string) { return \`${greeting} \${name}\`; }\n` +
      "describe('e2e fixture', () => {\n" +
      `  it('greets by name', () => { expect(greet('world')).toBe('${greeting} world'); });\n` +
      '});\n';
    writeFileSync(abs, source);
    return { rel, abs, source };
  }

  // Real fs, real vitest subprocess -- but a stubbed git, since a freshly-created
  // scratch file is inherently untracked (see the file-level comment above).
  function realDepsWithStubGit(onResult = () => {}) {
    return {
      readFile: (file: string) => readFileSync(join(ROOT, file), 'utf8'),
      gitPorcelain: () => '',
      applyToDisk: (file: string, content: string) => writeFileSync(join(ROOT, file), content),
      restoreToDisk: (file: string, content: string) => writeFileSync(join(ROOT, file), content),
      runTests: runTestsReal,
      onResult,
    };
  }

  it('a real killed mutation: matches "killed", and an INDEPENDENT fs read (a fresh readFileSync, not the deps the harness itself used) confirms the file is back to its original bytes', () => {
    const { rel, abs, source } = makeFixture('hello');
    try {
      const results = runManifest(
        [{
          id: 'e2e-killed', file: rel,
          find: 'function greet(name: string) { return `hello ${name}`; }',
          replace: 'function greet(name: string) { return `yo ${name}`; }',
          why: 'the fixture test asserts the exact string "hello world"',
          expect: 'killed',
          tests: [rel],
        }],
        realDepsWithStubGit(),
        applyAt,
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe(STATUS.KILLED);
      expect(results[0].matches).toBe(true);
      expect(results[0].detail).toBe('1 of 1 test(s) failed');
      // The vitest full name of the one failing test rides along, which is what a
      // `killedBy` entry is matched against (issue #504).
      expect(results[0].failedTests).toEqual(['e2e fixture greets by name']);
      expect(readFileSync(abs, 'utf8')).toBe(source); // independent re-read, byte-exact
    } finally {
      rmSync(abs, { force: true });
    }
  });

  it('a real killedBy entry matches when its named test fails, and a name that does not fail is a mismatch that names it (issue #504)', () => {
    const { rel, abs, source } = makeFixture('hello');
    try {
      const base = {
        file: rel,
        find: 'function greet(name: string) { return `hello ${name}`; }',
        replace: 'function greet(name: string) { return `yo ${name}`; }',
        why: 'the fixture test asserts the exact string "hello world"',
        expect: 'killed' as const,
        tests: [rel],
      };
      const results = runManifest(
        [
          { id: 'e2e-killed-by', ...base, killedBy: ['e2e fixture greets by name'] },
          { id: 'e2e-killed-by-wrong-name', ...base, killedBy: ['e2e fixture greets by name', 'e2e fixture a test that does not exist'] },
        ],
        realDepsWithStubGit(),
        applyAt,
      );
      expect(results[0].status).toBe(STATUS.KILLED);
      expect(results[0].matches, 'the named test failed, so this is a match').toBe(true);
      expect(results[0].missingKilledBy).toEqual([]);
      expect(results[1].status, 'the negative control is still KILLED').toBe(STATUS.KILLED);
      expect(results[1].matches).toBe(false);
      expect(results[1].missingKilledBy).toEqual(['e2e fixture a test that does not exist']);
      expect(formatResult(results[1], 2, 2, { expect: 'killed', killedBy: results[1].missingKilledBy })).toMatch(
        /MISMATCH: killedBy test\(s\) did not fail: "e2e fixture a test that does not exist"/,
      );
      expect(readFileSync(abs, 'utf8')).toBe(source);
    } finally {
      rmSync(abs, { force: true });
    }
  });

  it('a manifest declaring the WRONG outcome for a real, really-killed mutation is a real mismatch -- and the file is still restored', () => {
    const { rel, abs, source } = makeFixture('hello');
    try {
      const results = runManifest(
        [{
          id: 'e2e-wrong-declared', file: rel,
          find: 'function greet(name: string) { return `hello ${name}`; }',
          replace: 'function greet(name: string) { return `yo ${name}`; }',
          why: 'deliberately wrong: this mutation is killed, declared survives',
          expect: 'survives', // WRONG on purpose
          tests: [rel],
        }],
        realDepsWithStubGit(),
        applyAt,
      );
      expect(results[0].status).toBe(STATUS.KILLED);
      expect(results[0].matches).toBe(false);
      expect(computeExitCode(results)).toBe(1);
      expect(readFileSync(abs, 'utf8')).toBe(source);
    } finally {
      rmSync(abs, { force: true });
    }
  });

  it('FAILED-TO-APPLY against a real file when find does not match -- never SURVIVED, and vitest is never even spawned', () => {
    const { rel, abs, source } = makeFixture('hello');
    const runTests = vi.fn(runTestsReal);
    try {
      const results = runManifest(
        [{
          id: 'e2e-not-found', file: rel,
          find: 'this string is not in the fixture', replace: 'x',
          why: 'negative control', expect: 'survives', tests: [rel],
        }],
        { ...realDepsWithStubGit(), runTests },
        applyAt,
      );
      expect(results[0].status).toBe(STATUS.FAILED_TO_APPLY);
      expect(results[0].matches).toBe(false);
      expect(runTests).not.toHaveBeenCalled(); // no vitest subprocess for a mutation that never applied
      expect(readFileSync(abs, 'utf8')).toBe(source); // never touched
    } finally {
      rmSync(abs, { force: true });
    }
  });

  it('a real pre-existing failure makes the baseline RED, real vitest agreeing -- and the file is never touched', () => {
    // Same fixture shape as the others, but its OWN assertion is already false before
    // any mutation -- this is the reviewer's proof case, reproduced for real: without
    // the baseline check, this mutation (a genuine no-op find/replace on an unrelated
    // line) would report KILLED at exit 0, blaming the mutation for a pre-existing red
    // test that has nothing to do with it.
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rel = `tools/mutate/fixtures/tmp-e2e-${id}.test.ts`;
    const abs = join(ROOT, rel);
    mkdirSync(fixturesDir, { recursive: true });
    const source =
      "import { describe, it, expect } from 'vitest';\n" +
      'function greet(name: string) { return `hello ${name}`; }\n' +
      "describe('e2e fixture', () => {\n" +
      "  it('greets by name', () => { expect(greet('world')).toBe('hello world'); });\n" +
      "  it('an unrelated assertion that is already false', () => { expect(1).toBe(2); });\n" +
      '});\n';
    writeFileSync(abs, source);
    try {
      const results = runManifest(
        [{
          id: 'e2e-baseline-red', file: rel,
          find: "function greet(name: string) { return `hello ${name}`; }",
          replace: "function greet(name: string) { return `hello ${name}`.trim(); }", // behaviour-preserving no-op
          why: 'proves the baseline check fires for real, against a real vitest run',
          expect: 'killed', // would be "true" under the old (no-baseline) logic
          tests: [rel],
        }],
        realDepsWithStubGit(),
        applyAt,
      );
      expect(results[0].status).toBe(STATUS.BASELINE_RED);
      expect(results[0].matches).toBe(false);
      expect(results[0].detail).toMatch(/baseline is red before any mutation: 1 of 2 failing/);
      // The whole point: nothing was ever written to disk for this entry.
      expect(readFileSync(abs, 'utf8')).toBe(source);
    } finally {
      rmSync(abs, { force: true });
    }
  });

  it('no stray tmp-e2e-* fixtures from THIS process are left in tools/mutate/fixtures/ after this suite', () => {
    // Scoped to this process's own pid prefix, not every tmp-e2e-* file: a fixture
    // left behind by an unrelated crashed run (a different pid) is a separate,
    // pre-existing problem this assertion should not fail on.
    const mine = `tmp-e2e-${process.pid}-`;
    const left = existsSync(fixturesDir)
      ? readdirSync(fixturesDir).filter((f) => f.startsWith(mine))
      : [];
    expect(left).toEqual([]);
  });
});

describe('relatedFilesForAll against real broken subprocesses', () => {
  const scratchDir = join(tmpdir(), `mutate-relatedFilesFor-test-${process.pid}`);

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function makeStub(script: string): string {
    mkdirSync(scratchDir, { recursive: true });
    const path = join(scratchDir, `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return path;
  }

  it('a worker stub that prints to stderr and exits 1 throws .indeterminate -- NOT an empty (silently "nothing tests this file") map', () => {
    const stub = makeStub('#!/bin/sh\necho "stub vitest: simulated crash" >&2\nexit 1\n');
    let caught: unknown;
    try {
      relatedFilesForAll(['src/render/skins.ts::stub-exit-1'], ROOT, stub, []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { indeterminate?: boolean }).indeterminate).toBe(true);
    expect((caught as Error).message).toMatch(/could not determine which tests relate to|failed --/);
    expect((caught as Error).message).not.toMatch(/interrupted/);
  });

  it('a missing worker executable (spawnSync sets res.error, ENOENT) throws .indeterminate too -- proven by literally deleting the target, matching review\'s own reproduction', () => {
    const missing = join(scratchDir, `does-not-exist-${Date.now()}.sh`);
    expect(existsSync(missing)).toBe(false); // never created
    let caught: unknown;
    try {
      relatedFilesForAll(['src/render/skins.ts::missing-binary'], ROOT, missing, []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { indeterminate?: boolean }).indeterminate).toBe(true);
  });

  it('a stub that exits 130 with no signal (vitest\'s own SIGINT handling) throws .interrupted, not .indeterminate', () => {
    const stub = makeStub('#!/bin/sh\nexit 130\n');
    let caught: unknown;
    try {
      relatedFilesForAll(['src/render/skins.ts::stub-130'], ROOT, stub, []);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error & { interrupted?: boolean }).interrupted).toBe(true);
  });

  it('a genuinely empty but SUCCESSFUL probe (a real file nothing imports, against the REAL vitest binary) returns an empty Set -- this is the ONLY one of the four cases that legitimately means "nothing related"', () => {
    const orphanRel = `tools/mutate/fixtures/tmp-e2e-orphan-${process.pid}-${Date.now()}.ts`;
    const orphanAbs = join(ROOT, orphanRel);
    mkdirSync(join(ROOT, 'tools/mutate/fixtures'), { recursive: true });
    writeFileSync(orphanAbs, 'export const nothingImportsThis = 1;\n');
    try {
      const relatedByFile = relatedFilesForAll([orphanRel], ROOT); // real shared worker
      expect(relatedByFile.get(orphanRel)).toEqual(new Set());
    } finally {
      rmSync(orphanAbs, { force: true });
    }
  });

  it('the four failure/success shapes are pairwise distinguishable end to end, not just in the pure classifier', () => {
    const crashStub = makeStub('#!/bin/sh\necho crash >&2\nexit 1\n');
    const sigintStub = makeStub('#!/bin/sh\nexit 130\n');
    const missing = join(scratchDir, 'nope.sh');

    const outcomes: string[] = [];
    for (const [label, bin] of [['crash', crashStub], ['missing', missing], ['sigint', sigintStub]] as const) {
      try {
        relatedFilesForAll([`src/render/skins.ts::pairwise-${label}`], ROOT, bin, []);
        outcomes.push('ok');
      } catch (e) {
        const err = e as Error & { interrupted?: boolean; indeterminate?: boolean };
        outcomes.push(err.interrupted ? 'interrupted' : err.indeterminate ? 'indeterminate' : 'other');
      }
    }
    expect(outcomes).toEqual(['indeterminate', 'indeterminate', 'interrupted']);
  });
});
