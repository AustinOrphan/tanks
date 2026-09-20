import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The import is LOAD-BEARING twice over, and it is the reason this file exists (issue #881).
//
// For the mutation harness: `tools/mutate` measures an entry through Vitest's own dependency
// graph, and a test that only reads a file as text relates to nothing, so its entry is refused
// outright. This import is what puts `forced-colors.mjs` in that graph.
//
// And behaviourally: before #881 this module called `main()` at the top level, so importing it
// HERE would RUN it -- run every forced-colours pass. That it does not is the guard working.
import './forced-colors.mjs';

describe('forced-colors.mjs: the seams no vitest run can execute', () => {
  const src = readFileSync(new URL('./forced-colors.mjs', import.meta.url), 'utf8');

  it('calls main() only when it is the process entry point', () => {
    // Pinned as SOURCE rather than behaviour because the behaviour is this file importing at
    // all. `process.argv[1]` under Vitest is the runner, never this module.
    expect(src, 'the entry-point guard is gone').toMatch(
      /const isEntryPoint = process\.argv\[1\] && pathToFileURL\(resolve\(process\.argv\[1\]\)\)\.href === import\.meta\.url;/,
    );
    expect(src, 'main() is invoked outside the guard').toMatch(/if \(isEntryPoint\) \{/);
  });

  it('installs the AudioContext override before each pass navigates', () => {
    // Issue #877. Exactly four spaces: `\s*` would accept the call nested inside an
    // `if`, which is the one shape this rejects -- an override only some machines installed
    // would let two machines photograph different pages.
    expect(src, 'the override is gone, conditional, or no longer on its own line').toMatch(
      /^ {4}await page\.addInitScript\(audioContextOverrideSource\(\)\);$/m,
    );
    const at = src.search(/^ {4}await page\.addInitScript\(audioContextOverrideSource\(\)\);$/m);
    const firstGoto = src.indexOf('.goto(');
    expect(at, 'the override call was not found').toBeGreaterThan(-1);
    expect(firstGoto, 'no navigation was found').toBeGreaterThan(-1);
    expect(at, 'the override is installed after the first navigation').toBeLessThan(firstGoto);
  });
});
