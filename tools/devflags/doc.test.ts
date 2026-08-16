// docs/dev-flags.md is generated from src/game/devflags.ts's FLAG_REGISTRY -- see
// tools/devflags/render.ts and generate.mjs. This is the backlog.test.ts convention
// (CLAUDE.md: "quote a measurement and you owe it a recomputing test") applied to a whole
// file instead of a number in prose: regenerate in memory, compare against what's
// committed, and fail if they differ. The fix for a red run here is `npm run
// devflags:doc`, never editing this test or the doc by hand -- editing either to make
// this pass is exactly the "repair the red build by changing what it expects" habit
// CLAUDE.md warns ends guards.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderDevFlagsDoc } from './render';

const DOC = fileURLToPath(new URL('../../docs/dev-flags.md', import.meta.url));

describe('docs/dev-flags.md is generated, not hand-edited', () => {
  it('exists', () => {
    expect(existsSync(DOC)).toBe(true);
  });

  it('matches what renderDevFlagsDoc() produces right now -- run `npm run devflags:doc` to fix', () => {
    const generated = renderDevFlagsDoc();
    // Vacuity guard: an empty generated string would make the equality below pass
    // trivially against an accidentally-emptied file. Same trap hud.css.test.ts documents
    // (`?raw` silently returning "").
    expect(generated.length).toBeGreaterThan(500);
    const committed = readFileSync(DOC, 'utf8');
    expect(committed).toBe(generated);
  });

  it('is non-trivial and self-describes as generated', () => {
    const committed = readFileSync(DOC, 'utf8');
    expect(committed).toContain('GENERATED');
    expect(committed).toContain('npm run devflags:doc');
  });
});
