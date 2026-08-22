// THIRD-PARTY-NOTICES.md is generated from package.json's runtime "dependencies" and each
// dependency's license file in node_modules -- see tools/notices/render.mjs and
// generate.mjs. Same regenerate-and-diff idiom as tools/devflags/doc.test.ts and
// tools/tanks/doc.test.ts (CLAUDE.md: "quote a measurement and you owe it a recomputing
// test"), applied to a top-level generated file instead of a docs/ page: regenerate in
// memory, compare against what's committed, fail if they differ. The fix for a red run
// here is `npm run notices`, never hand-editing this test or the file -- editing either to
// make this pass is exactly the "repair the red build by changing what it expects" habit
// CLAUDE.md warns against.
//
// Two production mutations this guards against, named so a reader can check the negative
// control without re-deriving it:
//  1. Add a runtime dependency to package.json's "dependencies" without running
//     `npm run notices` -- the "every dependency appears" assertion below fails because
//     the new name is in package.json but not yet rendered into the committed file.
//  2. Hand-edit THIRD-PARTY-NOTICES.md (reword a sentence, fix a typo) without
//     regenerating -- the byte-identical comparison fails because the committed text no
//     longer matches renderNotices()'s output.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderNotices, runtimeDependencyNames } from './render.mjs';

const OUT = fileURLToPath(new URL('../../THIRD-PARTY-NOTICES.md', import.meta.url));
const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
);

describe('THIRD-PARTY-NOTICES.md is generated, not hand-edited', () => {
  it('exists', () => {
    expect(() => readFileSync(OUT, 'utf8')).not.toThrow();
  });

  it('matches what renderNotices() produces right now -- run `npm run notices` to fix', () => {
    const generated = renderNotices();
    // Vacuity guard: an empty generated string would make the equality below pass
    // trivially against an accidentally-emptied file, the same trap tools/devflags/
    // doc.test.ts documents.
    expect(generated.length).toBeGreaterThan(200);
    const committed = readFileSync(OUT, 'utf8');
    expect(committed).toBe(generated);
  });

  it('self-describes as generated', () => {
    const committed = readFileSync(OUT, 'utf8');
    expect(committed).toContain('GENERATED');
    expect(committed).toContain('npm run notices');
  });

  it('lists every runtime dependency from package.json, derived not hardcoded', () => {
    // Derived from package.json itself rather than a literal ['howler', 'three'] list, so
    // this test does not need editing the day a third runtime dependency is added -- only
    // `npm run notices` does.
    const names = runtimeDependencyNames(PKG);
    // Non-vacuity: today's package.json has runtime dependencies (howler, three); if it
    // ever had zero this loop would pass trivially, so pin the current population
    // alongside the check rather than asserting on an empty set.
    expect(names.length).toBeGreaterThan(0);
    const committed = readFileSync(OUT, 'utf8');
    for (const name of names) {
      expect(committed).toContain(name);
    }
  });

  it('excludes devDependencies by name (they are build tooling, not distributed)', () => {
    const devNames = Object.keys(PKG.devDependencies ?? {});
    expect(devNames.length).toBeGreaterThan(0);
    const committed = readFileSync(OUT, 'utf8');
    for (const name of devNames) {
      // A package section header is "## <name>@<version>"; devDependency names must not
      // appear as a section of their own. (typescript, vite, etc. are not substrings of
      // howler/three, so a plain substring check is safe here.)
      expect(committed).not.toContain(`## ${name}@`);
    }
  });
});
