import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The import is LOAD-BEARING twice over, and it is the reason this file exists (issue #881).
//
// For the mutation harness: `tools/mutate` measures an entry through Vitest's own dependency
// graph, and a test that only reads a file as text relates to nothing, so its entry is refused
// outright. This import is what puts `run.mjs` in that graph.
//
// And behaviourally: before #881 this module called `main()` at the top level, so importing it
// HERE would RUN it -- spawn vite and render a gallery. That it does not is the guard working.//
// MEASURED here, because this tool's `main()` is the cheapest to recover from: with the guard
// removed, the import really does run it, and this suite then reports a clean FAILURE rather
// than a hang -- the gallery finishes in about a second and a half, so the source assertion
// below is what catches it.
//
// Two claims this comment made and lost. It first said an unguarded import would HANG, for all
// five tools; this control disproved that. It then said a LONGER tool would hold the suite for
// as long as it runs; issue #881's sixth tool, the audio renderer, disproved that too -- its
// `main()` is async and nothing awaits it at module scope, so the import returns at once
// whatever the tool would go on to do. The guard's value is that the tool does not RUN: no
// vite, no Chromium, no output directory written while a unit suite is the thing in flight.
import './run.mjs';

describe('run.mjs: the seams no vitest run can execute', () => {
  const src = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');

  it('calls main() only when it is the process entry point', () => {
    // Pinned as SOURCE rather than behaviour because the behaviour is this file importing at
    // all. `process.argv[1]` under Vitest is the runner, never this module.
    expect(src, 'the entry-point guard is gone').toMatch(
      /const isEntryPoint = process\.argv\[1\] && pathToFileURL\(resolve\(process\.argv\[1\]\)\)\.href === import\.meta\.url;/,
    );
    expect(src, 'main() is invoked outside the guard').toMatch(/if \(isEntryPoint\) \{/);
  });

  it('installs the AudioContext override before the gameplay navigation', () => {
    // Issue #877. Exactly two spaces: `\s*` would accept the call nested inside an
    // `if`, which is the one shape this rejects -- an override only some machines installed
    // would let two machines photograph different pages.
    expect(src, 'the override is gone, conditional, or no longer on its own line').toMatch(
      /^ {2}await page\.addInitScript\(audioContextOverrideSource\(\)\);$/m,
    );
    const at = src.search(/^ {2}await page\.addInitScript\(audioContextOverrideSource\(\)\);$/m);
    const firstGoto = src.indexOf('.goto(');
    expect(at, 'the override call was not found').toBeGreaterThan(-1);
    expect(firstGoto, 'no navigation was found').toBeGreaterThan(-1);
    expect(at, 'the override is installed after the first navigation').toBeLessThan(firstGoto);
  });
});
