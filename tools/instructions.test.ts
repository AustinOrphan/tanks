// CLAUDE.md and AGENTS.md are the same document under two names, because two different
// agent harnesses look for two different filenames. They were kept in sync by hand, which
// nothing enforced, and the failure mode is silent -- an edit to one leaves the other
// stating the opposite convention, and no typecheck, test or lint can see it.
// `devflags.ts` has already been through exactly this on two branches, at 40 and 53 lines,
// in the one file whose job was to be the single place flags are defined.
//
// AGENTS.md is now a SYMLINK to CLAUDE.md, so they cannot diverge at all. That makes a
// content comparison worthless -- both sides of a symlink trivially agree -- so what is
// guarded here is the link itself. Someone replacing it with a copy (a Windows checkout,
// a tool that materialises links, a well-meaning "fix") is exactly the regression this
// file exists to catch, and a copy passes any content check.
//
// WHAT THIS DOES NOT CATCH, established by mutation rather than assumed: a prose edit that
// REVERSES the convention while still naming backlog.md passes every assertion here. A
// string check cannot tell a rule from its own negation, and pretending otherwise would be
// the decorative assertion CLAUDE.md warns about. The existence check below is the part
// that is real: it makes "the pointer points at something" true rather than assumed.
import { describe, it, expect } from 'vitest';
import { readFileSync, lstatSync, readlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLAUDE = fileURLToPath(new URL('../CLAUDE.md', import.meta.url));
const AGENTS = fileURLToPath(new URL('../AGENTS.md', import.meta.url));
const BACKLOG = fileURLToPath(new URL('../docs/superpowers/backlog.md', import.meta.url));

describe('the instruction files', () => {
  // Read first: an empty or missing file would make the assertions below pass vacuously.
  // Same trap hud.css.test.ts documents, where `?raw` silently returned "".
  it('load as text at all', () => {
    expect(readFileSync(CLAUDE, 'utf8').length).toBeGreaterThan(1000);
    expect(readFileSync(AGENTS, 'utf8').length).toBeGreaterThan(1000);
  });

  it('are one file: AGENTS.md is a symlink to CLAUDE.md', () => {
    // lstat, not stat -- stat follows the link and reports a regular file either way,
    // which is the whole distinction this guards.
    expect(lstatSync(AGENTS).isSymbolicLink()).toBe(true);
    // `./CLAUDE.md` resolves identically and is not a defect; only the target matters.
    expect(readlinkSync(AGENTS).replace(/^\.\//, '')).toBe('CLAUDE.md');
  });

  // The worktree is not the artifact: the INDEX is what a fresh clone gets. A symlink
  // blob's content is the target path, so `AGENTS.md` staged as mode 100644 has the same
  // blob hash as the symlink and every worktree assertion above still passes -- while a
  // clone materialises a 9-byte text file reading "CLAUDE.md" instead of the instructions.
  // Established by mutation (`git update-index --cacheinfo 100644,<same blob>,AGENTS.md`),
  // which survived the lstat check.
  it('are committed as a symlink, not just linked in the worktree', () => {
    const entry = execFileSync('git', ['ls-files', '-s', 'AGENTS.md'], { cwd: ROOT, encoding: 'utf8' });
    expect(entry.split(/\s+/)[0]).toBe('120000');
  });

  // The backlog is only "one well-defined and easy to find location" while the file that
  // loads into every session says where it is AND the file is there. The string check
  // alone passed with backlog.md deleted from the tree, which is why the second line
  // exists.
  it('name the backlog as the home for deferred work, and it exists', () => {
    expect(readFileSync(CLAUDE, 'utf8')).toContain('docs/superpowers/backlog.md');
    expect(existsSync(BACKLOG)).toBe(true);
  });
});
