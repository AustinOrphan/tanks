/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';

// WHY THIS TEST EXISTS:
//
// The layers under `src/` depend in ONE direction (issue #473):
//
//   main.ts / boot.ts      composition roots -- wire everything, owned by nothing
//   game/                  application: sessions, routes, persistence, flags, the HUD
//   render/  audio/  input/  projections and adapters of simulation state and events
//   presentation/          renderer-independent vocabulary the layers above share
//   sim/                   the pure deterministic core (its own guard: sim/purity.test.ts)
//
// Before #473 the middle two rows pulled on each other: `render/entities.ts` was the
// authoritative source of the player-identity colours the HUD painted, five render
// modules imported `game/customization.ts` to name a skin, and the audio director
// imported the developer-flag parser to name a cue. Nothing failed -- TypeScript is
// happy with a cycle of type imports -- so the direction only held while every reviewer
// remembered it. This test makes it mechanical: every module specifier in every `.ts`
// file under `src/` is resolved and classified, and a forbidden direction fails naming
// the file and the import.
//
// Same shape as `src/sim/purity.test.ts`, for the same reason that guard has it: ONE
// classifier that every specifier passes through however it was written, and a
// meta-test suite below that runs the classifier over inline fixtures so a rule that
// silently stopped matching cannot report a clean tree. The purity guard reported green
// for four of five planted escapes until it got its meta-test; this one shipped with its
// own.
//
// KNOWN LIMITS -- this is a text scan, not a parse, and these are the shapes it does not
// see. None occurs under src/ today; a reviewer who meets one should extend the scan or
// the fixtures rather than trust the green:
//   - a dynamic `import()` whose specifier is a template literal or a concatenation
//     (`import(\`../\${layer}/x\`)`) carries no string the specifier regexes can read;
//   - a `from '...'` or `import.meta.glob('...')` INSIDE a string or template literal is
//     read as an import (strings are kept by the comment strip), which is why the two
//     fixture-quoting guards are excluded from the scan;
//   - a regex literal containing `/*` opens a block comment for the strip, hiding the
//     rest of that file from the specifier scan until a `*/` appears;
//   - inline type modifiers (`import { type World } from '../sim/world'`) are treated as
//     a RUNTIME import; the presentation layer must spell its simulation imports
//     `import type { ... }`.

// Raw source of every .ts file under src/ (recursive, eager -- a one-off test-time scan).
const rawModules = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Two files quote forbidden import forms as STRING FIXTURES rather than importing
// anything: this guard and the sim purity guard. Their fixture strings survive comment
// stripping (they are code), so scanning either is a guaranteed false positive. Vite's
// `import.meta.glob` never includes the importing file itself, so this guard is absent
// from `rawModules` already; the purity guard is excluded by name, and the non-vacuity
// check below asserts it still exists so the exclusion cannot outlive the file.
const EXCLUDED_GUARDS = ['./sim/purity.test.ts'];

const files = Object.keys(rawModules).filter((path) => !EXCLUDED_GUARDS.includes(path));

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

type Layer = 'sim' | 'presentation' | 'input' | 'render' | 'audio' | 'game';
const LAYERS: readonly Layer[] = ['sim', 'presentation', 'input', 'render', 'audio', 'game'];

/**
 * Which layers each layer may import from, by RESOLVED target, tests included. A test
 * of a render module that needs a game module to set itself up is the same smell as the
 * render module needing it; the fixtures a projection's tests want belong in sim or in
 * the presentation contract.
 *
 * `game -> render` and `game -> audio` are absent on purpose: they are allowed only from
 * the wiring modules listed in GAME_WIRING, per target module. Everything else the
 * application layer wants from a projection is vocabulary, and vocabulary lives in
 * `presentation/`.
 */
const MAY_IMPORT: Readonly<Record<Layer, ReadonlySet<Layer>>> = {
  sim: new Set<Layer>(['sim']),
  presentation: new Set<Layer>(['presentation', 'sim']),
  input: new Set<Layer>(['input', 'sim']),
  render: new Set<Layer>(['render', 'presentation', 'sim']),
  audio: new Set<Layer>(['audio', 'presentation', 'sim']),
  game: new Set<Layer>(['game', 'presentation', 'input', 'sim']),
};

/**
 * The documented composition imports: application modules that CONSTRUCT or CONFIGURE a
 * projection's own objects, listed by importing file and by the exact module each may
 * reach. Adding a pair here is the review moment -- the question to answer is "is this
 * wiring, or is it vocabulary that belongs in presentation/?".
 *
 * - `loop.ts` builds the renderer, the preview, the audio director and the quality
 *   preset for a session (CLAUDE.md: `main.ts` is wiring only, so the session's wiring
 *   lives here), and forwards the `?mineWarn=` treatment to the renderer it built.
 * - `route-ui.ts` owns the Customize preview's handle above a session (issue #427).
 * - `devflags.ts` validates `?mineWarn=` against the renderer's own option vocabulary: a
 *   renderer-owned treatment a developer flag selects, not player-facing semantics. It
 *   validated `?quality=` the same way until issue #540, and this entry said in advance
 *   what to do if that changed -- "if either becomes a Setting, its NAMES move to
 *   presentation/". Quality became one, `QUALITY_PRESET_IDS` moved to
 *   `presentation/quality.ts`, and `render/quality` left this line. The same offer stands
 *   for `mineWarn`.
 * - `app-shell.ts` builds the page-scoped audio engine from the manifest (issue #317).
 * - `settings.ts` reads the audio manifest's DEFAULT_VOLUME -- the engine's
 *   default, not shared vocabulary. `hud.ts` was listed here for the same import until
 *   issue #324: its Settings slider no longer renders a default value at all, so there is
 *   nothing for it to read.
 *
 * A game TEST file may import any module that SOME entry here lists -- a test of wiring
 * necessarily names what is wired (`loop.test.ts` reads QUALITY_PRESETS to check the
 * renderer got the right one) -- and nothing else. The first version exempted game tests
 * from the list entirely, which left `hud.test.ts` free to keep reading the identity
 * palette out of `render/entities.ts` after the definition had moved.
 */
const GAME_WIRING: Readonly<Record<string, readonly string[]>> = {
  './game/loop.ts': [
    'render/renderer',
    'render/preview',
    'render/quality',
    'render/mine-warning',
    'audio/engine',
    'audio/suites',
    'audio/director',
  ],
  './game/route-ui.ts': ['render/preview'],
  './game/devflags.ts': ['render/mine-warning'],
  './game/app-shell.ts': ['audio/engine', 'audio/manifest'],
  './game/settings.ts': ['audio/manifest'],
};

/** Every module some wiring entry lists: what a game test may reach in render/ or audio/. */
const WIRED_MODULES: ReadonlySet<string> = new Set(Object.values(GAME_WIRING).flat());

/**
 * Packages that ARE a layer's implementation. `three` outside `render/` is a renderer
 * detail leaking into application or contract code -- exactly what #473 forbids the
 * presentation layer from ever carrying. `howler` is the same for `audio/`. Production
 * files only: a test may drive a package directly to probe it.
 */
const PACKAGE_HOME: Readonly<Record<string, Layer>> = {
  three: 'render',
  howler: 'audio',
};

/**
 * Globals the presentation layer may not touch. It is a contract layer: no DOM, no
 * storage, no platform queries -- `game/capabilities.ts` is where the platform is read,
 * and consumers take the answer as an argument.
 */
const PRESENTATION_FORBIDDEN_GLOBALS: ReadonlyArray<{ token: string; re: RegExp }> = [
  { token: 'document', re: /\bdocument\b/ },
  { token: 'window', re: /\bwindow\b/ },
  { token: 'navigator', re: /\bnavigator\b/ },
  { token: 'localStorage', re: /\blocalStorage\b/ },
];

// ---------------------------------------------------------------------------
// Paths and specifiers
// ---------------------------------------------------------------------------

/**
 * The composition roots, as a CLOSED set. Anything else at the top of src/ -- a stray
 * root file, or a new directory such as `shared/` -- is `unclassified`, and the scan
 * reports it as a violation: a new layer has to be placed in LAYERS and MAY_IMPORT before
 * it may import anything, rather than inheriting the roots' exemption by default (the
 * first version of this guard did exactly that, and would have let a `src/shared/`
 * bridge import game and render alike).
 */
const ROOT_FILES: ReadonlySet<string> = new Set([
  './main.ts',
  './boot.ts',
  './boot.test.ts',
  './dependency-direction.test.ts',
]);

type Placement = Layer | 'root' | 'unclassified';

function layerOf(path: string): Placement {
  if (ROOT_FILES.has(path)) return 'root';
  const segments = path.replace(/^\.\//, '').split('/');
  if (segments.length === 1) return 'unclassified';
  return (LAYERS as readonly string[]).includes(segments[0]) ? (segments[0] as Layer) : 'unclassified';
}

function isTestFile(path: string): boolean {
  return /\.test\.ts$/.test(path);
}

/**
 * Resolve a relative specifier against the importing file to a src-relative module path
 * with no extension or query -- `'../render/entities'` from `./game/hud.ts` is
 * `'render/entities'`, `'./hud.css?raw'` from the same file is `'game/hud.css'`.
 * Returns null when the specifier climbs out of src/.
 *
 * Resolution-based rather than text-based, the lesson purity.test.ts records: from
 * `./sim/ai/grey.ts` the text `'../render'` is `sim/render` and perfectly fine.
 */
function resolveInsideSrc(path: string, specifier: string): string | null {
  const segments = path.replace(/^\.\//, '').split('/');
  segments.pop(); // the importing file's directory
  const clean = specifier.replace(/[?#].*$/, '');
  for (const part of clean.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  const joined = segments.join('/');
  return joined.replace(/\.(ts|js|mjs|json)$/, '');
}

/**
 * Placement of a RESOLVED module path such as `render/entities`, `game` (a directory
 * index import, `'../game'`), `sim/ai` or `boot`. A bare layer name, or anything under
 * it, is that layer -- the earlier form fed `'../game'` through `layerOf` as `./game.ts`,
 * a single-segment path, and called it root.
 */
function layerOfModule(module: string): Placement {
  const head = module.split('/')[0];
  if ((LAYERS as readonly string[]).includes(head)) return head as Layer;
  return ROOT_FILES.has(`./${module}.ts`) ? 'root' : 'unclassified';
}

/** The directory an `import.meta.glob` pattern starts in: everything before its first `*`. */
function globPrefix(pattern: string): string {
  const star = pattern.indexOf('*');
  return star === -1 ? pattern : pattern.slice(0, star);
}

interface Specifier {
  specifier: string;
  form: 'static' | 'side-effect' | 'dynamic' | 'require' | 'glob';
  /** `import type ... from` / `export type ... from`: erased at compile time. */
  typeOnly: boolean;
}

/**
 * Every module specifier in comment-stripped source, however it is written. The first
 * four forms are the ones purity.test.ts learned the hard way: `from`-only matching
 * missed side-effect, dynamic and require imports entirely. The fifth, Vite's
 * `import.meta.glob`, loads a whole directory and is classified by that directory.
 * Whitespace before the specifier is optional throughout: `from"x"` is legal.
 *
 * For the static form the statement's HEAD is found by walking back to the nearest
 * `import`/`export` keyword: an import clause never contains either word, so the
 * nearest one is the statement's own, and `type` directly after it is what makes the
 * import erasable. This is what lets the presentation layer name simulation TYPES
 * without being allowed to call simulation CODE.
 */
function specifiersOf(codeOnly: string): Specifier[] {
  const out: Specifier[] = [];
  for (const m of codeOnly.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    const head = codeOnly.slice(Math.max(0, m.index - 4000), m.index);
    let typeOnly = false;
    for (const k of head.matchAll(/\b(?:import|export)(\s+type)?\b/g)) typeOnly = k[1] !== undefined;
    out.push({ specifier: m[1], form: 'static', typeOnly });
  }
  for (const m of codeOnly.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    out.push({ specifier: m[1], form: 'side-effect', typeOnly: false });
  }
  for (const m of codeOnly.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ specifier: m[1], form: 'dynamic', typeOnly: false });
  }
  for (const m of codeOnly.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ specifier: m[1], form: 'require', typeOnly: false });
  }
  for (const m of codeOnly.matchAll(/\bimport\.meta\.glob\s*\(\s*['"]([^'"]+)['"]/g)) {
    out.push({ specifier: m[1], form: 'glob', typeOnly: false });
  }
  return out;
}

/**
 * Line/block comment strip that tracks string and template literals, so a comment that
 * QUOTES a forbidden import (several modules explain the rule they obey) is not a
 * violation. Same state machine as purity.test.ts; newlines are preserved.
 */
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
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
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
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (c === '\\') {
      out += c + c2;
      i += 2;
      continue;
    }
    if (c === quote) state = 'code';
    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE classifier
// ---------------------------------------------------------------------------

/**
 * A human-readable reason the import is forbidden, or null when it is allowed. `layer`
 * is the importing file's placement; `scan` reports an unclassified file before this
 * is ever reached.
 */
function classify(path: string, layer: Layer | 'root', spec: Specifier): string | null {
  const test = isTestFile(path);
  const s = spec.specifier;

  if (s.startsWith('/')) {
    return `root-absolute import "${s}" (Vite resolves a leading "/" against the project root, bypassing every layer rule)`;
  }

  if (s.startsWith('.')) {
    // A glob is classified by the directory it starts in: `'./*.ts'` from a file in
    // audio/ is audio, `'../game/*.ts'` from render/ is game.
    const target = resolveInsideSrc(path, spec.form === 'glob' ? globPrefix(s) : s);
    // A test may read any fixture (`index-html.test.ts` reads the real index.html) and
    // may drive the composition root (`loop.test.ts` boots the page). Production code
    // may do neither.
    if (target === null) return test ? null : `import "${s}" escapes src/`;
    if (layer === 'root') return null; // a composition root may wire anything
    const targetLayer = layerOfModule(target);
    if (targetLayer === 'unclassified') {
      return `import "${s}" reaches "${target}", which is in no layer: add its directory to LAYERS and MAY_IMPORT`;
    }
    if (targetLayer === 'root') {
      return test ? null : `import "${s}" reaches a composition root; nothing below main.ts/boot.ts may depend on them`;
    }
    if (MAY_IMPORT[layer].has(targetLayer)) {
      if (layer === 'presentation' && targetLayer === 'sim' && !test) {
        if (spec.form !== 'static' || !spec.typeOnly) {
          return `runtime import "${s}" of the simulation from the presentation layer (only \`import type { ... }\` is allowed there: shapes, never step or mutation code)`;
        }
      }
      return null;
    }
    if (layer === 'game' && (targetLayer === 'render' || targetLayer === 'audio')) {
      if (test) {
        return WIRED_MODULES.has(target)
          ? null
          : `game test imports "${target}" from ${targetLayer}: not a wired module -- a test may name what a wiring module wires, and nothing else`;
      }
      const allowed = GAME_WIRING[path] ?? [];
      if (allowed.includes(target)) return null;
      return `game module imports "${target}" from ${targetLayer}: not a listed wiring import in GAME_WIRING -- if this is vocabulary, define it under src/presentation/`;
    }
    return `${layer} may not import ${targetLayer} ("${s}")`;
  }

  // Bare specifier: a package or a Node builtin.
  const pkg = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
  if (!test) {
    const home = PACKAGE_HOME[pkg];
    if (home !== undefined && layer !== home) {
      return `package "${s}" is ${home}'s implementation and may not be imported from ${layer}`;
    }
    if (layer === 'presentation') {
      return `bare package "${s}" in the presentation layer, which carries no dependencies`;
    }
  }
  return null;
}

function scan(path: string, src: string): string[] {
  const violations: string[] = [];
  const layer = layerOf(path);
  if (layer === 'unclassified') {
    const head = path.replace(/^\.\//, '').split('/');
    const what = head.length > 1 ? `directory "${head[0]}/"` : 'file at the root of src/';
    violations.push(`${path}: unclassified ${what}: add it to LAYERS and MAY_IMPORT, or to ROOT_FILES if it is a composition root`);
    return violations;
  }
  const codeOnly = stripComments(src);
  for (const spec of specifiersOf(codeOnly)) {
    const reason = classify(path, layer, spec);
    if (reason !== null) violations.push(`${path}: ${reason}`);
  }
  if (layerOf(path) === 'presentation') {
    for (const { token, re } of PRESENTATION_FORBIDDEN_GLOBALS) {
      if (re.test(codeOnly)) violations.push(`${path}: forbidden reference to "${token}" in the presentation layer`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('dependency direction across src/ layers', () => {
  it('discovered a plausible set of files (non-vacuity check)', () => {
    // A narrowed glob would loop zero times below and report a clean tree. Floor plus
    // one known file per layer, and the two excluded guards must still exist -- an
    // exclusion outliving its file is a hole nobody would notice.
    expect(files.length).toBeGreaterThanOrEqual(60);
    for (const suffix of [
      'main.ts',
      'game/loop.ts',
      'render/entities.ts',
      'audio/director.ts',
      'input/input.ts',
      'presentation/identity.ts',
      'sim/world.ts',
    ]) {
      expect(files.some((p) => p.endsWith(suffix)), `expected a file ending in "${suffix}"`).toBe(true);
    }
    for (const excluded of EXCLUDED_GUARDS) {
      expect(excluded in rawModules, `${excluded} is excluded but no longer exists`).toBe(true);
    }
    expect('./dependency-direction.test.ts' in rawModules, 'the glob included this guard itself').toBe(false);
    // Every scanned file sits in a layer or is a listed composition root. The sweep
    // reports the same condition per file; this states it as a property of the tree.
    for (const path of files) {
      expect(layerOf(path) !== 'unclassified', `${path} is in no layer and is not a listed composition root`).toBe(true);
    }
  });

  it('every import in src/ points down the layer order, or is a listed wiring import', () => {
    const violations: string[] = [];
    for (const path of files) violations.push(...scan(path, rawModules[path]));
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every GAME_WIRING entry names a real file and an import that file actually makes', () => {
    // An allowlist entry nothing uses is a permission waiting to be picked up by the
    // next edit. When a wiring import goes, its entry goes with it -- as `hud.ts`'s did
    // when issue #324 removed its DEFAULT_VOLUME read.
    for (const [path, targets] of Object.entries(GAME_WIRING)) {
      expect(path in rawModules, `GAME_WIRING lists ${path}, which does not exist`).toBe(true);
      const imported = new Set(
        specifiersOf(stripComments(rawModules[path]))
          .map((spec) => resolveInsideSrc(path, spec.specifier))
          .filter((t): t is string => t !== null),
      );
      for (const target of targets) {
        expect(
          ['render', 'audio'].includes(layerOfModule(target)),
          `GAME_WIRING allows ${path} -> ${target}, which is not a render or audio module`,
        ).toBe(true);
        expect(imported.has(target), `GAME_WIRING allows ${path} -> ${target}, but ${path} does not import it`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// META-TEST: does the guard actually DETECT anything?
// ---------------------------------------------------------------------------
//
// The sweep asserts `violations === []` over the real tree, which a broken classifier
// satisfies just as well as a clean tree. These fixtures are INLINE strings run through
// the same `scan`; none is derived from the rule tables above, because a fixture list
// generated from MAY_IMPORT would shrink in step with any hole opened in it. The
// coverage test at the end ties the two together: every forbidden layer pair has a
// hand-written forbidden fixture, and every allowed pair a hand-written clean one.

interface Fixture {
  rule: string;
  path: string;
  src: string;
  /** A substring the violation message must contain. */
  expect: string;
  /** The (importing layer, target layer) pair this fixture pins, for the coverage test. */
  pair?: [Layer, Layer];
}

const FORBIDDEN_FIXTURES: Fixture[] = [
  // --- every forbidden layer pair, by hand, one each ---
  { rule: 'sim -> presentation', path: './sim/world.ts', src: `import { TEAM_COLORS } from '../presentation/identity';\nexport const x = TEAM_COLORS;\n`, expect: 'sim may not import presentation', pair: ['sim', 'presentation'] },
  { rule: 'sim -> input', path: './sim/world.ts', src: `import { createInput } from '../input/input';\nexport const x = createInput;\n`, expect: 'sim may not import input', pair: ['sim', 'input'] },
  { rule: 'sim -> render', path: './sim/world.ts', src: `import { createScene } from '../render/scene';\nexport const x = createScene;\n`, expect: 'sim may not import render', pair: ['sim', 'render'] },
  { rule: 'sim -> audio', path: './sim/ai/grey.ts', src: `import { createAudioEngine } from '../../audio/engine';\nexport const x = createAudioEngine;\n`, expect: 'sim may not import audio', pair: ['sim', 'audio'] },
  { rule: 'sim -> game', path: './sim/world.ts', src: `import { parseDevFlags } from '../game/devflags';\nexport const x = parseDevFlags;\n`, expect: 'sim may not import game', pair: ['sim', 'game'] },
  { rule: 'presentation -> input', path: './presentation/identity.ts', src: `import type { Assignment } from '../input/assignment';\nexport type A = Assignment;\n`, expect: 'presentation may not import input', pair: ['presentation', 'input'] },
  { rule: 'presentation -> render (the renderer is an implementation, not a contract)', path: './presentation/customization.ts', src: `import { createSkinTexture } from '../render/skins';\nexport const x = createSkinTexture;\n`, expect: 'presentation may not import render', pair: ['presentation', 'render'] },
  { rule: 'presentation -> audio', path: './presentation/blocked-fire.ts', src: `import { DEFAULT_VOLUME } from '../audio/manifest';\nexport const x = DEFAULT_VOLUME;\n`, expect: 'presentation may not import audio', pair: ['presentation', 'audio'] },
  { rule: 'presentation -> game (session orchestration and persistence stay above)', path: './presentation/customization.ts', src: `import { createCustomizationStore } from '../game/customization';\nexport const x = createCustomizationStore;\n`, expect: 'presentation may not import game', pair: ['presentation', 'game'] },
  { rule: 'input -> presentation', path: './input/touch.ts', src: `import { TEAM_COLORS } from '../presentation/identity';\nexport const x = TEAM_COLORS;\n`, expect: 'input may not import presentation', pair: ['input', 'presentation'] },
  { rule: 'input -> render', path: './input/touch.ts', src: `import { bootCanvas } from '../render/canvas';\nexport const x = bootCanvas;\n`, expect: 'input may not import render', pair: ['input', 'render'] },
  { rule: 'input -> audio', path: './input/gamepad.ts', src: `import { createAudioEngine } from '../audio/engine';\nexport const x = createAudioEngine;\n`, expect: 'input may not import audio', pair: ['input', 'audio'] },
  { rule: 'input -> game', path: './input/assignment.ts', src: `import type { DevFlags } from '../game/devflags';\nexport type F = DevFlags;\n`, expect: 'input may not import game', pair: ['input', 'game'] },
  { rule: 'render -> input', path: './render/renderer.ts', src: `import { createInput } from '../input/input';\nexport const x = createInput;\n`, expect: 'render may not import input', pair: ['render', 'input'] },
  { rule: 'render -> audio', path: './render/renderer.ts', src: `import { createAudioDirector } from '../audio/director';\nexport const x = createAudioDirector;\n`, expect: 'render may not import audio', pair: ['render', 'audio'] },
  {
    // The shape #473 removed: five render modules named a skin through the game layer.
    rule: 'render -> game (the pre-#473 customization import, even as a type)',
    path: './render/skins.ts',
    src: `import type { SkinId } from '../game/customization';\nexport type S = SkinId;\n`,
    expect: 'render may not import game',
    pair: ['render', 'game'],
  },
  { rule: 'audio -> input', path: './audio/director.ts', src: `import { createInput } from '../input/input';\nexport const x = createInput;\n`, expect: 'audio may not import input', pair: ['audio', 'input'] },
  { rule: 'audio -> render', path: './audio/director.ts', src: `import { createScene } from '../render/scene';\nexport const x = createScene;\n`, expect: 'audio may not import render', pair: ['audio', 'render'] },
  {
    rule: 'audio -> game (the pre-#473 blocked-fire cue import)',
    path: './audio/director.ts',
    src: `import type { BlockedFireCue } from '../game/devflags';\nexport type C = BlockedFireCue;\n`,
    expect: 'audio may not import game',
    pair: ['audio', 'game'],
  },
  {
    // The shape #473 removed on the other side: an application module learning a colour
    // from a Three.js module. route-ui.ts IS in GAME_WIRING (for render/preview), so this
    // also pins that the allowlist is per target module, not per file -- a listed file
    // may still not reach a module its entry does not name.
    //
    // This fixture used hud.ts until issue #324 removed that file's last audio import and
    // with it its wiring entry; hud.ts is no longer listed at all, so it could no longer
    // carry the per-target-module half of the claim.
    rule: 'game -> render from a non-wiring import (the pre-#473 identity import)',
    path: './game/route-ui.ts',
    src: `import { IDENTITY_RING_COLORS } from '../render/entities';\nexport const x = IDENTITY_RING_COLORS;\n`,
    expect: 'not a listed wiring import',
    pair: ['game', 'render'],
  },
  {
    rule: 'game -> audio from a file with no wiring entry',
    path: './game/haptics.ts',
    src: `import { createAudioEngine } from '../audio/engine';\nexport const x = createAudioEngine;\n`,
    expect: 'not a listed wiring import',
    pair: ['game', 'audio'],
  },

  // --- placement is closed: no directory or root file is exempt by default ---
  {
    rule: 'a new top-level directory (no layer, no exemption) importing game and render',
    path: './shared/bridge.ts',
    src: `import { createHud } from '../game/hud';\nimport { createScene } from '../render/scene';\nexport const x = [createHud, createScene];\n`,
    expect: 'unclassified directory "shared/"',
  },
  {
    rule: 'a stray file at the root of src/ that is not a listed composition root',
    path: './helpers.ts',
    src: `export const x = 1;\n`,
    expect: 'unclassified file at the root',
  },
  {
    rule: 'an import reaching a directory that is in no layer',
    path: './game/loop.ts',
    src: `import { bridge } from '../shared/bridge';\nexport const x = bridge;\n`,
    expect: 'in no layer',
  },
  {
    rule: 'a directory-index import of game (`../game`, not `../game/x`)',
    path: './render/skins.test.ts',
    src: `import { createHud } from '../game';\nexport const x = createHud;\n`,
    expect: 'render may not import game',
  },

  // --- the wiring allowlist is exact, for tests as well ---
  {
    rule: 'a game TEST reaching a render module no wiring entry lists',
    path: './game/hud.test.ts',
    src: `import { describe } from 'vitest';\nimport { IDENTITY_RING_COLORS } from '../render/entities';\nexport const x = [describe, IDENTITY_RING_COLORS];\n`,
    expect: 'not a wired module',
  },
  {
    rule: 'a wiring file reaching a render module it is not listed for',
    path: './game/loop.ts',
    src: `import { resolveOwnerColor } from '../render/entities';\nexport const x = resolveOwnerColor;\n`,
    expect: 'not a listed wiring import',
  },

  // --- the presentation layer carries nothing but shapes ---
  {
    rule: 'presentation importing simulation CODE rather than a type',
    path: './presentation/identity.ts',
    src: `import { createWorld } from '../sim/world';\nexport const x = createWorld;\n`,
    expect: 'runtime import',
  },
  {
    rule: 'presentation importing the simulation as a side effect',
    path: './presentation/identity.ts',
    src: `import '../sim/world';\nexport const x = 1;\n`,
    expect: 'runtime import',
  },
  {
    rule: 'presentation importing three',
    path: './presentation/identity.ts',
    src: `import * as THREE from 'three';\nexport const c = new THREE.Color(1, 1, 1);\n`,
    expect: 'three',
  },
  {
    rule: 'presentation importing any package at all',
    path: './presentation/customization.ts',
    src: `import chroma from 'chroma-js';\nexport const x = chroma;\n`,
    expect: 'bare package',
  },
  {
    rule: 'presentation touching the DOM',
    path: './presentation/identity.ts',
    src: `export const el = document.getElementById('hud');\n`,
    expect: 'document',
  },
  {
    rule: 'presentation reading storage',
    path: './presentation/customization.ts',
    src: `export const raw = localStorage.getItem('tanks.custom.v1');\n`,
    expect: 'localStorage',
  },

  // --- implementation packages stay in their layer ---
  {
    rule: 'three imported from the application layer',
    path: './game/hud.ts',
    src: `import { Color } from 'three';\nexport const c = new Color();\n`,
    expect: "render's implementation",
  },
  {
    rule: 'a three subpath imported from the application layer',
    path: './game/loop.ts',
    src: `import { Vector3 } from 'three/src/math/Vector3.js';\nexport const v = new Vector3();\n`,
    expect: "render's implementation",
  },
  {
    rule: 'howler imported from the renderer',
    path: './render/renderer.ts',
    src: `import { Howl } from 'howler';\nexport const h = Howl;\n`,
    expect: "audio's implementation",
  },

  // --- import syntax forms and escapes (the ones the purity guard once missed) ---
  {
    rule: 'side-effect import (no `from` keyword)',
    path: './render/skins.ts',
    src: `import '../game/customization';\nexport const x = 1;\n`,
    expect: 'render may not import game',
  },
  {
    rule: 'no whitespace before the specifier (the minified spelling)',
    path: './audio/director.ts',
    src: `import { parseDevFlags } from"../game/devflags";\nimport"../game/haptics";\nexport const x = parseDevFlags;\n`,
    expect: 'audio may not import game',
  },
  {
    rule: 'import.meta.glob reaching another layer',
    path: './render/skins.ts',
    src: `export const modules = import.meta.glob('../game/*.ts');\n`,
    expect: 'render may not import game',
  },
  {
    rule: 'import.meta.glob of the simulation from the presentation layer (a runtime load)',
    path: './presentation/identity.ts',
    src: `export const modules = import.meta.glob('../sim/*.ts');\n`,
    expect: 'runtime import',
  },
  {
    rule: 'dynamic import',
    path: './audio/director.ts',
    src: `export async function cue() {\n  const m = await import('../game/devflags');\n  return m;\n}\n`,
    expect: 'audio may not import game',
  },
  {
    rule: 'CommonJS require',
    path: './render/skins.ts',
    src: `const c = require('../game/customization');\nexport const x = c;\n`,
    expect: 'render may not import game',
  },
  {
    rule: 'Vite root-absolute specifier',
    path: './render/skins.ts',
    src: `export { SKINS } from '/src/game/customization';\n`,
    expect: 'root-absolute',
  },
  {
    rule: 'an import that climbs out of src/',
    path: './game/loop.ts',
    src: `import { x } from '../../tools/gallery/subjects';\nexport const y = x;\n`,
    expect: 'escapes src/',
  },
  {
    rule: 'a layer depending on a composition root',
    path: './game/loop.ts',
    src: `import { boot } from '../boot';\nexport const x = boot;\n`,
    expect: 'composition root',
  },
];

const CLEAN_FIXTURES: Fixture[] = [
  // --- every allowed layer pair, by hand, one each ---
  { rule: 'sim -> sim', path: './sim/world.ts', src: `import { stepMines } from './mines';\nexport const x = stepMines;\n`, expect: '', pair: ['sim', 'sim'] },
  { rule: 'presentation -> presentation', path: './presentation/identity.ts', src: `import { SKINS } from './customization';\nexport const x = SKINS;\n`, expect: '', pair: ['presentation', 'presentation'] },
  { rule: 'presentation -> sim as `import type` (the one form allowed)', path: './presentation/identity.ts', src: `import type { World } from '../sim/world';\nimport type { Tank } from '../sim/types';\nexport function f(w: World, t: Tank): number { return w.mode === 'teams' ? t.team ?? 0 : 0; }\n`, expect: '', pair: ['presentation', 'sim'] },
  { rule: 'input -> input', path: './input/input.ts', src: `import { stickVector } from './touch';\nexport const x = stickVector;\n`, expect: '', pair: ['input', 'input'] },
  { rule: 'input -> sim', path: './input/input.ts', src: `import type { InputState } from '../sim/types';\nimport { createWorld } from '../sim/world';\nexport const x: [InputState | null, unknown] = [null, createWorld];\n`, expect: '', pair: ['input', 'sim'] },
  { rule: 'render -> render', path: './render/entities.ts', src: `import { createSkinTexture } from './skins';\nexport const x = createSkinTexture;\n`, expect: '', pair: ['render', 'render'] },
  { rule: 'render -> presentation (the post-#473 shape)', path: './render/entities.ts', src: `import { skinScroll, type SkinId } from '../presentation/customization';\nimport { resolveOwnerColor } from '../presentation/identity';\nexport const x = [skinScroll, resolveOwnerColor];\nexport type S = SkinId;\n`, expect: '', pair: ['render', 'presentation'] },
  { rule: 'render -> sim, runtime included', path: './render/entities.ts', src: `import { blastRadiusAt } from '../sim/mines';\nimport type { World } from '../sim/world';\nexport const x = blastRadiusAt;\nexport type W = World;\n`, expect: '', pair: ['render', 'sim'] },
  { rule: 'audio -> audio', path: './audio/director.ts', src: `import type { AudioEngine } from './engine';\nexport type E = AudioEngine;\n`, expect: '', pair: ['audio', 'audio'] },
  { rule: 'audio -> presentation (the post-#473 shape)', path: './audio/director.ts', src: `import type { BlockedFireCue } from '../presentation/blocked-fire';\nexport type C = BlockedFireCue;\n`, expect: '', pair: ['audio', 'presentation'] },
  { rule: 'audio -> sim', path: './audio/director.ts', src: `import type { SimEvent } from '../sim/events';\nexport type E = SimEvent;\n`, expect: '', pair: ['audio', 'sim'] },
  { rule: 'game -> game', path: './game/hud.ts', src: `import { createTransitionRunner } from './transitions';\nexport const x = createTransitionRunner;\n`, expect: '', pair: ['game', 'game'] },
  { rule: 'game -> presentation (the post-#473 shape)', path: './game/hud.ts', src: `import { IDENTITY_RING_COLORS, TEAM_COLORS, TEAM_LABELS } from '../presentation/identity';\nimport { PALETTE } from '../presentation/customization';\nexport const x = [IDENTITY_RING_COLORS, TEAM_COLORS, TEAM_LABELS, PALETTE];\n`, expect: '', pair: ['game', 'presentation'] },
  { rule: 'game -> input', path: './game/loop.ts', src: `import { reassign } from '../input/assignment';\nexport const x = reassign;\n`, expect: '', pair: ['game', 'input'] },
  { rule: 'game -> sim', path: './game/loop.ts', src: `import { TICK_HZ } from '../sim/constants';\nexport const x = TICK_HZ;\n`, expect: '', pair: ['game', 'sim'] },

  // --- documented wiring ---
  { rule: 'loop.ts constructing the renderer and the audio director', path: './game/loop.ts', src: `import { createRenderer } from '../render/renderer';\nimport { createAudioDirector } from '../audio/director';\nexport const x = [createRenderer, createAudioDirector];\n`, expect: '' },
  { rule: 'devflags.ts validating a flag against the renderer\'s option set', path: './game/devflags.ts', src: `import { MINE_WARN_STYLES } from '../render/mine-warning';\nexport const x = MINE_WARN_STYLES;\n`, expect: '' },
  { rule: 'main.ts, the composition root, wiring the canvas', path: './main.ts', src: `import { bootCanvas } from './render/canvas';\nimport { boot } from './boot';\nexport const x = [bootCanvas, boot];\n`, expect: '' },
  { rule: 'boot.test.ts driving the composition root', path: './boot.test.ts', src: `import { describe } from 'vitest';\nimport { boot } from './boot';\nimport { createHud } from './game/hud';\nexport const x = [describe, boot, createHud];\n`, expect: '' },
  { rule: 'a game TEST naming what its wiring wires', path: './game/loop.test.ts', src: `import { describe } from 'vitest';\nimport { QUALITY_PRESETS } from '../render/quality';\nexport const x = [describe, QUALITY_PRESETS];\n`, expect: '' },
  { rule: 'a game TEST driving the composition root', path: './game/loop.test.ts', src: `import { boot as bootPage } from '../boot';\nexport const x = bootPage;\n`, expect: '' },
  { rule: 'a TEST reading a fixture outside src/', path: './game/index-html.test.ts', src: `import html from '../../index.html?raw';\nexport const x = html;\n`, expect: '' },
  { rule: 'an inline import() TYPE of a listed wiring module', path: './game/loop.ts', src: `export interface Opts {\n  mineWarn?: import('../render/mine-warning').MineWarnStyle | null;\n}\n`, expect: '' },
  { rule: 'a presentation TEST calling into the simulation to check the catalog', path: './presentation/customization.test.ts', src: `import { describe } from 'vitest';\nimport { GAME_TANK_DEFS } from '../sim/config/roster';\nexport const x = [describe, GAME_TANK_DEFS];\n`, expect: '' },

  // --- packages in their home layer, and tests probing packages ---
  { rule: 'three in the renderer', path: './render/scene.ts', src: `import * as THREE from 'three';\nexport const s = new THREE.Scene();\n`, expect: '' },
  { rule: 'howler in the audio engine', path: './audio/engine.ts', src: `import { Howl, Howler } from 'howler';\nexport const x = [Howl, Howler];\n`, expect: '' },
  { rule: 'a game TEST probing three directly', path: './game/render-capability.test.ts', src: `import * as THREE from 'three';\nexport const r = THREE.WebGLRenderer;\n`, expect: '' },

  // --- glob and directory-index forms that stay inside an allowed layer ---
  {
    rule: 'import.meta.glob within its own layer (the shape audio/imports.test.ts uses)',
    path: './audio/imports.test.ts',
    src: `export const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true });\n`,
    expect: '',
  },
  {
    rule: 'a directory-index import inside an allowed layer (`../sim/ai`)',
    path: './game/loop.ts',
    src: `import { decideAi } from '../sim/ai';\nexport const x = decideAi;\n`,
    expect: '',
  },

  // --- the strip and the resolver ---
  {
    rule: 'comments quoting forbidden imports (the rule explaining itself)',
    path: './render/skins.ts',
    src:
      `// Never \`import { SkinId } from '../game/customization'\` here; it lives in presentation now.\n` +
      `/* A require('../game/devflags') or import('../game/devflags') would be the same break,\n` +
      `   and so would document.getElementById. */\n` +
      `export const x = 1;\n`,
    expect: '',
  },
  {
    rule: 'text that merely looks like an import (Array.from, a string mentioning game)',
    path: './render/skins.ts',
    src: `export const a = Array.from('abc');\nexport const msg = 'the game layer is above render';\n`,
    expect: '',
  },
  {
    rule: 'a nested sim module climbing to the sim root (text says `../render`, resolution says sim)',
    path: './sim/ai/grey.ts',
    src: `import { lineOfSight } from '../render';\nexport const x = lineOfSight;\n`,
    expect: '',
  },
  {
    rule: 'a stylesheet import with a query',
    path: './game/hud.ts',
    src: `import css from './hud.css?raw';\nexport const x = css;\n`,
    expect: '',
  },
];

describe('dependency direction: meta-test (the classifier actually fires)', () => {
  it.each(FORBIDDEN_FIXTURES.map((f) => [f.rule, f] as const))('flags %s', (_rule, fixture) => {
    const violations = scan(fixture.path, fixture.src);
    expect(
      violations.length,
      `expected at least one violation for "${fixture.rule}"; the guard reported the fixture CLEAN`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      violations.some((v) => v.includes(fixture.expect)),
      `expected a violation mentioning "${fixture.expect}"; got:\n${violations.join('\n')}`,
    ).toBe(true);
    expect(violations.every((v) => v.startsWith(`${fixture.path}:`))).toBe(true);
  });

  it.each(CLEAN_FIXTURES.map((f) => [f.rule, f] as const))('stays quiet for %s', (_rule, fixture) => {
    const violations = scan(fixture.path, fixture.src);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('has a hand-written fixture on both sides of every layer pair', () => {
    // Population: all 36 ordered pairs of the 6 layers -- 15 allowed by MAY_IMPORT and
    // 21 forbidden. Widening MAY_IMPORT (the mutation that opens a reverse dependency)
    // fails here for want of a clean fixture AND above, where the pair's forbidden
    // fixture is reported clean; narrowing it fails the sweep on the real tree.
    const forbidden = new Set(FORBIDDEN_FIXTURES.filter((f) => f.pair).map((f) => f.pair!.join(' -> ')));
    const clean = new Set(CLEAN_FIXTURES.filter((f) => f.pair).map((f) => f.pair!.join(' -> ')));
    let allowedCount = 0;
    for (const from of LAYERS) {
      for (const to of LAYERS) {
        const key = `${from} -> ${to}`;
        if (MAY_IMPORT[from].has(to)) {
          allowedCount++;
          expect(clean.has(key), `allowed pair ${key} has no clean fixture`).toBe(true);
          expect(forbidden.has(key), `allowed pair ${key} has a forbidden fixture`).toBe(false);
        } else {
          expect(forbidden.has(key), `forbidden pair ${key} has no forbidden fixture`).toBe(true);
          expect(clean.has(key), `forbidden pair ${key} has a clean fixture`).toBe(false);
        }
      }
    }
    expect(allowedCount).toBe(15);
  });

  it('exercises every specifier syntax form the extractor knows', () => {
    const forms = new Set(FORBIDDEN_FIXTURES.flatMap((f) => specifiersOf(f.src).map((s) => s.form)));
    expect([...forms].sort()).toEqual(['dynamic', 'glob', 'require', 'side-effect', 'static']);
  });

  it('has one fixture per PRESENTATION_FORBIDDEN_GLOBALS entry it can reach, and the strip works', () => {
    // `window` and `navigator` share the mechanism with `document`; the two fixtures
    // above pin the mechanism and this pins that every listed token actually fires.
    for (const { token } of PRESENTATION_FORBIDDEN_GLOBALS) {
      const hit = scan('./presentation/identity.ts', `export const x = ${token}.foo;\n`);
      expect(hit.some((v) => v.includes(token)), `"${token}" did not fire`).toBe(true);
    }
    expect(scan('./presentation/identity.ts', `// window, document, navigator, localStorage\nexport const x = 1;\n`)).toEqual([]);
  });
});
