/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';

// WHY THIS TEST EXISTS:
//
// `src/sim/` is required to be a PURE, deterministic core: it must import
// NOTHING from `three`, the DOM, or `howler`. That property is what makes
// the sim unit-testable headlessly (no browser, no WebGL context, no audio
// device) and deterministic across runs (physics/AI/replays are exact
// functions of their inputs). Render (`src/render/`) and audio code are
// one-way projections OF sim state -- the sim must never reach back into
// them or into any browser global.
//
// Starting with Task 24, `three` enters the codebase for the first time,
// and Tasks 25-33 add substantially more render/audio code alongside it.
// A stray `import * as THREE from 'three'` inside `src/sim/` would compile
// fine and pass every other test while silently destroying headless
// determinism. This test scans every `.ts` file under `src/sim/` and fails
// loudly, naming the offending file and token, if that ever happens.
//
// File discovery uses Vite's `import.meta.glob` (native to vitest, typed
// via the `vite/client` triple-slash reference above) instead of Node's
// `fs`/`path`, so this project's lack of an `@types/node` dependency never
// forces a `@ts-ignore` onto a guard whose whole point is catching things
// that "compile fine".

// Raw source of every .ts file under src/sim (recursive, eager -- this is a
// small, one-off test-time scan, not a runtime hot path).
const rawModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// This guard's own filename: excluded from the scan below. Its source
// necessarily contains the forbidden tokens as string literals/comments
// (to describe and detect them) rather than as real imports or global
// references, so scanning itself would be a guaranteed false positive.
const SELF_PATH = './purity.test.ts';

const files = Object.keys(rawModules).filter((path) => path !== SELF_PATH);

const FORBIDDEN_IMPORT_PATTERNS: Array<{ token: string; re: RegExp }> = [
  { token: `from 'three'`, re: /from\s+['"]three['"]/ },
  { token: `from 'three/...'`, re: /from\s+['"]three\// },
  { token: `from 'howler'`, re: /from\s+['"]howler['"]/ },
  { token: `from 'howler/...'`, re: /from\s+['"]howler\// },
];

// Bare-identifier DOM-only globals. Word-boundary match so `windowSize` etc.
// does not false-positive.
const FORBIDDEN_GLOBALS = ['document', 'window', 'navigator', 'localStorage'];

// Comments ARE excluded from the global-identifier scan (e.g. a sim test
// legitimately talks about a "cautious window" of time in a comment). This
// is a lightweight state-machine strip of line/block comments that tracks
// string/template literals so comment markers inside strings don't confuse
// it -- cheap and reliable enough for this codebase's TS source. Real
// `import ... from 'three'/'howler'` checks intentionally run on the
// UNSTRIPPED source, since a real import can never appear only in a
// comment in a way we'd want to ignore -- but stripping first would also
// be safe there; it's just unnecessary.
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'") {
        state = 'single';
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        state = 'double';
        out += c;
        i += 1;
        continue;
      }
      if (c === '`') {
        state = 'template';
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c; // preserve newlines so line numbers stay stable
      i += 1;
      continue;
    }
    // single / double / template string literal
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (c === '\\') {
      out += c + c2;
      i += 2;
      continue;
    }
    if (c === quote) {
      state = 'code';
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

describe('sim purity guard', () => {
  // NON-VACUITY CHECK -- read this before touching file discovery above.
  //
  // The check below ("never imports three or howler...") loops over `files`
  // asserting each one is clean. If the discovery step above ever breaks or
  // silently narrows (wrong glob pattern, wrong root, a refactor that
  // returns an empty/partial list), that loop body runs zero or too few
  // times, NO assertion inside it ever fires, and the whole guard reports
  // green while enforcing NOTHING -- a guard that silently stops guarding
  // is worse than no guard, because it produces false confidence instead of
  // an honest gap. This happened for real once already: a partial edit to
  // this exact file made discovery stop collecting, and the suite dropped
  // from 218 to 216 tests while still reporting all-green. These assertions
  // pin a floor (there are 30+ .ts files under src/sim today, including
  // ai/) and specific known files by path, so a broken or narrowed scan
  // fails loudly here instead of passing vacuously.
  it('discovered a plausible set of files under src/sim (non-vacuity check)', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);

    const expectedSuffixes = ['world.ts', 'bullets.ts', 'arena.ts', 'ai/grey.ts'];
    for (const suffix of expectedSuffixes) {
      const found = files.some((path) => path.endsWith(suffix));
      expect(found, `expected discovery to include a file ending in "${suffix}"; got: ${files.join(', ')}`).toBe(
        true
      );
    }
  });

  it('never imports three or howler, and never references DOM-only globals', () => {
    const violations: string[] = [];

    for (const path of files) {
      const src = rawModules[path];
      const codeOnly = stripComments(src);

      for (const { token, re } of FORBIDDEN_IMPORT_PATTERNS) {
        if (re.test(src)) {
          violations.push(`${path}: forbidden import "${token}"`);
        }
      }

      for (const globalName of FORBIDDEN_GLOBALS) {
        const wordBoundaryRe = new RegExp(`\\b${globalName}\\b`);
        if (wordBoundaryRe.test(codeOnly)) {
          violations.push(`${path}: forbidden reference to "${globalName}"`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
