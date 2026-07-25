import { describe, it, expect } from 'vitest';
// This project has no @types/node dependency (the sim toolchain is kept
// deliberately minimal/browser-oriented), so plain TS strict-mode cannot
// resolve these Node built-ins by name. They are real modules at runtime
// under vitest's "node" environment (see vite.config.ts test.environment);
// @ts-ignore below suppresses the missing-declaration error only, not a
// real type-safety gap, since this file is the sole consumer.
// @ts-ignore -- 'fs' has no type declarations without @types/node
import { readdirSync, readFileSync, statSync } from 'fs';
// @ts-ignore -- 'path' has no type declarations without @types/node
import { join, relative } from 'path';

declare const __dirname: string;
declare const process: { cwd(): string };

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

const SIM_ROOT = join(__dirname); // src/sim

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

// This guard's own filename: excluded from the scan below. Its source
// necessarily contains the forbidden tokens as string literals/comments
// (to describe and detect them) rather than as real imports or global
// references, so scanning itself would be a guaranteed false positive.
const SELF_FILENAME = 'purity.test.ts';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (st.isFile() && entry.endsWith('.ts') && entry !== SELF_FILENAME) {
      out.push(full);
    }
  }
  return out;
}

describe('sim purity guard', () => {
  const files = listTsFiles(SIM_ROOT);

  it('found at least one .ts file under src/sim (sanity check)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never imports three or howler, and never references DOM-only globals', () => {
    const violations: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const relPath = relative(process.cwd(), file);
      const codeOnly = stripComments(src);

      for (const { token, re } of FORBIDDEN_IMPORT_PATTERNS) {
        if (re.test(src)) {
          violations.push(`${relPath}: forbidden import "${token}"`);
        }
      }

      for (const globalName of FORBIDDEN_GLOBALS) {
        const wordBoundaryRe = new RegExp(`\\b${globalName}\\b`);
        if (wordBoundaryRe.test(codeOnly)) {
          violations.push(`${relPath}: forbidden reference to "${globalName}"`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
