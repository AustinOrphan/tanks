/**
 * The harness's own tests. Two layers, on purpose:
 *
 * - lib.mjs and orchestrate.mjs, exercised with FAKE deps (in-memory strings, no real
 *   fs/git/vitest). Fast, and what makes edge cases like "ambiguous find" or "restore
 *   verification fails" cheap to hit deliberately.
 * - a handful of REAL end-to-end cases that spawn `node tools/mutate/run.mjs` as a
 *   real subprocess against a real fixture file and a real vitest run. Those are what
 *   prove the actual wiring -- git status parsing, the vitest JSON reporter, process
 *   exit codes -- works, not just the orchestration logic around it. Kept to three
 *   cases because each one pays a real vitest-subprocess-boot cost.
 *
 * "A guard is worth what its own tests prove" (CLAUDE.md) -- so every negative control
 * this tool's own doc comment promises has a test here: a find that does not match
 * must report FAILED-TO-APPLY, not SURVIVED; and a manifest whose declared outcome is
 * wrong must produce a non-zero exit code.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findOccurrences, applyAt, validateEntry, validateManifest } from './lib.mjs';
import { runOne, runManifest, computeExitCode, STATUS } from './orchestrate.mjs';

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
// End-to-end: the real CLI, a real fixture file, a real vitest subprocess.
// ---------------------------------------------------------------------------

const FIXTURE_REL = 'tools/mutate/fixtures/greeter.mjs';
const FIXTURE_TEST_REL = 'tools/mutate/fixtures/greeter.fixture.test.ts';
const FIXTURE_PATH = join(ROOT, FIXTURE_REL);
const RUN_MJS = join(ROOT, 'tools/mutate/run.mjs');

function gitPorcelain(relPath) {
  return execFileSync('git', ['status', '--porcelain', '--', relPath], { cwd: ROOT }).toString();
}

function writeTmpManifest(entries) {
  const p = join(ROOT, `tools/mutate/fixtures/tmp-manifest-${process.pid}-${Date.now()}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

function runCli(manifestAbsPath, extraArgs: string[] = []) {
  const rel = manifestAbsPath.slice(ROOT.length);
  return spawnSync('node', [RUN_MJS, '--manifest', rel, ...extraArgs], { cwd: ROOT, encoding: 'utf8' });
}

describe('end-to-end: real CLI against the greeter fixture', () => {
  it('precondition: the fixture is clean before these tests run', () => {
    expect(gitPorcelain(FIXTURE_REL).trim()).toBe('');
  });

  it('FAILED-TO-APPLY when find does not match -- never SURVIVED, and the file is untouched', () => {
    const manifest = writeTmpManifest([{
      id: 'e2e-not-found', file: FIXTURE_REL,
      find: 'this string is not in greeter.mjs', replace: 'x',
      why: 'negative control', expect: 'survives', tests: [FIXTURE_TEST_REL],
    }]);
    try {
      const res = runCli(manifest);
      expect(res.stdout).toMatch(/FAILED-TO-APPLY/);
      expect(res.stdout).not.toMatch(/SURVIVES/);
      expect(res.status).not.toBe(0); // FAILED-TO-APPLY always counts as a mismatch
      expect(gitPorcelain(FIXTURE_REL).trim()).toBe(''); // nothing was ever written
    } finally {
      rmSync(manifest, { force: true });
    }
  });

  it('a real killed mutation: correct declared outcome exits 0, and the file is genuinely restored (checked via git, not self-report)', () => {
    const manifest = writeTmpManifest([{
      id: 'e2e-killed', file: FIXTURE_REL,
      find: 'return `hello ${name}`;', replace: 'return `yo ${name}`;',
      why: 'greeter.fixture.test.ts asserts the exact string "hello world"', expect: 'killed',
      tests: [FIXTURE_TEST_REL],
    }]);
    try {
      const res = runCli(manifest);
      expect(res.stdout).toMatch(/KILLED/);
      expect(res.stdout).toMatch(/matches declared outcome/);
      expect(res.status).toBe(0);
      expect(gitPorcelain(FIXTURE_REL).trim()).toBe('');
      expect(readFileSync(FIXTURE_PATH, 'utf8')).toContain('hello ${name}');
    } finally {
      rmSync(manifest, { force: true });
    }
  });

  it('the SAME mutation with the WRONG declared outcome exits non-zero -- this is the whole point', () => {
    const manifest = writeTmpManifest([{
      id: 'e2e-wrong-declared', file: FIXTURE_REL,
      find: 'return `hello ${name}`;', replace: 'return `yo ${name}`;',
      why: 'deliberately wrong: this mutation is killed, declared survives',
      expect: 'survives', // WRONG on purpose
      tests: [FIXTURE_TEST_REL],
    }]);
    try {
      const res = runCli(manifest);
      expect(res.stdout).toMatch(/KILLED/);
      expect(res.stdout).toMatch(/MISMATCH/);
      expect(res.status).not.toBe(0);
      expect(gitPorcelain(FIXTURE_REL).trim()).toBe(''); // still restored despite the mismatch
    } finally {
      rmSync(manifest, { force: true });
    }
  });

  it('refuses to start against a file that is already dirty, and touches nothing', () => {
    const before = readFileSync(FIXTURE_PATH, 'utf8');
    writeFileSync(FIXTURE_PATH, before + '\n// manually dirtied by this test\n');
    const manifest = writeTmpManifest([{
      id: 'e2e-dirty', file: FIXTURE_REL,
      find: 'return `hello ${name}`;', replace: 'return `yo ${name}`;',
      why: 'should never be reached', expect: 'killed', tests: [FIXTURE_TEST_REL],
    }]);
    try {
      const res = runCli(manifest);
      expect(res.status).toBe(2);
      expect((res.stderr ?? '') + (res.stdout ?? '')).toMatch(/already dirty|refusing to start/);
      expect(readFileSync(FIXTURE_PATH, 'utf8')).toBe(before + '\n// manually dirtied by this test\n');
    } finally {
      rmSync(manifest, { force: true });
      writeFileSync(FIXTURE_PATH, before); // clean up the manual dirtying
    }
  });

  it('postcondition: the fixture is clean after these tests ran', () => {
    expect(gitPorcelain(FIXTURE_REL).trim()).toBe('');
  });
});
