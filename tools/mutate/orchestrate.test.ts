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
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOccurrences, applyAt, validateEntry, validateManifest, findUnreachableEntries } from './lib.mjs';
import { runOne, runManifest, computeExitCode, STATUS, RestoreFailedError } from './orchestrate.mjs';
import {
  parseArgs, parseJobs, partitionByScope, scopeCostLookup, aggregateExitCodes, formatResult, dirtyReport, unreachableReport,
  resolveManifestPath, runTestsReal, classifySubprocessFailure, readReachabilityReport, relatedFilesForAll,
  failedTestNames,
} from './run.mjs';
import { scopeCosts } from './scope-costs.mjs';
import { collectReachability } from './reachability.mjs';
import type { ManifestEntry } from './lib.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// lib.mjs: pure text surgery and manifest validation
// ---------------------------------------------------------------------------

describe('findOccurrences', () => {
  it('finds zero, one, and many non-overlapping matches', () => {
    expect(findOccurrences('abc', 'xyz')).toEqual([]);
    expect(findOccurrences('abcabc', 'abc')).toEqual([0, 3]);
    expect(findOccurrences('aaaa', 'aa')).toEqual([0, 2]); // non-overlapping
  });

  it('rejects an empty find string rather than matching everywhere', () => {
    expect(() => findOccurrences('abc', '')).toThrow(/non-empty/);
  });
});

describe('applyAt', () => {
  it('applies a unique find with no occurrence given', () => {
    const r = applyAt('const X = 1;', 'const X = 1;', 'const X = 2;', undefined);
    expect(r).toEqual({ ok: true, content: 'const X = 2;', count: 1 });
  });

  it('reports not-found rather than silently doing nothing -- this is the exact failure mode a bad perl -0pi pattern produces', () => {
    const r = applyAt('const X = 1;', 'const Y = 1;', 'const Y = 2;', undefined);
    expect(r).toEqual({ ok: false, reason: 'not-found', count: 0 });
  });

  it('refuses an ambiguous find (2+ matches) with no occurrence, rather than picking the first', () => {
    const content = 'sounds[key] = null;\nx();\nsounds[key] = null;';
    const r = applyAt(content, 'sounds[key] = null;', 'sounds[key] = undefined;', undefined);
    expect(r).toEqual({ ok: false, reason: 'ambiguous', count: 2 });
  });

  it('applies to exactly the requested occurrence, leaving the other untouched', () => {
    const content = 'sounds[key] = null;\nx();\nsounds[key] = null;';
    const r = applyAt(content, 'sounds[key] = null;', 'sounds[key] = undefined;', 2);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable: asserted above'); // narrows r for TS below
    expect(r.content).toBe('sounds[key] = null;\nx();\nsounds[key] = undefined;');
  });

  it('rejects an occurrence index out of range', () => {
    const r = applyAt('a-b', 'a', 'z', 5);
    expect(r).toEqual({ ok: false, reason: 'bad-occurrence', count: 1 });
  });
});

describe('validateEntry', () => {
  // `why?` (and the rest) are typed loosely on purpose: these fixtures exist to feed
  // validateEntry deliberately-invalid shapes (a missing field, an out-of-range
  // occurrence, a mismatched expect/expectFailures pair), which a stricter type would
  // fight rather than help.
  type EntryFixture = {
    id: string; file: string; find: string; replace: string; why?: string;
    expect: string; tests: string[]; occurrence?: number; expectFailures?: number;
  };
  const base = (): EntryFixture => ({
    id: 'x', file: 'src/a.ts', find: 'a', replace: 'b', why: 'because',
    expect: 'killed', tests: ['src/a.test.ts'],
  });

  it('accepts a well-formed entry', () => {
    expect(() => validateEntry(base(), 1)).not.toThrow();
  });

  it('names the missing field', () => {
    const e = base();
    delete e.why;
    expect(() => validateEntry(e, 1)).toThrow(/"why"/);
  });

  it('rejects an expect value that is not killed/survives', () => {
    const e = { ...base(), expect: 'maybe' };
    expect(() => validateEntry(e, 1)).toThrow(/"expect"/);
  });

  it('rejects an empty tests array', () => {
    const e = { ...base(), tests: [] };
    expect(() => validateEntry(e, 1)).toThrow(/"tests"/);
  });

  it('rejects a non-integer occurrence', () => {
    const e = { ...base(), occurrence: 1.5 };
    expect(() => validateEntry(e, 1)).toThrow(/"occurrence"/);
  });

  it('rejects find === replace: a mutation that changes nothing is not a mutation', () => {
    const e = { ...base(), find: 'same', replace: 'same' };
    expect(() => validateEntry(e, 1)).toThrow(/identical/);
  });

  it('accepts a positive expectFailures on a killed entry', () => {
    expect(() => validateEntry({ ...base(), expect: 'killed', expectFailures: 5 }, 1)).not.toThrow();
  });

  it('rejects a non-integer or negative expectFailures', () => {
    expect(() => validateEntry({ ...base(), expectFailures: 1.5 }, 1)).toThrow(/"expectFailures"/);
    expect(() => validateEntry({ ...base(), expectFailures: -1 }, 1)).toThrow(/"expectFailures"/);
  });

  it('rejects expectFailures: 0 on a killed entry -- self-contradictory, not a real outcome', () => {
    const e = { ...base(), expect: 'killed', expectFailures: 0 };
    expect(() => validateEntry(e, 1)).toThrow(/"expect": "killed" requires "expectFailures" > 0/);
  });

  it('rejects a non-zero expectFailures on a survives entry -- survives already means 0', () => {
    const e = { ...base(), expect: 'survives', expectFailures: 3 };
    expect(() => validateEntry(e, 1)).toThrow(/"expect": "survives" requires "expectFailures": 0/);
  });
});

describe('validateManifest', () => {
  it('rejects duplicate ids', () => {
    const e = { id: 'x', file: 'f', find: 'a', replace: 'b', why: 'w', expect: 'killed', tests: ['t'] };
    expect(() => validateManifest([e, { ...e }])).toThrow(/duplicate id/);
  });

  it('rejects an empty manifest', () => {
    expect(() => validateManifest([])).toThrow(/non-empty/);
  });

  it('the shipped manifest.json is itself well-formed', async () => {
    const entries = JSON.parse(readFileSync(join(ROOT, 'tools/mutate/manifest.json'), 'utf8'));
    expect(() => validateManifest(entries)).not.toThrow();
    // Every path a real run would spawn vitest against must actually exist, or
    // "0 tests ran" becomes the failure mode instead of a clear manifest error.
    for (const entry of entries) {
      expect(existsSync(join(ROOT, entry.file)), `${entry.file} (from ${entry.id})`).toBe(true);
      for (const t of entry.tests) {
        expect(existsSync(join(ROOT, t)), `${t} (from ${entry.id})`).toBe(true);
      }
    }
  });
});

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

describe('runOne', () => {
  it('refuses a dirty file before touching it', () => {
    const deps = fakeDeps({ dirty: ' M f.ts' });
    const r = runOne(entry(), deps, applyAt);
    expect(r.status).toBe(STATUS.ERROR);
    expect(r.matches).toBe(false);
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.applyToDisk).not.toHaveBeenCalled();
  });

  it('a find that does not match reports FAILED-TO-APPLY, not SURVIVED -- and never runs tests', () => {
    const deps = fakeDeps();
    const r = runOne(entry({ find: 'not present anywhere' }), deps, applyAt);
    expect(r.status).toBe(STATUS.FAILED_TO_APPLY);
    expect(r.matches).toBe(false);
    expect(deps.applyToDisk).not.toHaveBeenCalled();
    expect(deps.runTests).not.toHaveBeenCalled();
  });

  it('an ambiguous find (present twice, no occurrence given) reports FAILED-TO-APPLY', () => {
    const deps = fakeDeps({ initialFiles: [['f.ts', 'dup();\ndup();']] });
    const r = runOne(entry({ find: 'dup();', replace: 'once();' }), deps, applyAt);
    expect(r.status).toBe(STATUS.FAILED_TO_APPLY);
    expect(r.detail).toMatch(/occurs 2 times/);
    expect(deps.runTests).not.toHaveBeenCalled();
  });

  it('an occurrence index selects the right match and applies successfully', () => {
    const deps = fakeDeps({
      initialFiles: [['f.ts', 'dup();\ndup();']],
      runTests: () => ({ failed: 0, total: 1 }),
    });
    const r = runOne(entry({ find: 'dup();', replace: 'once();', occurrence: 2, expect: 'survives' }), deps, applyAt);
    expect(r.status).toBe(STATUS.SURVIVES);
    expect(r.matches).toBe(true);
    // restored exactly to the original two-dup content
    expect(deps.files.get('f.ts')).toBe('dup();\ndup();');
  });

  it('reports KILLED when the scoped tests fail, and matches when that was declared', () => {
    const deps = fakeDeps({ runTests: () => ({ failed: 2, total: 5 }) });
    const r = runOne(entry({ expect: 'killed' }), deps, applyAt);
    expect(r.status).toBe(STATUS.KILLED);
    expect(r.matches).toBe(true);
    expect(r.detail).toBe('2 of 5 test(s) failed');
  });

  it('a manifest declaring the WRONG outcome is a mismatch, not silently accepted', () => {
    const deps = fakeDeps({ runTests: () => ({ failed: 0, total: 5 }) }); // actually survives
    const r = runOne(entry({ expect: 'killed' }), deps, applyAt); // manifest says killed
    expect(r.status).toBe(STATUS.SURVIVES);
    expect(r.matches).toBe(false);
  });

  it('a count DRIFT with the SAME outcome is still a mismatch when expectFailures is pinned -- this is the "4 of 12 became 5 of 13" case outcome-only matching cannot see', () => {
    const deps = fakeDeps({ runTests: () => ({ failed: 5, total: 13 }) }); // was 4 of 12 when the manifest was written
    const r = runOne(entry({ expect: 'killed', expectFailures: 4 }), deps, applyAt);
    expect(r.status).toBe(STATUS.KILLED); // outcome alone still matches...
    expect(r.matches).toBe(false); // ...but the pinned count does not
  });

  it('matches when both the outcome and the pinned count agree', () => {
    const deps = fakeDeps({ runTests: () => ({ failed: 5, total: 13 }) });
    const r = runOne(entry({ expect: 'killed', expectFailures: 5 }), deps, applyAt);
    expect(r.status).toBe(STATUS.KILLED);
    expect(r.matches).toBe(true);
  });

  it('an entry with no expectFailures only checks the outcome (backward compatible)', () => {
    const deps = fakeDeps({ runTests: () => ({ failed: 99, total: 100 }) });
    const r = runOne(entry({ expect: 'killed' }), deps, applyAt); // no expectFailures given
    expect(r.matches).toBe(true);
  });

  it('always restores, even when runTests throws', () => {
    const deps = fakeDeps({
      runTests: () => { throw new Error('vitest exploded'); },
    });
    expect(() => runOne(entry(), deps, applyAt)).toThrow('vitest exploded');
    expect(deps.restoreToDisk).toHaveBeenCalledTimes(1);
    expect(deps.files.get('f.ts')).toBe('const X = 1;'); // back to original
  });

  it('reports ERROR when the scoped test path matches zero tests', () => {
    const deps = fakeDeps({ runTests: () => ({ failed: 0, total: 0 }) });
    const r = runOne(entry(), deps, applyAt);
    expect(r.status).toBe(STATUS.ERROR);
    expect(r.matches).toBe(false);
    expect(r.detail).toMatch(/0 tests ran/);
  });

  it('throws loudly if the post-restore byte-compare fails -- a zero exit from the write is not verification', () => {
    const deps = fakeDeps({ corruptRestore: true });
    expect(() => runOne(entry(), deps, applyAt)).toThrow(/RESTORE FAILED/);
  });

  it('the restore-failure throw is specifically a RestoreFailedError, not a generic Error', () => {
    const deps = fakeDeps({ corruptRestore: true });
    let caught: unknown;
    try {
      runOne(entry(), deps, applyAt);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RestoreFailedError);
  });

  describe('baseline check (the scoped tests must be green BEFORE any mutation)', () => {
    it('a pre-existing failure in scope is BASELINE-RED, not attributed to the mutation -- and nothing is ever written to disk', () => {
      // This is the reviewer's own proof case: append one unrelated failing test to
      // the scoped file, and an otherwise-equivalent mutation must not read as KILLED.
      const deps = fakeDeps({ baseline: { failed: 1, total: 14, failedSuites: 0 } });
      const r = runOne(entry({ expect: 'killed' }), deps, applyAt);
      expect(r.status).toBe(STATUS.BASELINE_RED);
      expect(r.matches).toBe(false);
      expect(r.detail).toMatch(/baseline is red before any mutation: 1 of 14 failing/);
      expect(deps.applyToDisk).not.toHaveBeenCalled();
      expect(deps.calls.runTests).toBe(1); // only the baseline call -- no post-mutation run at all
    });

    it('a baseline where a whole suite fails to collect is BASELINE-RED even if failed === 0', () => {
      const deps = fakeDeps({ baseline: { failed: 0, total: 20, failedSuites: 1 } });
      const r = runOne(entry(), deps, applyAt);
      expect(r.status).toBe(STATUS.BASELINE_RED);
      expect(r.detail).toMatch(/1 suite\(s\) failed to collect/);
      expect(deps.applyToDisk).not.toHaveBeenCalled();
    });

    it('a baseline that matches zero tests is ERROR (a manifest path problem), not BASELINE-RED', () => {
      const deps = fakeDeps({ baseline: { failed: 0, total: 0, failedSuites: 0 } });
      const r = runOne(entry(), deps, applyAt);
      expect(r.status).toBe(STATUS.ERROR);
      expect(r.detail).toMatch(/0 tests ran for baseline/);
      expect(deps.applyToDisk).not.toHaveBeenCalled();
    });

    it('a healthy baseline proceeds to apply and run the post-mutation check (two runTests calls)', () => {
      const deps = fakeDeps({ runTests: () => ({ failed: 1, total: 3, failedSuites: 0 }) });
      const r = runOne(entry(), deps, applyAt);
      expect(r.status).toBe(STATUS.KILLED);
      expect(deps.calls.runTests).toBe(2);
    });
  });

  describe('a suite that fails to COLLECT under the mutation counts as killed', () => {
    it('failedSuites > 0 is killed even when failed === 0 (the "multi-file, one file will not collect" case)', () => {
      const deps = fakeDeps({ runTests: () => ({ failed: 0, total: 22, failedSuites: 1 }) });
      const r = runOne(entry({ expect: 'killed' }), deps, applyAt);
      expect(r.status).toBe(STATUS.KILLED); // NOT survives, even though failed is 0
      expect(r.matches).toBe(true);
      expect(r.detail).toMatch(/0 of 22 test\(s\) failed, 1 suite\(s\) failed to collect/);
    });

    it('failedSuites > 0 is killed even when total is driven to 0 (the "single file will not collect" case)', () => {
      const deps = fakeDeps({ runTests: () => ({ failed: 0, total: 0, failedSuites: 1 }) });
      const r = runOne(entry({ expect: 'killed' }), deps, applyAt);
      expect(r.status).toBe(STATUS.KILLED); // not the "0 tests ran" ERROR path
      expect(r.matches).toBe(true);
    });

    it('a genuinely empty result (0 failed, 0 total, 0 failed suites) is ERROR, not survives', () => {
      const deps = fakeDeps({ runTests: () => ({ failed: 0, total: 0, failedSuites: 0 }) });
      const r = runOne(entry(), deps, applyAt);
      expect(r.status).toBe(STATUS.ERROR);
      expect(r.detail).toMatch(/0 tests ran for f\.test\.ts/);
    });

    it('failedSuites > 0 alongside a real failed > 0 does NOT claim "failed to collect" -- measured directly (see the real end-to-end case below): a file with several describe blocks and ONE real failing test also moves failedSuites, and that is not a collection failure', () => {
      const deps = fakeDeps({ runTests: () => ({ failed: 4, total: 19, failedSuites: 4 }) });
      const r = runOne(entry({ expect: 'killed' }), deps, applyAt);
      expect(r.status).toBe(STATUS.KILLED);
      expect(r.detail).toBe('4 of 19 test(s) failed'); // no suite-collection claim at all
      expect(r.detail).not.toMatch(/failed to collect/);
    });
  });

  describe('interruption (SIGINT/SIGTERM arriving mid-entry) is reported, not thrown as fatal', () => {
    // The error itself carries `.interrupted = true`, set by run.mjs's runTestsReal
    // from the killed subprocess's own res.signal -- NOT inferred from deps.shouldStop()
    // at catch time. That distinction is load-bearing, not stylistic: shouldStop() is
    // driven by a SIGINT/SIGTERM handler, and Node dispatches that handler's callback
    // on the NEXT event-loop tick, not synchronously with a blocking spawnSync call
    // unblocking -- so a real run was measured landing in the catch block with
    // shouldStop() still returning false at that exact instant, even though a signal
    // was unambiguously why runTests threw. Checking the error's own flag has no such
    // race: it is set at the moment the subprocess result is inspected, using that
    // subprocess's own res.signal, before control ever returns to caller code that
    // might race a separately-scheduled callback.
    function interruptedError(message: string) {
      const err = new Error(message);
      (err as Error & { interrupted: boolean }).interrupted = true;
      return err;
    }

    it('interrupted during the baseline check returns INTERRUPTED -- nothing was ever mutated', () => {
      const deps = fakeDeps({ baselineThrow: interruptedError('vitest killed by signal') });
      const r = runOne(entry(), deps, applyAt);
      expect(r.status).toBe(STATUS.INTERRUPTED);
      expect(r.matches).toBe(false);
      expect(r.detail).toMatch(/nothing was mutated/);
      expect(deps.applyToDisk).not.toHaveBeenCalled();
      expect(deps.restoreToDisk).not.toHaveBeenCalled(); // nothing to restore
    });

    it('interrupted mid-mutation returns INTERRUPTED and still restores -- this is the fix for the "signal reached the child, runTestsReal threw, run ended FATAL" bug', () => {
      const deps = fakeDeps({
        runTests: () => { throw interruptedError('vitest killed by signal'); },
      });
      const r = runOne(entry(), deps, applyAt); // must NOT throw
      expect(r.status).toBe(STATUS.INTERRUPTED);
      expect(r.matches).toBe(false);
      expect(deps.restoreToDisk).toHaveBeenCalledTimes(1);
      expect(deps.files.get('f.ts')).toBe('const X = 1;'); // genuinely restored
    });

    it('a runTests throw WITHOUT .interrupted set is still a real, unexplained failure and still aborts -- even if shouldStop() happens to be true', () => {
      const deps = fakeDeps({
        runTests: () => { throw new Error('vitest crashed for an unrelated reason'); }, // no .interrupted
        extraDeps: { shouldStop: () => true }, // deliberately true, to prove it is NOT consulted here
      });
      expect(() => runOne(entry(), deps, applyAt)).toThrow('vitest crashed for an unrelated reason');
      expect(deps.restoreToDisk).toHaveBeenCalledTimes(1); // still restored
    });
  });
});

describe('runManifest', () => {
  it('streams one onResult call per entry, in order', () => {
    const deps = fakeDeps({ runTests: () => ({ failed: 0, total: 1 }) });
    const entries = [entry({ id: 'a', expect: 'survives' }), entry({ id: 'b', expect: 'survives' })];
    runManifest(entries, deps, applyAt);
    expect(deps.onResult).toHaveBeenCalledTimes(2);
    expect(deps.onResult.mock.calls[0][0].id).toBe('a');
    expect(deps.onResult.mock.calls[0][1]).toBe(1);
    expect(deps.onResult.mock.calls[1][0].id).toBe('b');
    expect(deps.onResult.mock.calls[1][1]).toBe(2);
  });

  it('runs one baseline for an exact repeated test scope, then one mutated run per entry', () => {
    const deps = fakeDeps();
    deps.runTests.mockImplementation(() => (
      deps.files.get('f.ts') === 'const X = 1;'
        ? { failed: 0, total: 3, failedSuites: 0 }
        : { failed: 1, total: 3, failedSuites: 1 }
    ));
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];

    const results = runManifest(entries, deps, applyAt);

    expect(results.map((result) => result.status)).toEqual([STATUS.KILLED, STATUS.KILLED]);
    expect(deps.runTests).toHaveBeenCalledTimes(3); // baseline once + two mutants
    expect(deps.runTests.mock.calls.map(([tests]) => tests)).toEqual([
      ['f.test.ts'],
      ['f.test.ts'],
      ['f.test.ts'],
    ]);
  });

  it('does not combine different or differently ordered test scopes', () => {
    const deps = fakeDeps();
    deps.runTests.mockImplementation(() => (
      deps.files.get('f.ts') === 'const X = 1;'
        ? { failed: 0, total: 3, failedSuites: 0 }
        : { failed: 1, total: 3, failedSuites: 1 }
    ));
    const entries = [
      entry({ id: 'a', tests: ['a.test.ts', 'b.test.ts'] }),
      entry({ id: 'b', tests: ['b.test.ts', 'a.test.ts'] }),
    ];

    runManifest(entries, deps, applyAt);

    expect(deps.runTests).toHaveBeenCalledTimes(4); // two distinct baselines + two mutants
  });

  it('reuses a red or empty baseline result too, without ever applying those mutations', () => {
    const redDeps = fakeDeps();
    redDeps.runTests.mockReturnValue({ failed: 1, total: 3, failedSuites: 1 });
    const redResults = runManifest([entry({ id: 'a' }), entry({ id: 'b' })], redDeps, applyAt);
    expect(redResults.map((result) => result.status)).toEqual([STATUS.BASELINE_RED, STATUS.BASELINE_RED]);
    expect(redDeps.runTests).toHaveBeenCalledTimes(1);
    expect(redDeps.applyToDisk).not.toHaveBeenCalled();

    const emptyDeps = fakeDeps();
    emptyDeps.runTests.mockReturnValue({ failed: 0, total: 0, failedSuites: 0 });
    const emptyResults = runManifest([entry({ id: 'a' }), entry({ id: 'b' })], emptyDeps, applyAt);
    expect(emptyResults.map((result) => result.status)).toEqual([STATUS.ERROR, STATUS.ERROR]);
    expect(emptyDeps.runTests).toHaveBeenCalledTimes(1);
    expect(emptyDeps.applyToDisk).not.toHaveBeenCalled();
  });

  it('keeps the baseline cache local to one invocation', () => {
    const deps = fakeDeps();
    deps.runTests.mockImplementation(() => (
      deps.files.get('f.ts') === 'const X = 1;'
        ? { failed: 0, total: 1 }
        : { failed: 1, total: 1 }
    ));

    runManifest([entry()], deps, applyAt);
    runManifest([entry()], deps, applyAt);

    expect(deps.runTests).toHaveBeenCalledTimes(4); // each invocation owns a fresh baseline
  });

  it('stops immediately after a failed restore, without running later entries', () => {
    const deps = fakeDeps({ corruptRestore: true });
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
    expect(() => runManifest(entries, deps, applyAt)).toThrow(/RESTORE FAILED/);
    // Only entry 'a' ran; 'b' must never have been attempted on a tree already
    // known to be in a bad state. readFile is called twice for 'a' -- once for
    // the original bytes, once to read back the (failed) restore -- and zero
    // times for 'b'.
    expect(deps.onResult).toHaveBeenCalledTimes(1);
    expect(deps.readFile).toHaveBeenCalledTimes(2);
  });

  // There is deliberately no "shouldStop, checked between entries" test here anymore.
  // An earlier draft had a `deps.shouldStop()` poll at the top of the loop and a test
  // for it -- removed together, on evidence: `runManifest` is fully synchronous, so a
  // signal handler's flag can never actually flip before a whole run either finishes
  // or the in-flight child dies (see orchestrate.mjs's file-level comment and
  // run.mjs's installSignalHandlers). The test below is the mechanism that DOES work,
  // proven live in run.mjs's real SIGINT trials.
  it('an INTERRUPTED result stops the loop WITHOUT throwing -- distinct from a RestoreFailedError, which does throw', () => {
    const deps = fakeDeps({
      runTests: () => {
        const err = new Error('vitest killed by signal');
        (err as Error & { interrupted: boolean }).interrupted = true;
        throw err;
      },
    });
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
    const results = runManifest(entries, deps, applyAt); // must NOT throw
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe(STATUS.INTERRUPTED);
    expect(deps.onResult).toHaveBeenCalledTimes(1); // 'b' never attempted
  });
});

describe('computeExitCode', () => {
  it('is 0 when every result matches its declared outcome', () => {
    expect(computeExitCode([{ matches: true }, { matches: true }])).toBe(0);
  });

  it('is non-zero when ANY result does not match -- this is what makes a stale PR-body count fail the tool', () => {
    expect(computeExitCode([{ matches: true }, { matches: false }])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// run.mjs's own pure pieces: CLI args, result formatting, the dirty-check message
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to the shipped manifest, no --only filter, and root = process.cwd()', () => {
    expect(parseArgs([])).toEqual({ manifest: 'tools/mutate/manifest.json', only: null, root: process.cwd(), jobs: 1, report: null });
  });

  it('accepts --manifest, --only and --root overrides', () => {
    expect(parseArgs(['--manifest', 'x.json', '--only', 'my-id', '--root', '/elsewhere', '--jobs', '3', '--report', 'out.json']))
      .toEqual({ manifest: 'x.json', only: 'my-id', root: '/elsewhere', jobs: 3, report: 'out.json' });
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
    // A value-taking flag with no value, or followed by another flag, is refused by name
    // instead of leaving `undefined` to fail later somewhere that cannot say which flag.
    for (const flag of ['--manifest', '--only', '--root', '--jobs', '--report']) {
      expect(() => parseArgs([flag]), flag).toThrow(new RegExp(`${flag} needs a value`));
      expect(() => parseArgs([flag, '--jobs', '2']), `${flag} before another flag`).toThrow(/needs a value/);
    }
    expect(parseArgs(['--report', 'out.json', '--jobs', '2']).report, 'a real value still parses').toBe('out.json');
  });
});

describe('resolveManifestPath', () => {
  const root = '/repo/';

  it('joins a relative --manifest under ROOT', () => {
    expect(resolveManifestPath(root, 'tools/mutate/manifest.json')).toBe('/repo/tools/mutate/manifest.json');
  });

  it('uses an absolute --manifest AS GIVEN, not joined under ROOT -- join() would silently concatenate it instead of jumping to filesystem root', () => {
    expect(resolveManifestPath(root, '/tmp/scratch-manifest.json')).toBe('/tmp/scratch-manifest.json');
    // The bug this guards: path.join('/repo/', '/tmp/x.json') is '/repo/tmp/x.json',
    // NOT '/tmp/x.json' -- join has no special case for an absolute later segment
    // the way path.resolve does.
    expect(join(root, '/tmp/scratch-manifest.json')).not.toBe('/tmp/scratch-manifest.json');
  });
});

describe('dirtyReport', () => {
  it('is null (no refusal) for a clean porcelain output', () => {
    expect(dirtyReport('')).toBeNull();
    expect(dirtyReport('\n  \n')).toBeNull();
  });

  it('names the dirty files when porcelain output is non-empty', () => {
    const report = dirtyReport(' M src/render/skins.ts\n?? scratch.txt\n');
    expect(report).toMatch(/refusing to start/);
    expect(report).toMatch(/skins\.ts/);
    expect(report).toMatch(/scratch\.txt/);
  });
});

describe('findUnreachableEntries + unreachableReport (the scoped-tests-must-reach-the-file guard)', () => {
  const graph = new Map([
    ['src/render/skins.ts', new Set(['src/render/skins.test.ts', 'src/game/hud.test.ts'])],
    ['src/render/framing.ts', new Set(['src/render/framing.test.ts'])],
  ]);
  const relatedFilesFor = (file: string) => graph.get(file) ?? new Set();

  it('reports no problems when every entry\'s tests intersect the related set', () => {
    const entries = [
      entry({ id: 'a', file: 'src/render/skins.ts', tests: ['src/render/skins.test.ts'] }),
      entry({ id: 'b', file: 'src/render/framing.ts', tests: ['src/render/framing.test.ts'] }),
    ];
    expect(findUnreachableEntries(entries, relatedFilesFor)).toEqual([]);
  });

  it('flags an entry scoped to a test file that vitest\'s own graph says is unrelated to the mutated file -- this is the exact case a survives-because-not-measured mutation exploits', () => {
    const entries = [
      entry({ id: 'wrong-scope', file: 'src/render/skins.ts', tests: ['src/render/framing.test.ts'] }),
    ];
    const problems = findUnreachableEntries(entries, relatedFilesFor);
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe('wrong-scope');
    expect(problems[0].related).toEqual(expect.arrayContaining(['src/render/skins.test.ts', 'src/game/hud.test.ts']));
  });

  it('unreachableReport is null for no problems, and names the entry + the real related set otherwise', () => {
    expect(unreachableReport([])).toBeNull();
    const report = unreachableReport(findUnreachableEntries(
      [entry({ id: 'wrong-scope', file: 'src/render/skins.ts', tests: ['src/render/framing.test.ts'] })],
      relatedFilesFor,
    ));
    expect(report).toMatch(/refusing to start/);
    expect(report).toMatch(/wrong-scope/);
    expect(report).toMatch(/src\/render\/skins\.test\.ts/); // tells the author what WOULD have worked
  });

  it('a file nothing tests at all is reported with an explicit "nothing tests this file" note, not an empty list that reads as a bug', () => {
    const report = unreachableReport(findUnreachableEntries(
      [entry({ id: 'orphan', file: 'src/orphan.ts', tests: ['src/somewhere.test.ts'] })],
      () => new Set(),
    ));
    expect(report).toMatch(/none -- nothing tests this file at all/);
  });

  it('propagates (does not swallow) a related-files lookup that throws -- run.mjs relies on this to distinguish "interrupted mid-probe" from "genuinely found nothing"', () => {
    const throwing = () => { throw new Error('vitest related was interrupted (signal SIGINT)'); };
    expect(() => findUnreachableEntries([entry({ file: 'x.ts', tests: ['x.test.ts'] })], throwing))
      .toThrow('interrupted');
  });
});

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

describe('classifySubprocessFailure (review found this exact gap: a missing report was always read as "found nothing")', () => {
  // The three cases review proved produce the identical false claim with the OLD
  // code: a stub that exits 1 with stderr, a deleted/missing binary (spawnSync sets
  // res.error), and -- proven separately, see the real end-to-end case below -- a
  // genuinely empty but SUCCESSFUL probe, which is the ONLY one of the three that
  // should ever be read as "nothing related". All three must be distinguishable from
  // each other, not just from success.

  it('a stub that exits 1 (no signal, no spawn error) is indeterminate, NOT zero coverage', () => {
    const v = classifySubprocessFailure({ status: 1, signal: null, error: undefined });
    expect(v.reason).toBe('indeterminate');
    expect(v.detail).toMatch(/exited 1/);
  });

  it('a missing/undeletable binary (spawnSync sets res.error, res.status stays null) is indeterminate', () => {
    const v = classifySubprocessFailure({ status: null, signal: null, error: new Error('spawn ENOENT') });
    expect(v.reason).toBe('indeterminate');
    expect(v.detail).toMatch(/could not launch subprocess: spawn ENOENT/);
  });

  it('a real SIGINT/SIGTERM (res.signal set) is interrupted, not indeterminate', () => {
    const v = classifySubprocessFailure({ status: null, signal: 'SIGINT', error: undefined });
    expect(v.reason).toBe('interrupted');
    expect(v.detail).toMatch(/signal SIGINT/);
  });

  it('vitest handling SIGINT itself -- status 130, signal null -- is ALSO interrupted, not indeterminate: this is the exact miss review measured (9 of 12 live SIGINT trials misread this shape as FATAL)', () => {
    const v = classifySubprocessFailure({ status: 130, signal: null, error: undefined });
    expect(v.reason).toBe('interrupted');
  });

  it('our OWN timeout kill (signal === the configured killSignal, SIGKILL) is a DISTINCT "timeout" reason, not folded into "interrupted"', () => {
    const v = classifySubprocessFailure({ status: null, signal: 'SIGKILL', error: undefined });
    expect(v.reason).toBe('timeout');
  });

  it('all four failure shapes are pairwise distinguishable', () => {
    const shapes = [
      { status: 1, signal: null, error: undefined },
      { status: null, signal: null, error: new Error('spawn ENOENT') },
      { status: null, signal: 'SIGINT', error: undefined },
      { status: null, signal: 'SIGKILL', error: undefined },
    ];
    const reasons = shapes.map((s) => classifySubprocessFailure(s).reason);
    expect(reasons).toEqual(['indeterminate', 'indeterminate', 'interrupted', 'timeout']);
    // The two 'indeterminate' cases still carry different `detail` text, so they are
    // not silently merged into one message either.
    const details = shapes.filter((_, i) => reasons[i] === 'indeterminate').map((s) => classifySubprocessFailure(s).detail);
    expect(details[0]).not.toBe(details[1]);
  });
});

describe('formatResult', () => {
  const e = { expect: 'killed', equivalent: false };

  it('reports FAILED-TO-APPLY / ERROR without a match/mismatch tag -- they never carry a declared outcome', () => {
    const line = formatResult({ id: 'x', status: STATUS.FAILED_TO_APPLY, matches: false, detail: 'find string not present' }, 1, 1, e);
    expect(line).toMatch(/FAILED-TO-APPLY/);
    expect(line).toMatch(/find string not present/);
    expect(line).not.toMatch(/matches declared|MISMATCH/);
  });

  it('marks a match as "matches declared outcome"', () => {
    const line = formatResult({ id: 'x', status: STATUS.KILLED, matches: true, detail: '2 of 5 test(s) failed' }, 1, 1, e);
    expect(line).toMatch(/matches declared outcome/);
  });

  it('marks an outcome mismatch, naming what the manifest declared', () => {
    const line = formatResult({ id: 'x', status: STATUS.SURVIVES, matches: false, detail: '0 of 5 test(s) failed' }, 1, 1, e);
    expect(line).toMatch(/MISMATCH: manifest declared "killed"/);
  });

  it('marks a COUNT mismatch distinctly from an outcome mismatch -- same status, wrong expectFailures', () => {
    const line = formatResult(
      { id: 'x', status: STATUS.KILLED, matches: false, failed: 5, detail: '5 of 13 test(s) failed' },
      1, 1, { ...e, expect: 'killed', expectFailures: 4 },
    );
    expect(line).toMatch(/MISMATCH: manifest declared 4 failure\(s\), got 5/);
    expect(line).not.toMatch(/manifest declared "killed"/); // outcome itself was right
  });

  it('tags an equivalent-mutant survive distinctly from a plain survive', () => {
    const result = { id: 'x', status: STATUS.SURVIVES, matches: true, detail: '0 of 5 test(s) failed' };
    expect(formatResult(result, 1, 1, { ...e, equivalent: true })).toMatch(/\[equivalent mutant\]/);
    expect(formatResult(result, 1, 1, { ...e, equivalent: false })).not.toMatch(/\[equivalent mutant\]/);
  });

  it('reports BASELINE-RED and INTERRUPTED the same way as FAILED-TO-APPLY/ERROR -- no declared-outcome tag', () => {
    const baselineRed = formatResult({ id: 'x', status: STATUS.BASELINE_RED, matches: false, detail: 'baseline is red before any mutation: 1 of 14 failing' }, 1, 1, e);
    expect(baselineRed).toMatch(/BASELINE-RED/);
    expect(baselineRed).not.toMatch(/matches declared|MISMATCH/);

    const interrupted = formatResult({ id: 'x', status: STATUS.INTERRUPTED, matches: false, detail: 'interrupted mid-mutation; the file was restored' }, 1, 1, e);
    expect(interrupted).toMatch(/INTERRUPTED/);
    expect(interrupted).not.toMatch(/matches declared|MISMATCH/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real fs + a real vitest subprocess (run.mjs's own runTestsReal),
// against a throwaway fixture created and destroyed within this one test.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// End-to-end: relatedFilesForAll against REAL broken subprocesses -- this preserves
// the exact failure boundary review found live while replacing many cold Vitest
// processes with one worker. A failed worker must never fall through to an empty map
// and claim "nothing tests this file at all." Reproduced with real stub executables,
// not fakes, to prove the actual spawnSync/existsSync wiring and not just the pure
// classifier tested above.
// ---------------------------------------------------------------------------

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

// The worktree pool's pure pieces (issue #502): how `--jobs` is read, how entries are
// dealt to workers, and how the workers' exit codes fold into one.
describe('parseJobs', () => {
  it('reads a positive integer and "auto" (one core kept back), and refuses anything else', () => {
    expect(parseJobs('3')).toBe(3);
    expect(parseJobs('auto', 4)).toBe(3);
    expect(parseJobs('auto', 1), 'auto on one core is still one worker').toBe(1);
    for (const bad of ['0', '-1', '2.5', 'many', undefined]) {
      expect(() => parseJobs(bad), String(bad)).toThrow(/--jobs must be/);
    }
  });
});

describe('partitionByScope', () => {
  const entry = (id: string, ...tests: string[]): { id: string; tests: string[] } => ({ id, tests });
  const hud = ['a.test.ts'];
  const loop = ['b.test.ts'];
  const both = ['a.test.ts', 'b.test.ts'];
  const entries = [
    entry('h1', ...hud), entry('l1', ...loop), entry('h2', ...hud), entry('x1', ...both),
    entry('h3', ...hud), entry('l2', ...loop), entry('h4', ...hud),
  ];

  it('deals every entry exactly once and never splits an exact scope across workers', () => {
    const slices = partitionByScope(entries, 3);
    const ids = slices.flat().map((e) => e.id).sort();
    expect(ids).toEqual(entries.map((e) => e.id).sort());
    for (const slice of slices) {
      // A scope's entries all sit in ONE slice: no other slice carries that scope.
      for (const e of slice) {
        const elsewhere = slices.filter((other) => other !== slice && other.some((o) => JSON.stringify(o.tests) === JSON.stringify(e.tests)));
        expect(elsewhere, `${e.id}'s scope was split`).toHaveLength(0);
      }
    }
  });

  it('balances by entry count, largest scope first onto the lightest worker, and keeps manifest order within a worker', () => {
    const slices = partitionByScope(entries, 2);
    // hud (4) goes first to worker 1; loop (2) and both (1) then fill worker 2.
    expect(slices.map((s) => s.map((e) => e.id))).toEqual([['h1', 'h2', 'h3', 'h4'], ['l1', 'x1', 'l2']]);
  });

  it('balances by COST when a cost is supplied: one expensive scope outweighs several cheap ones (issue #507)', () => {
    // hud-like: 4 entries at 12 s = 48 s; the other three scopes total 3 entries at 2 s
    // each. By count the 4-entry scope shares a worker with nothing and the rest split
    // 2/1; by cost the same happens here, so the discriminating case is a cheap scope
    // with MORE entries than an expensive one, below.
    const cost = (tests: readonly string[]) => (tests.join() === hud.join() ? 12 : 2);
    const heavyFew = [entry('h1', ...hud), entry('h2', ...hud)]; // 2 x 12 = 24 s
    const cheapMany = [entry('l1', ...loop), entry('l2', ...loop), entry('l3', ...loop), entry('l4', ...loop)]; // 4 x 2 = 8 s
    const mid = [entry('x1', ...both), entry('x2', ...both), entry('x3', ...both)]; // 3 x 2 = 6 s
    const byCost = partitionByScope([...heavyFew, ...cheapMany, ...mid], 2, cost);
    expect(byCost.map((s) => s.map((e) => e.id))).toEqual([['h1', 'h2'], ['l1', 'l2', 'l3', 'l4', 'x1', 'x2', 'x3']]);
    // Negative control: with no cost the count balance puts the 4-entry scope alone.
    const byCount = partitionByScope([...heavyFew, ...cheapMany, ...mid], 2);
    expect(byCount.map((s) => s.map((e) => e.id))).toEqual([['l1', 'l2', 'l3', 'l4'], ['h1', 'h2', 'x1', 'x2', 'x3']]);
  });

  it('drops empty workers when there are fewer scopes than jobs, and --jobs 1 is one slice in manifest order', () => {
    expect(partitionByScope(entries, 8)).toHaveLength(3);
    expect(partitionByScope(entries, 1).map((s) => s.map((e) => e.id))).toEqual([entries.map((e) => e.id)]);
    expect(partitionByScope([], 3)).toEqual([]);
  });
});

describe('aggregateExitCodes', () => {
  it('folds worker exit codes worst-first: restore failure, interruption, mid-run error, refusal, mismatch, clean', () => {
    expect(aggregateExitCodes([0, 0, 0])).toBe(0);
    expect(aggregateExitCodes([0, 1, 0])).toBe(1);
    expect(aggregateExitCodes([1, 2])).toBe(2);
    expect(aggregateExitCodes([2, 4, 1])).toBe(4);
    expect(aggregateExitCodes([4, 130])).toBe(130);
    expect(aggregateExitCodes([130, 3, 1]), 'a mutated worktree outranks everything').toBe(3);
  });

  it('a worker that died without a code, or with an unknown one, is a mid-run error -- never a pass', () => {
    expect(aggregateExitCodes([0, null])).toBe(4);
    expect(aggregateExitCodes([0, 137])).toBe(4);
    expect(aggregateExitCodes([]), 'no workers is clean -- the negative control').toBe(0);
  });
});

// `killedBy` (issue #504): the validation rules, the pure report reader, and the verdict
// through fake deps, so the contract is pinned without spawning vitest.
describe('killedBy: manifest validation', () => {
  const base = { id: 'x', file: 'a.ts', find: 'a', replace: 'b', why: 'w', tests: ['a.test.ts'] };
  it('accepts killedBy on a killed entry, beside the count form and the outcome-only form fixtures use', () => {
    expect(() => validateEntry({ ...base, expect: 'killed', killedBy: ['suite case'] }, 0)).not.toThrow();
    expect(() => validateEntry({ ...base, expect: 'killed', expectFailures: 2 }, 0)).not.toThrow();
    expect(() => validateEntry({ ...base, expect: 'killed' }, 0)).not.toThrow();
  });
  it('refuses an empty or non-string list, a survivor with a killer, and both contracts at once', () => {
    expect(() => validateEntry({ ...base, expect: 'killed', killedBy: [] }, 0)).toThrow(/non-empty array/);
    expect(() => validateEntry({ ...base, expect: 'killed', killedBy: [1] }, 0)).toThrow(/non-empty array/);
    expect(() => validateEntry({ ...base, expect: 'survives', expectFailures: 0, killedBy: ['suite case'] }, 0)).toThrow(/cannot name/);
    expect(() => validateEntry({ ...base, expect: 'killed', expectFailures: 1, killedBy: ['suite case'] }, 0)).toThrow(/alternatives/);
  });
});

describe('failedTestNames', () => {
  it('lists the full names of failed assertions in report order and nothing else', () => {
    const report = {
      testResults: [
        { assertionResults: [{ fullName: 'a one', status: 'failed' }, { fullName: 'a two', status: 'passed' }] },
        { assertionResults: [{ fullName: 'b three', status: 'failed' }, { fullName: 'b four', status: 'skipped' }] },
      ],
    };
    expect(failedTestNames(report)).toEqual(['a one', 'b three']);
    expect(failedTestNames({}), 'a report that never collected names nothing').toEqual([]);
    expect(failedTestNames({ testResults: [{}] })).toEqual([]);
  });
});

describe('killedBy: the verdict through fake deps', () => {
  const entry = {
    id: 'k', file: 'src/x.ts', find: 'A', replace: 'B', why: 'w', expect: 'killed' as const, tests: ['src/x.test.ts'],
    killedBy: ['x suite the guard holds'],
  };
  const depsWith = (mutated: { failed: number; total: number; failedTests: string[] }) => ({
    readFile: () => 'A',
    gitPorcelain: () => '',
    applyToDisk: () => {},
    restoreToDisk: () => {},
    runTests: vi.fn()
      .mockReturnValueOnce({ failed: 0, total: 3, failedTests: [] }) // baseline
      .mockReturnValueOnce(mutated),
    onResult: () => {},
  });
  it('matches when the named test fails, however many others fail too -- a new test in the file cannot break the pin', () => {
    const r = runOne(entry, depsWith({ failed: 3, total: 5, failedTests: ['x suite the guard holds', 'x suite newer case', 'x suite another'] }), applyAt);
    expect(r.status).toBe(STATUS.KILLED);
    expect(r.matches).toBe(true);
    expect(r.missingKilledBy).toEqual([]);
  });
  it('mismatches, naming the test, when the named test passed while others failed -- the rot case; the count-only entry is the negative control', () => {
    const r = runOne(entry, depsWith({ failed: 2, total: 5, failedTests: ['x suite newer case', 'x suite another'] }), applyAt);
    expect(r.status, 'still KILLED by the others').toBe(STATUS.KILLED);
    expect(r.matches).toBe(false);
    expect(r.missingKilledBy).toEqual(['x suite the guard holds']);
    const counted = runOne({ ...entry, killedBy: undefined, expectFailures: 2 }, depsWith({ failed: 2, total: 5, failedTests: ['x suite newer case', 'x suite another'] }), applyAt);
    expect(counted.matches, 'an exact count cannot see which test failed').toBe(true);
  });
});

describe('the shipped manifest pins every killed entry by name or by count (issue #504)', () => {
  it('has no outcome-only killed entry -- the harness allows the form, the repository does not', () => {
    const manifest: ManifestEntry[] = JSON.parse(readFileSync(join(ROOT, 'tools/mutate/manifest.json'), 'utf8'));
    const outcomeOnly = manifest.filter((e) => e.expect === 'killed' && e.expectFailures === undefined && e.killedBy === undefined).map((e) => e.id);
    expect(outcomeOnly, 'killed entries pinning neither killedBy nor expectFailures').toEqual([]);
    const byName = manifest.filter((e) => e.killedBy !== undefined).length;
    const byCount = manifest.filter((e) => e.expect === 'killed' && e.expectFailures !== undefined).length;
    expect(byName + byCount, 'the population this rule covers').toBe(manifest.filter((e) => e.expect === 'killed').length);
  });
});

describe('scope costs (issue #507)', () => {
  it('scopeCostLookup returns the measured seconds for a known scope and the median of the known ones otherwise', () => {
    const lookup = scopeCostLookup({ '["a.test.ts"]': 12, '["b.test.ts"]': 2, '["c.test.ts"]': 4 });
    expect(lookup(['a.test.ts'])).toBe(12);
    expect(lookup(['zzz.test.ts']), 'an unknown scope gets the median, 4').toBe(4);
    expect(scopeCostLookup({})(['a.test.ts']), 'no measurements at all: every scope costs 1, the count balance').toBe(1);
    expect(scopeCostLookup({ '["a.test.ts"]': 0, '["b.test.ts"]': -3 })(['a.test.ts']), 'non-positive samples are ignored').toBe(1);
  });

  it('scopeCosts takes the median seconds per scope from report entries and ignores entries without a time', () => {
    const manifest = [
      { id: 'h1', tests: ['a.test.ts'] }, { id: 'h2', tests: ['a.test.ts'] }, { id: 'h3', tests: ['a.test.ts'] },
      { id: 'l1', tests: ['b.test.ts'] }, { id: 'u1', tests: ['c.test.ts'] },
    ];
    const report = [
      { id: 'h1', seconds: 10 }, { id: 'h2', seconds: 30 }, { id: 'h3', seconds: 12 },
      { id: 'l1', seconds: 2.04 }, { id: 'u1', seconds: null }, { id: 'ghost', seconds: 99 },
    ];
    expect(scopeCosts(report, manifest)).toEqual({ '["a.test.ts"]': 12, '["b.test.ts"]': 2 });
  });
});
