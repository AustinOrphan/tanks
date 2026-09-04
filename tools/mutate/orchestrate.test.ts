import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOccurrences, applyAt, validateEntry, validateManifest, findUnreachableEntries, mergeManifestFiles } from './lib.mjs';
import { runOne, runManifest, computeExitCode, STATUS, RestoreFailedError } from './orchestrate.mjs';
import { parseArgs, parseJobs, partitionByScope, scopeCostLookup, readScopeCosts, aggregateExitCodes, formatResult, formatRunSummary, formatSelectionEcho, selectOnly, missingOnlyReport, dirtyReport, unreachableReport, resolveManifestPath, classifySubprocessFailure, failedTestNames, readManifestFiles, readManifest } from './run.mjs';
import { scopeCosts } from './scope-costs.mjs';
import { selectAffected, entryText } from './select.mjs';
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

  it('the shipped manifests directory is itself well-formed, one file per area (issue #505)', async () => {
    const files = readManifestFiles(join(ROOT, 'tools/mutate/manifests'));
    expect(files.map((f) => f.path.split('/').pop()), 'one file per area, read in name order').toEqual(
      ['app.json', 'audio.json', 'game.json', 'input.json', 'presentation.json', 'render.json', 'sim.json', 'tools.json'],
    );
    const entries = mergeManifestFiles(files);
    expect(() => validateManifest(entries)).not.toThrow();
    // Every entry lives in the file of the area its mutated file belongs to.
    const areaOf = (file: string): string => {
      for (const [prefix, name] of [['src/sim/', 'sim'], ['src/game/', 'game'], ['src/render/', 'render'], ['src/input/', 'input'], ['src/presentation/', 'presentation'], ['src/audio/', 'audio'], ['tools/', 'tools']] as const) {
        if (file.startsWith(prefix)) return name;
      }
      return 'app';
    };
    for (const f of files) {
      for (const entry of f.entries) {
        expect(`${areaOf(entry.file)}.json`, `${entry.id} (${entry.file}) is filed under ${f.path}`).toBe(f.path.split('/').pop());
      }
    }
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

    it('interrupted mid-mutation returns INTERRUPTED and still restores -- this is the fix for the "signal reached the child threw, run ended FATAL" bug', () => {
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

describe('parseArgs', () => {
  it('defaults to the shipped manifest, no --only filter, and root = process.cwd()', () => {
    expect(parseArgs([])).toEqual({ manifest: 'tools/mutate/manifests', only: [], root: process.cwd(), jobs: 1, report: null, changed: null, list: false });
  });

  it('accepts --manifest, --only and --root overrides', () => {
    expect(parseArgs(['--manifest', 'x.json', '--only', 'my-id', '--root', '/elsewhere', '--jobs', '3', '--report', 'out.json', '--changed', 'origin/main', '--list']))
      .toEqual({ manifest: 'x.json', only: ['my-id'], root: '/elsewhere', jobs: 3, report: 'out.json', changed: 'origin/main', list: true });
  });

  it('ACCUMULATES repeated --only instead of keeping the last one (issue #529)', () => {
    // The bug verbatim: `--only a --only b --only c` parsed as `args.only = 'c'`, so two
    // of the three requested entries were silently dropped and the run reported a clean
    // sweep of the one it kept.
    expect(parseArgs(['--only', 'a', '--only', 'b', '--only', 'c']).only).toEqual(['a', 'b', 'c']);
    // Negative control for "accumulates": ONE occurrence must still yield exactly one id,
    // so a filter of [] (run everything) or a growing list across calls would both fail.
    expect(parseArgs(['--only', 'a']).only, 'one occurrence is still one id').toEqual(['a']);
    expect(parseArgs([]).only, 'no occurrence is an empty filter, not a stale one').toEqual([]);
  });

  it('splits one --only on commas, and mixes commas with repeats', () => {
    expect(parseArgs(['--only', 'a,b,c']).only).toEqual(['a', 'b', 'c']);
    expect(parseArgs(['--only', ' a , b ']).only, 'surrounding spaces are not part of an id').toEqual(['a', 'b']);
    expect(parseArgs(['--only', 'a,b', '--only', 'c']).only).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates ids, first-seen order, so the requested count is the count of DISTINCT entries', () => {
    expect(parseArgs(['--only', 'b', '--only', 'a', '--only', 'b']).only).toEqual(['b', 'a']);
    expect(parseArgs(['--only', 'a,a']).only).toEqual(['a']);
  });

  it('refuses an --only occurrence that names no id -- an empty list would mean "run everything"', () => {
    for (const empty of ['', ',', ' , ']) {
      expect(() => parseArgs(['--only', empty]), JSON.stringify(empty)).toThrow(/--only needs a value/);
    }
    // Negative control: a real id beside the separators is not refused.
    expect(parseArgs(['--only', ',a,']).only).toEqual(['a']);
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
    // A value-taking flag with no value, or followed by another flag, is refused by name
    // instead of leaving `undefined` to fail later somewhere that cannot say which flag.
    for (const flag of ['--manifest', '--only', '--root', '--jobs', '--report', '--changed']) {
      expect(() => parseArgs([flag]), flag).toThrow(new RegExp(`${flag} needs a value`));
      expect(() => parseArgs([flag, '--jobs', '2']), `${flag} before another flag`).toThrow(/needs a value/);
    }
    expect(parseArgs(['--report', 'out.json', '--jobs', '2']).report, 'a real value still parses').toBe('out.json');
  });
});

describe('the pre-run --only echo (issue #529)', () => {
  it('names how many entries will run against how many exist, and lists them', () => {
    // The line a reader checks at second zero. Its job is to make "I asked for three and
    // one is about to run" visible BEFORE a sweep that can take minutes -- so both
    // numbers and the ids have to be in it.
    const line = formatSelectionEcho([{ id: 'alpha' }, { id: 'beta' }] as never[], 478);
    expect(line).toContain('2 of 478');
    expect(line).toContain('alpha, beta');
  });

  it('still reports the total when a single entry was selected', () => {
    // The one-entry case is the common one, and the case where a bare "1 mutation(s) ran"
    // reads as success. The total is what makes it checkable.
    expect(formatSelectionEcho([{ id: 'solo' }] as never[], 478)).toContain('1 of 478');
  });
});

describe('selectOnly / missingOnlyReport', () => {
  const entries = ['alpha', 'beta', 'gamma'].map((id) => ({ id })) as unknown as ManifestEntry[];

  it('selects EVERY id asked for, not just one, and reports nothing missing', () => {
    const { entries: picked, missing } = selectOnly(entries, ['alpha', 'gamma']);
    expect(picked.map((e) => e.id)).toEqual(['alpha', 'gamma']);
    expect(missing).toEqual([]);
    // Negative control for "every": one id still selects exactly that one entry.
    expect(selectOnly(entries, ['beta']).entries.map((e) => e.id)).toEqual(['beta']);
  });

  it('keeps MANIFEST order, not the order the ids were typed -- consecutive same-scope entries share a baseline', () => {
    expect(selectOnly(entries, ['gamma', 'alpha']).entries.map((e) => e.id)).toEqual(['alpha', 'gamma']);
  });

  it('an empty id list is no filter at all -- every entry, untouched', () => {
    expect(selectOnly(entries, []).entries).toBe(entries);
  });

  it('names EVERY id that matched nothing, not just the first -- one typo must not hide a second', () => {
    const { entries: picked, missing } = selectOnly(entries, ['alpha', 'typo-one', 'typo-two']);
    expect(missing).toEqual(['typo-one', 'typo-two']);
    const report = missingOnlyReport(missing, ['alpha', 'typo-one', 'typo-two']);
    expect(report).toMatch(/typo-one/);
    expect(report).toMatch(/typo-two/);
    expect(report, 'the refusal says how many of how many were asked for').toMatch(/2 of the 3 id\(s\)/);
    // The entries that DID match are still selected -- the refusal is what stops the run,
    // and this is the negative control proving the selection is not silently emptied.
    expect(picked.map((e) => e.id)).toEqual(['alpha']);
  });

  it('is null when nothing is missing -- the negative control for the refusal above', () => {
    expect(missingOnlyReport([], ['alpha'])).toBeNull();
  });

  it('still refuses a SINGLE unmatched id, naming it -- the pre-#529 property the multi-id case must not lose', () => {
    const { missing } = selectOnly(entries, ['nope']);
    expect(missing).toEqual(['nope']);
    expect(missingOnlyReport(missing, ['nope'])).toMatch(/nope/);
  });
});

describe('formatRunSummary', () => {
  const ran = (id: string, status: string, matches = true) => ({ id, status, matches, detail: 'd' });

  it('prints the requested count BESIDE the ran/selected pair when --only was used (issue #529)', () => {
    // The line the bug produced was "1/1 mutation(s) ran ... 0 mismatch(es)" for three
    // requested ids: legible only as a clean sweep. The requested count is what makes
    // an under-run readable at all.
    const line = formatRunSummary([ran('a', STATUS.KILLED)], 1, 3);
    expect(line).toMatch(/1\/1 of 3 requested by --only mutation\(s\) ran/);
  });

  it('omits the requested clause entirely when --only was not used -- a full run has nothing to compare against', () => {
    expect(formatRunSummary([ran('a', STATUS.KILLED)], 1, 0)).toMatch(/^1\/1 mutation\(s\) ran/);
    expect(formatRunSummary([ran('a', STATUS.KILLED)], 1, 0)).not.toMatch(/requested/);
  });

  it('counts each status and the mismatches separately', () => {
    const line = formatRunSummary(
      [ran('a', STATUS.KILLED), ran('b', STATUS.SURVIVES), ran('c', STATUS.FAILED_TO_APPLY, false), ran('d', STATUS.BASELINE_RED, false), ran('e', STATUS.ERROR, false)],
      5, 0,
    );
    expect(line).toMatch(/5\/5 mutation\(s\) ran: 1 killed, 1 survives, 1 failed-to-apply, 1 baseline-red, 1 error -- 3 mismatch\(es\)/);
  });

  it('shows ran < selected when a run stopped early, rather than reporting the shortfall as a complete run', () => {
    expect(formatRunSummary([ran('a', STATUS.KILLED)], 4, 4)).toMatch(/1\/4 of 4 requested/);
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
    const manifest: ManifestEntry[] = readManifest(join(ROOT, 'tools/mutate/manifests'));
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

  it('readScopeCosts is best-effort: a missing, corrupt or non-object file warns and yields no costs, never a throw', () => {
    const dir = join(tmpdir(), `scope-costs-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const warnings: string[] = [];
      const warn = (m: string) => { warnings.push(m); };
      expect(readScopeCosts(join(dir, 'absent.json'), warn)).toEqual({});
      expect(warnings, 'an absent file is the normal fresh-checkout case and warns about nothing').toEqual([]);
      writeFileSync(join(dir, 'corrupt.json'), '{"["a.test.ts"]": 12,');
      expect(readScopeCosts(join(dir, 'corrupt.json'), warn)).toEqual({});
      writeFileSync(join(dir, 'array.json'), '[1, 2]');
      expect(readScopeCosts(join(dir, 'array.json'), warn)).toEqual({});
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/could not read .*corrupt\.json/);
      expect(warnings[1]).toMatch(/not an object of scope costs/);
      // Negative control: a well-formed file is returned as is, silently.
      writeFileSync(join(dir, 'good.json'), JSON.stringify({ '["a.test.ts"]': 12 }));
      expect(readScopeCosts(join(dir, 'good.json'), warn)).toEqual({ '["a.test.ts"]': 12 });
      expect(warnings).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('mergeManifestFiles', () => {
  const e = (id: string) => ({ id, file: 'a.ts', find: 'a', replace: 'b', why: 'w', expect: 'killed', tests: ['a.test.ts'], killedBy: ['t'] });
  it('concatenates files in the order given and keeps entry order within each', () => {
    const merged = mergeManifestFiles([{ path: 'b.json', entries: [e('b1'), e('b2')] }, { path: 'a.json', entries: [e('a1')] }]);
    expect(merged.map((x) => x.id)).toEqual(['b1', 'b2', 'a1']);
  });
  it('refuses an id present in two files, naming both -- a duplicate within ONE file is validateManifest\'s, the negative control', () => {
    expect(() => mergeManifestFiles([{ path: 'x/game.json', entries: [e('dup')] }, { path: 'x/sim.json', entries: [e('dup')] }]))
      .toThrow(/"dup" appears in both x\/game\.json and x\/sim\.json/);
    const within = [{ path: 'one.json', entries: [e('dup'), e('dup')] }];
    expect(() => mergeManifestFiles(within), 'the merge itself lets it through').not.toThrow();
    expect(() => validateManifest(mergeManifestFiles(within))).toThrow(/duplicate id/);
    expect(() => mergeManifestFiles([{ path: 'bad.json', entries: {} as unknown as never[] }])).toThrow(/must be a JSON array/);
  });
});

describe('readManifestFiles / readManifest', () => {
  it('reads every *.json in a directory sorted by name, ignores other files, and reads a single file as itself', () => {
    const dir = join(tmpdir(), `manifests-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'sim.json'), JSON.stringify([{ id: 's1' }]));
      writeFileSync(join(dir, 'app.json'), JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));
      writeFileSync(join(dir, 'notes.md'), '# not a manifest');
      writeFileSync(join(dir, 'object.json'), JSON.stringify({ id: 'not-an-array' }));
      // Named, not a TypeError from some later `.map`: every reader comes through here,
      // including migrate-killed-by.mjs, which rewrites each file and never merges.
      expect(() => readManifestFiles(dir)).toThrow(/manifest .*object\.json: must be a JSON array/);
      rmSync(join(dir, 'object.json'));
      expect(readManifestFiles(dir).map((f) => [f.path.split('/').pop(), f.entries.length])).toEqual([['app.json', 2], ['sim.json', 1]]);
      expect(readManifest(dir).map((x) => x.id)).toEqual(['a1', 'a2', 's1']);
      expect(readManifest(join(dir, 'sim.json')).map((x) => x.id), 'a single file').toEqual(['s1']);
      mkdirSync(join(dir, 'empty'));
      expect(() => readManifestFiles(join(dir, 'empty'))).toThrow(/holds no \*\.json file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('selectAffected', () => {
  const e = (id: string, file: string, tests: string[], extra: Record<string, unknown> = {}) =>
    ({ id, file, tests, find: 'a', replace: 'b', why: 'w', expect: 'killed', killedBy: ['t'], ...extra });
  const hud = e('hud-1', 'src/game/hud.ts', ['src/game/hud.test.ts']);
  const sim = e('sim-1', 'src/sim/world.ts', ['src/sim/world.test.ts']);
  const loop = e('loop-1', 'src/game/loop.ts', ['src/game/loop.test.ts']);
  const cap = e('cap-1', 'src/game/render-capability.ts', ['src/game/render-capability.test.ts'], { reads: ['package.json'] });
  const entries = [hud, sim, loop, cap];
  const base = new Map(entries.map((x) => [x.id, structuredClone(x)]));
  const run = (changed: string[], related: string[] = [], over: Partial<{ entries: typeof entries; baseById: Map<string, unknown> }> = {}) =>
    selectAffected({ entries: over.entries ?? entries, baseById: over.baseById ?? base, changed, relatedTests: new Set(related) });
  const ids = (sel: ReturnType<typeof run>) => (sel.all ? 'ALL' : sel.selected.map((s) => s.entry.id));

  it('rule 1: a changed mutated file or scoped test selects the entry, and nothing else', () => {
    expect(ids(run(['src/game/hud.ts']))).toEqual(['hud-1']);
    expect(ids(run(['src/sim/world.test.ts']))).toEqual(['sim-1']);
    expect(ids(run(['src/game/nothing-here.ts'])), 'an unrelated change selects nothing').toEqual([]);
  });

  it('rule 3: a scoped test that imports a changed module selects the entry, even when the entry names neither file', () => {
    // loop.test.ts imports hud.ts: a change to hud.ts reaches loop-1 through the graph.
    expect(ids(run(['src/game/hud.ts'], ['src/game/loop.test.ts', 'src/game/hud.test.ts']))).toEqual(['hud-1', 'loop-1']);
    const sel = run(['src/game/hud.ts'], ['src/game/loop.test.ts']);
    expect(sel.all ? [] : sel.selected.find((s) => s.entry.id === 'loop-1')?.reasons).toEqual(['scoped test src/game/loop.test.ts imports a changed module']);
  });

  it('rule 2: an entry whose text changed, or that is new, is selected; key order alone is not a change', () => {
    const edited = { ...sim, why: 'reworded' };
    expect(ids(run([], [], { entries: [hud, edited] }))).toEqual(['sim-1']);
    expect(ids(run([], [], { entries: [hud, e('brand-new', 'src/sim/mines.ts', ['src/sim/mines.test.ts'])] }))).toEqual(['brand-new']);
    const reordered = Object.fromEntries(Object.entries(sim).reverse()) as typeof sim;
    expect(entryText(reordered)).toBe(entryText(sim));
    expect(ids(run([], [], { entries: [reordered] })), 'the same entry with keys reordered').toEqual([]);
  });

  it('rule 4: a change to a file an entry declares it reads selects it; an undeclared non-module file does not', () => {
    expect(ids(run(['package-lock.json.example']))).toEqual([]);
    expect(ids(run(['src/game/render-capability.fixture.json']))).toEqual([]);
    const sel = run(['package.json'], [], { entries: [cap] });
    // package.json is on the always-run list, so use a custom list to isolate rule 4.
    expect(sel.all).toBe(true);
    const isolated = selectAffected({ entries, baseById: base, changed: ['package.json'], relatedTests: new Set(), alwaysRun: [] });
    expect(ids(isolated)).toEqual(['cap-1']);
  });

  it('the always-run list: harness, runner config, dependencies and workflows select everything, and the manifest directory is not on it', () => {
    for (const path of ['tools/mutate/run.mjs', 'tools/mutate/package.json', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json', '.github/workflows/ci.yml']) {
      const sel = run([path]);
      expect(sel.all, path).toBe(true);
    }
    // The three things under tools/mutate/ that cannot change an outcome. The README case
    // is not hypothetical: replaying this rule over PR #508 selected all 376 entries on a
    // docs-only line before the pattern was narrowed to harness code.
    for (const path of ['tools/mutate/manifests/sim.json', 'tools/mutate/README.md', 'tools/mutate/scope-costs.json']) {
      const sel = run([path]);
      expect(sel.all, path).toBe(false);
      expect(ids(sel), path).toEqual([]);
    }
  });
});
