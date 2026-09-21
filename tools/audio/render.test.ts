import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The import is LOAD-BEARING twice over, and it is the reason this file exists (issue #881).
//
// For the mutation harness: `tools/mutate` measures an entry through Vitest's own dependency
// graph, and a test that only reads a file as text relates to nothing, so its entry is refused
// outright. This import is what puts `render.mjs` in that graph.
//
// And behaviourally: before #881 this module's whole body -- argument parsing, two
// `process.exit(2)` paths and a 360-line `try`/`finally` -- ran at the top level, so importing
// it HERE would have spawned vite, launched Chromium and rendered a .wav into `audio-out/`.
// That it now returns in single-digit milliseconds is the guard working.
//
// What the guard is NOT for, measured rather than assumed: it does not prevent a hang. With
// the guard removed, this suite still fails in about a second -- `main()` is async and nothing
// awaits it at module scope, so the import returns immediately and the assertion below is what
// catches the missing guard. The renderer is simply killed part-way when vitest exits. The
// value is that the tool does not RUN at all: no vite, no Chromium, no `audio-out/` write
// racing whatever else is on the machine.
import './render.mjs';

describe('render.mjs: the seams no vitest run can execute', () => {
  const src = readFileSync(new URL('./render.mjs', import.meta.url), 'utf8');

  it('calls main() only when it is the process entry point', () => {
    expect(src, 'the entry-point guard is gone').toMatch(
      /const isEntryPoint = process\.argv\[1\] && pathToFileURL\(resolve\(process\.argv\[1\]\)\)\.href === import\.meta\.url;/,
    );
    expect(src, 'main() is invoked outside the guard').toMatch(/if \(isEntryPoint\) \{/);
  });

  it('installs the AudioContext override before the synth navigation', () => {
    // Issue #877, and this is the tool where a wrong call changes OUTPUT rather than failing:
    // it renders through `OfflineAudioContext`, which the override leaves alone. Exactly FOUR
    // spaces -- two of its own plus the two #881's `main()` wrapper added -- because `\s*`
    // would accept the call nested inside an `if`, and an override only some machines
    // installed would let two machines render different audio.
    const call = /^ {4}await page\.addInitScript\(audioContextOverrideSource\(\)\);$/m;
    expect(src, 'the override is gone, conditional, or no longer on its own line').toMatch(call);
    const at = src.search(call);
    const firstGoto = src.indexOf('page.goto(');
    expect(at, 'the override call was not found').toBeGreaterThan(-1);
    expect(firstGoto, 'no navigation was found').toBeGreaterThan(-1);
    expect(at, 'the override is installed after the first navigation').toBeLessThan(firstGoto);
  });
});
