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
//
// A GUARD IS ONLY WORTH WHAT ITS OWN TESTS PROVE. An adversarial review
// dropped five known-bad probe files into `src/sim/` and this guard reported
// GREEN for four of them (side-effect `import 'three'`, dynamic
// `await import('three')`, `require('howler')`, Vite-absolute
// `from '/src/render/scene'`, and `import ... from 'node:fs'`), because every
// forbidden-import regex required the `from` keyword and `escapesSim` returned
// `false` for every bare specifier. The fix is structural -- ONE classifier
// that every extracted specifier passes through, whatever syntax produced it
// -- and it is pinned by the meta-test at the bottom of this file, which runs
// the detectors over inline fixture strings and asserts each forbidden form
// actually produces a violation. Without that meta-test a typo'd regex yields
// a guard that scans 24 files, finds nothing, and is indistinguishable from a
// clean codebase.

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

// Kept as a redundant, extra-legible first line of defence: these produce a
// message naming the exact offending token. The specifier classifier below
// subsumes them (both deny the bare package `three`/`howler`), so a failure
// here is always accompanied by a classifier failure. Runs on the UNSTRIPPED
// source -- a real `import x from 'three'` cannot hide in a comment in a way
// worth ignoring, and no sim file writes that literal text in prose.
const FORBIDDEN_IMPORT_PATTERNS: Array<{ token: string; re: RegExp }> = [
  { token: `from 'three'`, re: /from\s+['"]three['"]/ },
  { token: `from 'three/...'`, re: /from\s+['"]three\// },
  { token: `from 'howler'`, re: /from\s+['"]howler['"]/ },
  { token: `from 'howler/...'`, re: /from\s+['"]howler\// },
];

// Every module specifier in a file, however it is written. Matching only
// `from '...'` (as an earlier version did) missed four silent escapes:
// side-effect imports (`import '../render/scene';`), dynamic ones
// (`await import('../render/scene')`), CommonJS `require('howler')`, and
// anything reached through a Vite-absolute `'/src/...'` path -- none of which
// uses the `from` keyword at all.
const SPECIFIER_RES: RegExp[] = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // import x from '...' / export ... from '...'
  /\bimport\s+['"]([^'"]+)['"]/g, // side-effect: import '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic: import('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Resolve a RELATIVE specifier against the importing file and report whether
 * it escapes src/sim/.
 *
 * Deliberately resolution-based rather than shape-based. Matching the literal
 * text `'../render'` would be both too strict and too loose: from
 * `sim/ai/grey.ts`, `'../render'` resolves to `sim/render.ts` -- perfectly
 * pure -- while from `sim/world.ts` the same text escapes the sim entirely.
 * Only the resolved path knows the difference.
 *
 * `path` is an import.meta.glob key: './world.ts', './ai/grey.ts'.
 */
function escapesSim(path: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false; // not a relative specifier
  const segments = path.replace(/^\.\//, '').split('/');
  segments.pop(); // drop the filename, leaving the importing file's directory
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      // Popping past the sim root is the escape.
      if (segments.length === 0) return true;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return false;
}

// Bare package specifiers the sim is allowed to name at all. The sim's
// dependency budget is deliberately ZERO runtime packages: everything it needs
// it defines itself (vec math, PRNG, collision). `vitest` is tolerated only in
// `*.test.ts` files -- the harness is not shipped sim code, and a production
// sim module importing it would be a real layering break worth failing on.
//
// This is an ALLOW-list, not a deny-list, and that is the whole point. The
// previous deny-list named `three` and `howler`, so `node:fs`, `node:crypto`,
// `howler-lite`, or any future package walked straight past it. Anything not
// listed here is a violation by default; adding a genuine new dependency is a
// deliberate edit to this line, which is exactly the review moment we want.
const ALLOWED_BARE_SPECIFIERS_IN_TESTS = new Set(['vitest']);

function isTestFile(path: string): boolean {
  return /\.test\.ts$/.test(path);
}

/**
 * THE one classifier. Every specifier extracted by SPECIFIER_RES goes through
 * here regardless of the syntax that produced it, so a new import form only
 * ever needs a new regex above -- never a parallel policy that can drift.
 *
 * Returns a human-readable reason string, or null if the specifier is allowed.
 */
function classifySpecifier(path: string, specifier: string): string | null {
  // Leading '/': Vite resolves this against the PROJECT ROOT, not the
  // filesystem root, so `'/src/render/scene'` is a working import of the
  // renderer from inside the sim. It is never legitimate here.
  if (specifier.startsWith('/')) {
    return `root-absolute import "${specifier}" (Vite resolves a leading "/" against the project root, reaching any file in the repo)`;
  }
  if (specifier.startsWith('.')) {
    return escapesSim(path, specifier) ? `import "${specifier}" escapes src/sim/` : null;
  }
  // Bare specifier: a package (or a Node builtin), never a file inside sim/.
  if (specifier.startsWith('node:')) {
    return `import "${specifier}" reaches a Node builtin (host I/O and clocks are not available to, or deterministic for, the sim)`;
  }
  if (ALLOWED_BARE_SPECIFIERS_IN_TESTS.has(specifier)) {
    return isTestFile(path)
      ? null
      : `import "${specifier}" is a test-only package imported from non-test sim code`;
  }
  return `import "${specifier}" is a bare package specifier; src/sim/ may only import relative paths that stay inside src/sim/`;
}

// Globals the sim may not touch. Word-boundary match so `windowSize` /
// `documentation` etc. do not false-positive.
//
// The first four (DOM) were the original list. The rest were added after a
// probe using `process.hrtime()` inside sim/ sailed through the guard -- a
// genuine nondeterministic clock, available in the vitest env, that the
// "DOM-only" framing had left entirely unguarded. `globalThis`/`self`/`top`/
// `parent` are all escape hatches BACK to the forbidden globals
// (`globalThis.document`, `self.performance`), so denying `document` while
// permitting `globalThis` denies nothing. `fetch`/`XMLHttpRequest`/`Worker`
// are I/O and concurrency: a sim that can await the network or hand work to
// another thread is no longer a pure function of its inputs.
//
// `self`, `top` and `parent` carry a per-token regex instead of the plain
// `\bNAME\b` the rest use, because all three are ordinary English words and
// extremely common LOCAL identifiers in this very codebase: arena.test.ts has
// `const top = boundaries.find(...)`, targeting.test.ts destructures
// `[left, right, bottom, top]`, and bullets.test.ts describes a bullet that
// "does not self-destruct". A guard that fails on those is a guard someone
// deletes within the week. As GLOBALS the three are only reachable through a
// member access (`top.location`, `parent.postMessage`, `self.performance`), so
// requiring one loses no real coverage; the leading `(?<!\.)` additionally
// keeps an ordinary property read like `node.parent.x` from tripping it.
const FORBIDDEN_GLOBALS: Array<{ token: string; re: RegExp }> = [
  { token: 'document', re: /\bdocument\b/ },
  { token: 'window', re: /\bwindow\b/ },
  { token: 'navigator', re: /\bnavigator\b/ },
  { token: 'localStorage', re: /\blocalStorage\b/ },
  { token: 'globalThis', re: /\bglobalThis\b/ },
  { token: 'process', re: /\bprocess\b/ },
  { token: 'fetch', re: /\bfetch\b/ },
  { token: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { token: 'Worker', re: /\bWorker\b/ },
  { token: 'self', re: /(?<!\.)\bself\s*[.[]/ },
  { token: 'top', re: /(?<!\.)\btop\s*[.[]/ },
  { token: 'parent', re: /(?<!\.)\bparent\s*[.[]/ },
];

// Non-deterministic sources. DETERMINISM is the property this guard's own
// docstring claims to protect, yet nothing here checked for it: a stray
// `Math.random()` in the sim breaks replays and reproducible tests exactly as
// thoroughly as an `import 'three'` breaks headlessness, and it is far easier
// to write by accident. Seeded randomness must go through the PRNG in types.ts.
// Scanned against comment-stripped source, since several sim files legitimately
// mention these tokens in comments that FORBID them.
const FORBIDDEN_NONDETERMINISM: Array<{ token: string; re: RegExp }> = [
  { token: 'Math.random', re: /\bMath\s*\.\s*random\b/ },
  { token: 'Date.now', re: /\bDate\s*\.\s*now\b/ },
  { token: 'new Date', re: /\bnew\s+Date\b/ },
  { token: 'performance', re: /\bperformance\b/ },
  { token: 'crypto', re: /\bcrypto\b/ },
  // Timers are the EASIEST way to break determinism, and were missing from the
  // first version of this list. A `setTimeout(() => world.status = 'win', 500)`
  // in the sim destroys replay determinism more completely than a Date.now()
  // would, because the step count at which it lands depends on the host's
  // scheduler. The sim advances only via step(); nothing in it may self-schedule.
  { token: 'setTimeout', re: /\bsetTimeout\b/ },
  { token: 'setInterval', re: /\bsetInterval\b/ },
  { token: 'requestAnimationFrame', re: /\brequestAnimationFrame\b/ },
  { token: 'queueMicrotask', re: /\bqueueMicrotask\b/ },
];

// Comments ARE excluded from the identifier and specifier scans (e.g. a sim
// test legitimately talks about a "cautious window" of time in a comment, and
// several sim files quote the very import forms this guard forbids in order to
// explain why they are forbidden). This is a lightweight state-machine strip
// of line/block comments that tracks string/template literals so comment
// markers inside strings don't confuse it -- cheap and reliable enough for
// this codebase's TS source.
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

// ---- The detectors, as pure (path, source) -> violations functions ----
//
// Extracted from the `it` bodies specifically so the meta-test at the bottom
// can drive them with inline fixture strings. Real files on disk and fixtures
// go through the SAME code path; there is no test-only detector that could
// pass while the real one is broken, and no probe file has to be committed to
// the repo to prove the guard works.

function scanImportsAndGlobals(path: string, src: string): string[] {
  const violations: string[] = [];
  const codeOnly = stripComments(src);

  for (const { token, re } of FORBIDDEN_IMPORT_PATTERNS) {
    if (re.test(src)) {
      violations.push(`${path}: forbidden import "${token}"`);
    }
  }

  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0; // defensive: these are /g regexes shared across files
    for (const m of codeOnly.matchAll(re)) {
      const reason = classifySpecifier(path, m[1]);
      if (reason !== null) violations.push(`${path}: ${reason}`);
    }
  }

  for (const { token, re } of FORBIDDEN_GLOBALS) {
    if (re.test(codeOnly)) {
      violations.push(`${path}: forbidden reference to "${token}"`);
    }
  }

  return violations;
}

function scanNondeterminism(path: string, src: string): string[] {
  const violations: string[] = [];
  const codeOnly = stripComments(src);
  for (const { token, re } of FORBIDDEN_NONDETERMINISM) {
    if (re.test(codeOnly)) {
      violations.push(`${path}: forbidden non-determinism "${token}"`);
    }
  }
  return violations;
}

function scanAll(path: string, src: string): string[] {
  return [...scanImportsAndGlobals(path, src), ...scanNondeterminism(path, src)];
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
  //
  // This covers HALF the vacuity problem (are we looking at anything?). The
  // other half -- do the detectors actually fire? -- is the meta-test suite
  // below, and neither one substitutes for the other.
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

  it('never imports an impure layer, and never references DOM-only globals', () => {
    const violations: string[] = [];
    for (const path of files) {
      violations.push(...scanImportsAndGlobals(path, rawModules[path]));
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('never reaches for a non-deterministic clock or RNG', () => {
    const violations: string[] = [];
    for (const path of files) {
      violations.push(...scanNondeterminism(path, rawModules[path]));
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// META-TEST: does the guard actually DETECT anything?
// ---------------------------------------------------------------------------
//
// The scans above assert `violations === []` over the real files. On a clean
// codebase that assertion passes whether the detectors work perfectly or do
// nothing at all -- a mistyped regex, a classifier that returns null on every
// input, or a deleted rule all produce the exact same green output as a pure
// sim. That is the failure mode this suite exists to close, and it is not
// hypothetical: five of the six forms below were live escapes that the guard
// reported as clean when a reviewer planted them as real files in src/sim/.
//
// Fixtures are INLINE STRINGS, deliberately. Committing probe files to
// src/sim/ would mean shipping known-impure source and permanently breaking
// the real scan; a fixture string exercises the identical `scanAll` code path
// with zero repo contamination.
//
// One fixture per rule, and `covers` is checked against the rule tables at the
// end of this block, so adding a rule without a fixture fails the suite.

interface Fixture {
  /** What forbidden form this fixture demonstrates. */
  rule: string;
  /** import.meta.glob-style path the fixture pretends to live at. */
  path: string;
  src: string;
  /** A substring the resulting violation message must contain. */
  expect: string;
  /** Entries of FORBIDDEN_GLOBALS / FORBIDDEN_NONDETERMINISM this pins. */
  covers?: string;
}

const FORBIDDEN_FIXTURES: Fixture[] = [
  // --- import syntax forms: the four that escaped the `from`-only regexes ---
  {
    rule: 'namespace import of three (the one form the old guard did catch)',
    path: './world.ts',
    src: `import * as THREE from 'three';\nexport const x = THREE;\n`,
    expect: 'three',
  },
  {
    rule: 'side-effect import (no `from` keyword at all)',
    path: './world.ts',
    src: `import 'three';\nexport const x = 1;\n`,
    expect: 'three',
  },
  {
    rule: 'dynamic import (no `from` keyword at all)',
    path: './world.ts',
    src: `export async function boom() {\n  const t = await import('three');\n  return t;\n}\n`,
    expect: 'three',
  },
  {
    rule: 'CommonJS require',
    path: './world.ts',
    src: `const howl = require('howler');\nexport const x = howl;\n`,
    expect: 'howler',
  },
  {
    rule: 'three subpath import',
    path: './world.ts',
    src: `import { Vector3 } from 'three/src/math/Vector3.js';\nexport const x = Vector3;\n`,
    expect: 'three/src/math/Vector3.js',
  },
  {
    rule: 'Vite root-absolute specifier reaching the renderer',
    path: './world.ts',
    src: `export { buildScene } from '/src/render/scene';\n`,
    expect: 'root-absolute',
  },
  {
    rule: 'Node builtin import',
    path: './world.ts',
    src: `import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n`,
    expect: 'node:fs',
  },
  {
    rule: 'unlisted third-party package',
    path: './world.ts',
    src: `import seedrandom from 'seedrandom';\nexport const x = seedrandom;\n`,
    expect: 'bare package specifier',
  },
  {
    rule: 'test-only package imported from production sim code',
    path: './world.ts',
    src: `import { vi } from 'vitest';\nexport const x = vi;\n`,
    expect: 'test-only package',
  },
  // --- relative specifiers that escape src/sim/ ---
  {
    rule: 'relative escape from the sim root',
    path: './world.ts',
    src: `import { scene } from '../render/scene';\nexport const x = scene;\n`,
    expect: 'escapes src/sim/',
  },
  {
    rule: 'relative escape from a nested sim directory',
    path: './ai/grey.ts',
    src: `import { engine } from '../../audio/engine';\nexport const x = engine;\n`,
    expect: 'escapes src/sim/',
  },
  {
    rule: 'relative escape via a side-effect import',
    path: './world.ts',
    src: `import '../render/scene';\nexport const x = 1;\n`,
    expect: 'escapes src/sim/',
  },

  // --- forbidden globals: one fixture per FORBIDDEN_GLOBALS entry ---
  {
    rule: 'DOM: document',
    path: './world.ts',
    src: `export const el = document.getElementById('hud');\n`,
    expect: 'document',
    covers: 'document',
  },
  {
    rule: 'DOM: window',
    path: './world.ts',
    src: `export const w = window.innerWidth;\n`,
    expect: 'window',
    covers: 'window',
  },
  {
    rule: 'DOM: navigator',
    path: './world.ts',
    src: `export const ua = navigator.userAgent;\n`,
    expect: 'navigator',
    covers: 'navigator',
  },
  {
    rule: 'DOM: localStorage',
    path: './world.ts',
    src: `export const seed = localStorage.getItem('seed');\n`,
    expect: 'localStorage',
    covers: 'localStorage',
  },
  {
    rule: 'escape hatch: globalThis',
    path: './world.ts',
    src: `export const d = globalThis.document;\n`,
    expect: 'globalThis',
    covers: 'globalThis',
  },
  {
    rule: 'escape hatch: self',
    path: './world.ts',
    src: `export const p = self.performance;\n`,
    expect: 'self',
    covers: 'self',
  },
  {
    rule: 'host clock: process.hrtime (the probe that walked past the old guard)',
    path: './world.ts',
    src: `export const t = process.hrtime();\n`,
    expect: 'process',
    covers: 'process',
  },
  {
    rule: 'escape hatch: top',
    path: './world.ts',
    src: `export const w = top.innerWidth;\n`,
    expect: 'top',
    covers: 'top',
  },
  {
    rule: 'escape hatch: parent',
    path: './world.ts',
    src: `export function tell() {\n  parent.postMessage('tick', '*');\n}\n`,
    expect: 'parent',
    covers: 'parent',
  },
  {
    rule: 'I/O: fetch',
    path: './world.ts',
    src: `export async function load(u: string) {\n  return fetch(u);\n}\n`,
    expect: 'fetch',
    covers: 'fetch',
  },
  {
    rule: 'I/O: XMLHttpRequest',
    path: './world.ts',
    src: `export const req = new XMLHttpRequest();\n`,
    expect: 'XMLHttpRequest',
    covers: 'XMLHttpRequest',
  },
  {
    rule: 'concurrency: Worker',
    path: './world.ts',
    src: `export const w = new Worker('./sim-worker.js');\n`,
    expect: 'Worker',
    covers: 'Worker',
  },

  // --- nondeterminism: one fixture per FORBIDDEN_NONDETERMINISM entry ---
  {
    rule: 'nondeterminism: Math.random',
    path: './ai/grey.ts',
    src: `export const jitter = Math.random() * 0.1;\n`,
    expect: 'Math.random',
    covers: 'Math.random',
  },
  {
    rule: 'nondeterminism: Date.now',
    path: './world.ts',
    src: `export const t = Date.now();\n`,
    expect: 'Date.now',
    covers: 'Date.now',
  },
  {
    rule: 'nondeterminism: new Date',
    path: './world.ts',
    src: `export const t = new Date().getTime();\n`,
    expect: 'new Date',
    covers: 'new Date',
  },
  {
    rule: 'nondeterminism: performance',
    path: './world.ts',
    src: `export const t = performance.now();\n`,
    expect: 'performance',
    covers: 'performance',
  },
  {
    rule: 'nondeterminism: crypto',
    path: './world.ts',
    src: `export const id = crypto.randomUUID();\n`,
    expect: 'crypto',
    covers: 'crypto',
  },
  {
    rule: 'nondeterminism: setTimeout',
    path: './round.ts',
    src: `export function endLater() {\n  setTimeout(() => {}, 500);\n}\n`,
    expect: 'setTimeout',
    covers: 'setTimeout',
  },
  {
    rule: 'nondeterminism: setInterval',
    path: './round.ts',
    src: `export function tickLater() {\n  setInterval(() => {}, 16);\n}\n`,
    expect: 'setInterval',
    covers: 'setInterval',
  },
  {
    rule: 'nondeterminism: requestAnimationFrame',
    path: './round.ts',
    src: `export function schedule(cb: () => void) {\n  requestAnimationFrame(cb);\n}\n`,
    expect: 'requestAnimationFrame',
    covers: 'requestAnimationFrame',
  },
  {
    rule: 'nondeterminism: queueMicrotask',
    path: './round.ts',
    src: `export function defer(cb: () => void) {\n  queueMicrotask(cb);\n}\n`,
    expect: 'queueMicrotask',
    covers: 'queueMicrotask',
  },
];

// The mirror image. A guard that flags everything is as useless as one that
// flags nothing -- it just gets disabled instead of ignored. These pin the
// cases the guard MUST stay quiet about, and in particular pin the
// comment-stripping state machine and the resolution-based (not text-based)
// relative-import check, both of which are load-bearing for keeping the real
// scan green.
const CLEAN_FIXTURES: Array<{ rule: string; path: string; src: string }> = [
  {
    rule: 'ordinary sim module: relative imports that stay inside sim/',
    path: './world.ts',
    src: `import { vdist } from './types';\nimport { stepMines } from './mines';\nexport const x = [vdist, stepMines];\n`,
  },
  {
    rule: 'sim test file may import vitest',
    path: './world.test.ts',
    src: `import { describe, it, expect } from 'vitest';\nimport { createWorld } from './world';\ndescribe('w', () => it('x', () => expect(createWorld).toBeDefined()));\n`,
  },
  {
    rule: 'nested sim module climbing to the sim root but no further',
    path: './ai/grey.ts',
    src: `import { vdist } from '../types';\nimport { greyish } from './teal';\nexport const x = [vdist, greyish];\n`,
  },
  {
    rule: 'comments naming forbidden tokens do not false-positive (state machine)',
    path: './world.ts',
    src:
      `// Never use Math.random, window, document, performance or process here.\n` +
      `/* A dynamic import('howler') or require('howler') would break headlessness,\n` +
      `   as would import * as THREE from "thr" + "ee". */\n` +
      `export const x = 1;\n`,
  },
  {
    rule: 'identifiers that merely CONTAIN a forbidden token are fine',
    path: './world.ts',
    src: `const windowSize = 4;\nconst toTop = 1;\nconst documentation = 'x';\nconst parentIndex = 0;\nexport const x = [windowSize, toTop, documentation, parentIndex];\n`,
  },
  {
    // Verbatim shapes from arena.test.ts / ai/targeting.test.ts. These are
    // LOCAL bindings named `top`, not the `window.top` global, and the guard
    // failed on all three when `top` was matched as a bare word.
    rule: '`top` / `parent` / `self` as local identifiers and prose, not globals',
    path: './arena.test.ts',
    src:
      `import { describe, it, expect } from 'vitest';\n` +
      `describe('does not self-destruct in the muzzle; hits the top (maxY) face', () => {\n` +
      `  it('reflects across all four planes (left,right,bottom,top)', () => {\n` +
      `    const boundaries = [{ aabb: { maxY: 0 } }];\n` +
      `    const top = boundaries.find((w) => w.aabb.maxY === 0);\n` +
      `    const parent = top;\n` +
      `    expect(top).toBeDefined();\n` +
      `    expect(top!.aabb).toEqual(parent!.aabb);\n` +
      `  });\n` +
      `});\n`,
  },
  {
    // An ordinary property read that happens to be spelled like a global.
    rule: 'a property named like a forbidden global is not the global',
    path: './world.ts',
    src: `interface N { parent: { id: number } }\nexport function f(n: N) {\n  return n.parent.id;\n}\n`,
  },
];

describe('sim purity guard: meta-test (the detectors actually fire)', () => {
  it.each(FORBIDDEN_FIXTURES.map((f) => [f.rule, f] as const))(
    'flags %s',
    (_rule, fixture) => {
      const violations = scanAll(fixture.path, fixture.src);
      expect(
        violations.length,
        `expected at least one violation for "${fixture.rule}"; the guard reported the fixture CLEAN`
      ).toBeGreaterThanOrEqual(1);
      expect(
        violations.some((v) => v.includes(fixture.expect)),
        `expected a violation mentioning "${fixture.expect}"; got:\n${violations.join('\n')}`
      ).toBe(true);
      // Every message must name the file, or a real failure is unactionable.
      expect(violations.every((v) => v.startsWith(`${fixture.path}:`))).toBe(true);
    }
  );

  it.each(CLEAN_FIXTURES.map((f) => [f.rule, f] as const))(
    'stays quiet for %s',
    (_rule, fixture) => {
      const violations = scanAll(fixture.path, fixture.src);
      expect(violations, violations.join('\n')).toEqual([]);
    }
  );

  // Rule-table coverage. Without this, appending a token to FORBIDDEN_GLOBALS
  // with a typo'd spelling (or a regex that can never match) would add a rule
  // no fixture ever exercises -- silently back to a guard whose new half is
  // unproven.
  it('has one fixture per FORBIDDEN_GLOBALS entry', () => {
    const covered = new Set(FORBIDDEN_FIXTURES.map((f) => f.covers).filter(Boolean));
    for (const { token } of FORBIDDEN_GLOBALS) {
      expect(
        covered.has(token),
        `FORBIDDEN_GLOBALS entry "${token}" has no meta-test fixture`
      ).toBe(true);
    }
  });

  it('has one fixture per FORBIDDEN_NONDETERMINISM entry', () => {
    const covered = new Set(FORBIDDEN_FIXTURES.map((f) => f.covers).filter(Boolean));
    for (const { token } of FORBIDDEN_NONDETERMINISM) {
      expect(
        covered.has(token),
        `FORBIDDEN_NONDETERMINISM entry "${token}" has no meta-test fixture`
      ).toBe(true);
    }
  });

  it('covers every specifier-extraction regex (each import syntax form has a fixture)', () => {
    // Each SPECIFIER_RES entry must match at least one forbidden fixture: if a
    // regex is mistyped so it matches nothing, no specifier written that way
    // ever reaches the classifier and the whole syntax form goes unguarded --
    // which is precisely how side-effect, dynamic and require imports escaped.
    for (const re of SPECIFIER_RES) {
      const matchedSomething = FORBIDDEN_FIXTURES.some((f) => {
        re.lastIndex = 0;
        return [...stripComments(f.src).matchAll(re)].length > 0;
      });
      expect(matchedSomething, `no fixture exercises specifier regex ${re}`).toBe(true);
    }
  });
});
