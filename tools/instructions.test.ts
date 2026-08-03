// CLAUDE.md and AGENTS.md are the same document under two names, because two different
// agent harnesses look for two different filenames. They were kept in sync by hand, which
// nothing enforced: they are the longest prose files in the repo, and the failure mode is
// silent -- an edit to one leaves the other stating the opposite convention, and no
// typecheck, test or lint can see it. `devflags.ts` has already been through exactly this
// on two branches, at 40 and 53 lines, in the one file whose job was to be the single
// place flags are defined.
//
// AGENTS.md is now a SYMLINK to CLAUDE.md, so they cannot diverge at all. That makes a
// content comparison worthless -- both sides of a symlink trivially agree -- so what is
// guarded here is the link itself. Someone replacing it with a copy (a Windows checkout,
// a tool that materialises links, a well-meaning "fix") is exactly the regression this
// file exists to catch, and a copy passes any content check.
import { describe, it, expect } from 'vitest';
import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLAUDE = fileURLToPath(new URL('../CLAUDE.md', import.meta.url));
const AGENTS = fileURLToPath(new URL('../AGENTS.md', import.meta.url));

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
    expect(readlinkSync(AGENTS)).toBe('CLAUDE.md');
  });

  // The backlog is only "one well-defined and easy to find location" while the file that
  // loads into every session says where it is. Deleting that pointer is a silent
  // regression to the state this guard was written in.
  it('name the backlog as the home for deferred work', () => {
    expect(readFileSync(CLAUDE, 'utf8')).toContain('docs/superpowers/backlog.md');
  });
});
