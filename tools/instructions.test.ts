// CLAUDE.md and AGENTS.md are the same document under two names, because two different
// agent harnesses look for two different filenames. Nothing enforced that: they are kept
// in sync by hand, they are the longest prose files in the repo, and the failure mode is
// silent -- an edit to one leaves the other stating the opposite convention, and no
// typecheck, test or lint can see it. `devflags.ts` has already been through exactly this
// on two branches, at 40 and 53 lines, in the one file whose job was to be the single
// place flags are defined.
//
// This is the cheapest guard that would catch it. When the two files become one (a
// symlink), this file's first case goes green trivially and should be deleted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

describe('the instruction files', () => {
  // Read at all before comparing anything: two empty strings are byte-identical, so a
  // broken path would make every case below pass vacuously. This is the same trap
  // hud.css.test.ts documents, where `?raw` silently returned "".
  it('load as text at all', () => {
    expect(claude.length).toBeGreaterThan(1000);
    expect(agents.length).toBeGreaterThan(1000);
  });

  it('are byte-identical', () => {
    // Not a weaker "both mention X" check: any divergence at all is the defect, since
    // whichever harness reads the stale one acts on instructions nobody decided to change.
    expect(agents).toBe(claude);
  });

  // The backlog is only "one well-defined and easy to find location" while the file that
  // loads into every session says where it is. Deleting that pointer is a silent
  // regression to the state this guard was written in.
  it('name the backlog as the home for deferred work', () => {
    expect(claude).toContain('docs/superpowers/backlog.md');
  });
});
