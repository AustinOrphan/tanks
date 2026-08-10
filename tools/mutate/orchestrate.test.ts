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
 * must report FAILED-TO-APPLY, not SURVIVED; and a manifest whose declared outcome is
 * wrong must produce a non-zero exit code.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findOccurrences, applyAt, validateEntry, validateManifest } from './lib.mjs';
import { runOne, runManifest, computeExitCode, STATUS } from './orchestrate.mjs';
import { parseArgs, formatResult, dirtyReport, runTestsReal } from './run.mjs';

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

function fakeDeps(overrides = {}) {
  const files = new Map(overrides.initialFiles ?? [['f.ts', 'const X = 1;']]);
  const calls = { readFile: 0, applyToDisk: 0, restoreToDisk: 0, runTests: 0 };
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
    runTests: vi.fn(overrides.runTests ?? (() => {
      calls.runTests++;
      return { failed: 1, total: 3 };
    })),
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

  it('marks a mismatch, naming what the manifest declared', () => {
    const line = formatResult({ id: 'x', status: STATUS.SURVIVES, matches: false, detail: '0 of 5 test(s) failed' }, 1, 1, e);
    expect(line).toMatch(/MISMATCH: manifest declared "killed"/);
  });

  it('tags an equivalent-mutant survive distinctly from a plain survive', () => {
    const result = { id: 'x', status: STATUS.SURVIVES, matches: true, detail: '0 of 5 test(s) failed' };
    expect(formatResult(result, 1, 1, { ...e, equivalent: true })).toMatch(/\[equivalent mutant\]/);
    expect(formatResult(result, 1, 1, { ...e, equivalent: false })).not.toMatch(/\[equivalent mutant\]/);
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

  it('no stray tmp-e2e-* fixtures are left in tools/mutate/fixtures/ after this suite', () => {
    const left = existsSync(fixturesDir)
      ? readdirSync(fixturesDir).filter((f) => f.startsWith('tmp-e2e-'))
      : [];
    expect(left).toEqual([]);
  });
});
