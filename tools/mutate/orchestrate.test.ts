/**
 * The harness's own tests. Three layers, on purpose:
 *
 * - lib.mjs and orchestrate.mjs, exercised with FAKE deps (in-memory strings, no real
 *   fs/git/vitest). Fast, and what makes edge cases like "ambiguous find" or "restore
 *   verification fails" cheap to hit deliberately.
 * - run.mjs's own pure pieces (parseArgs, formatResult, dirtyReport), unit tested
 *   directly against strings -- no subprocess needed for CLI-argument or
 *   message-formatting logic.
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
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findOccurrences, applyAt, validateEntry, validateManifest, findUnreachableEntries } from './lib.mjs';
import { runOne, runManifest, computeExitCode, STATUS, RestoreFailedError } from './orchestrate.mjs';
import { parseArgs, formatResult, dirtyReport, unreachableReport, resolveManifestPath, runTestsReal } from './run.mjs';

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
    expect(r.content).toBe('sounds[key] = null;\nx();\nsounds[key] = undefined;');
  });

  it('rejects an occurrence index out of range', () => {
    const r = applyAt('a-b', 'a', 'z', 5);
    expect(r).toEqual({ ok: false, reason: 'bad-occurrence', count: 1 });
  });
});

describe('validateEntry', () => {
  const base = () => ({
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
 * `runTests` is now called (at least) TWICE per entry that gets far enough to run
 * it -- once for the pre-mutation baseline, once after the mutation is applied -- so
 * the fake distinguishes them by call order rather than assuming one shared shape:
 *   - `overrides.baseline`: the FIRST call's result (default: a healthy 3-test run).
 *   - `overrides.baselineThrow`: an Error to throw on the first call instead.
 *   - `overrides.runTests`: the function used for every call AFTER the first (the
 *     post-mutation check) -- this is what most existing tests already set, and
 *     keeping it as "the post-mutation result" is what lets them stay unchanged.
 */
function fakeDeps(overrides = {}) {
  const files = new Map(overrides.initialFiles ?? [['f.ts', 'const X = 1;']]);
  const calls = { readFile: 0, applyToDisk: 0, restoreToDisk: 0, runTests: 0 };
  const post = overrides.runTests ?? (() => ({ failed: 1, total: 3, failedSuites: 0 }));
  let runTestsCalls = 0;
  return {
    calls,
    files,
    readFile: vi.fn((file) => {
      calls.readFile++;
      return files.get(file);
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

const entry = (over = {}) => ({
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

  it('shouldStop, checked between entries, halts before any of them starts', () => {
    const deps = fakeDeps({ extraDeps: { shouldStop: () => true } });
    const entries = [entry({ id: 'a' }), entry({ id: 'b' })];
    const results = runManifest(entries, deps, applyAt);
    expect(results).toEqual([]);
    expect(deps.onResult).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

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
  it('defaults to the shipped manifest and no --only filter', () => {
    expect(parseArgs([])).toEqual({ manifest: 'tools/mutate/manifest.json', only: null });
  });

  it('accepts --manifest and --only overrides', () => {
    expect(parseArgs(['--manifest', 'x.json', '--only', 'my-id'])).toEqual({ manifest: 'x.json', only: 'my-id' });
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
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

  it('propagates (does not swallow) a relatedFilesFor that throws -- run.mjs relies on this to distinguish "interrupted mid-probe" from "genuinely found nothing", see relatedFilesFor\'s signal check', () => {
    const throwing = () => { throw new Error('vitest related was interrupted (signal SIGINT)'); };
    expect(() => findUnreachableEntries([entry({ file: 'x.ts', tests: ['x.test.ts'] })], throwing))
      .toThrow('interrupted');
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
      expect(readFileSync(abs, 'utf8')).toBe(source); // independent re-read, byte-exact
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
