// A literal NUL byte anywhere in a tracked text file makes GNU grep treat the WHOLE file as
// binary and print nothing -- no match, no warning, exit 1. The file is not corrupt and the
// build does not care, so nothing else notices. What notices is every person and every agent
// who greps for a symbol in it and concludes it is not there.
//
// That is not hypothetical. `tools/screens/sweep-plan.mjs` carried one inside its key
// separator, and a search for `LAYOUTS` -- a symbol the file really does export and
// `sweep.mjs` really does import -- came back empty, which reads exactly like a stale
// reference in an issue. Six lines further down, the same file already wrote the same
// separator as an escape, so both spellings sat side by side with only one of them blinding
// the file.
//
// The escape produces an identical string at runtime. There is no reason to spend a file's
// greppability on the literal.
//
// WHY A SWEEP AND NOT A MUTATION ENTRY. The mutation harness refuses this pairing, correctly:
// this test reads the file as BYTES rather than importing it, so vitest's dependency graph
// never relates the two and a mutation there could only ever report SURVIVES, which is
// indistinguishable from genuinely uncaught. The known-bad control is therefore built in
// below, against a synthetic file, where it runs on every invocation instead of once by hand.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Extensions whose files a person would expect to grep. Binary assets are excluded on purpose. */
const TEXT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.md', '.yml', '.yaml', '.svg',
];

const NUL = 0x00;

/**
 * The detection itself, with the file list and the reader injected so the control below can
 * run it against a file built to fail. Returns the offending paths, in the order given.
 */
export function filesContainingNul(
  paths: readonly string[],
  read: (path: string) => Buffer,
): string[] {
  return paths.filter((path) => read(path).includes(NUL));
}

function trackedTextFiles(): string[] {
  // `-z` because a path may contain anything; the separator is the one byte it may not.
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return listed
    .split(String.fromCharCode(NUL))
    .filter((path) => path !== '')
    .filter((path) => TEXT_EXTENSIONS.some((ext) => path.endsWith(ext)))
    // `ls-files` reads the INDEX, so it still lists a file deleted from the working tree but
    // not yet staged -- an ordinary state mid-edit. Reading one throws ENOENT and crashes the
    // sweep, which says nothing about NUL bytes. This guard is about content, not presence.
    .filter((path) => existsSync(join(ROOT, path)));
}

describe('tracked source text stays greppable', () => {
  it('contains no literal NUL byte, which would silently blind grep to the whole file', () => {
    const files = trackedTextFiles();

    // A vacuous pass is the failure mode this guard is most likely to develop: if `git
    // ls-files` ever returns nothing -- wrong cwd, not a repository, an argument change --
    // the filter below runs over an empty list and reports success. Pin the population so the
    // sweep has to have actually swept. 2053 such files were tracked when this was written;
    // the floor sits far below that so ordinary deletions do not trip it.
    expect(
      files.length,
      'git ls-files returned too few files for this sweep to mean anything',
    ).toBeGreaterThan(500);

    const offenders = filesContainingNul(files, (path) => readFileSync(join(ROOT, path)));

    expect(
      offenders,
      'write the separator as an escape instead -- same string at runtime, and the file stays greppable',
    ).toEqual([]);
  });

  it('reports a file that does contain one, so the sweep above can actually fail', () => {
    // The known-bad control `.claude/rules/testing.md` asks for. Without it, the assertion
    // above passes on an empty repository, a broken reader, or a predicate that never looks
    // at its input -- and advertises coverage that does not exist.
    const dir = mkdtempSync(join(tmpdir(), 'source-text-'));
    const clean = join(dir, 'clean.ts');
    const blinded = join(dir, 'blinded.ts');
    writeFileSync(clean, "const sep = '\\u0000';\n");
    writeFileSync(blinded, `const sep = '${String.fromCharCode(NUL)}';\n`);

    // The escaped spelling is six ordinary characters and must NOT be flagged; only the raw
    // byte is the problem. That contrast is the whole point of the fix this guards.
    expect(readFileSync(clean).includes(NUL)).toBe(false);
    expect(readFileSync(blinded).includes(NUL)).toBe(true);

    expect(filesContainingNul([clean, blinded], (path) => readFileSync(path))).toEqual([blinded]);
  });
});
