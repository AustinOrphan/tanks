/**
 * Third-party source vendored into `src/` (issue #771), and the files that only look like it.
 *
 * `render.mjs` lists runtime dependencies from `node_modules`, which covers code that arrives
 * through npm. Three files under `src/sim/math` did not: they are ports of fdlibm and of V8,
 * made so the simulation's trigonometry is bit-identical in every engine (issue #133). Their
 * notices are preserved in the files' own headers, but `CONTENT-LICENSE.md` classified all of
 * `src/**` as first-party code under `LICENSE`, and the generated notices never mentioned them.
 *
 * The typefaces in `src/game/fonts/` are the same case in a different form (issue #294's cutover
 * audit): woff2 files copied unchanged from @fontsource packages, under the SIL Open Font License
 * 1.1, which requires its text and each face's copyright line to travel with every copy. The
 * build emits all six files into dist/, the developer-only faces included, so every one is listed.
 *
 * This module is the one declared list both surfaces are checked against:
 * `vendored.test.ts` fails when a file carrying a third-party provenance marker is on neither
 * list below, when a font file in `src/game/fonts/` is not declared, and when
 * `CONTENT-LICENSE.md` stops naming a vendored file.
 *
 * NOT LEGAL ADVICE. It records where code came from and which notice travels with it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The provenance markers the guard scans for. A file that contains one is either vendored or
 * explicitly first-party below.
 */
export const PROVENANCE_MARKERS = Object.freeze([
  /Sun Microsystems/,
  /\bV8\b/,
  /\bfdlibm\b/,
  /\bnetlib\b/,
  /transliterat/i,
  /\bported\b/i,
]);

/**
 * Where each vendored body of code or typeface came from, which files carry it, and its notice.
 *
 * `notice.fromHeaderOf` reads the notice out of that file's own header, between the fdlibm
 * `=====` rules, so the text in THIRD-PARTY-NOTICES.md is quoted from the source rather than
 * retyped. `notice.file` is a license stored verbatim as a file: V8's beside this module, and
 * each typeface's beside its font files, as its package ships it. A font's package and version
 * are also in `src/game/fonts/README.md`, and the test holds the two to each other.
 */
export const VENDORED_SOURCES = Object.freeze([
  Object.freeze({
    name: 'fdlibm',
    origin:
      "netlib.org/fdlibm's s_sin.c, s_cos.c, k_sin.c, k_cos.c, s_atan.c, e_atan2.c, " +
      'e_rem_pio2.c and k_rem_pio2.c, ported line-by-line',
    files: Object.freeze(['src/sim/math/trig.ts', 'src/sim/math/rem-pio2.ts']),
    license: 'permission notice',
    notice: Object.freeze({ fromHeaderOf: 'src/sim/math/trig.ts' }),
  }),
  Object.freeze({
    name: 'V8',
    origin:
      "V8's src/builtins/math.tq (FastMathHypot's two-argument path), transliterated into " +
      'hypot.ts; and three V8-authored expressions from src/base/ieee754.cc kept in trig.ts ' +
      'and rem-pio2.ts, all at branch-heads/13.6',
    files: Object.freeze(['src/sim/math/hypot.ts', 'src/sim/math/trig.ts', 'src/sim/math/rem-pio2.ts']),
    license: 'BSD-3-Clause',
    notice: Object.freeze({
      file: 'tools/notices/v8-bsd-license.txt',
      source: 'https://chromium.googlesource.com/v8/v8/+/branch-heads/13.6/LICENSE',
    }),
  }),
  // The typefaces. IBM Plex Sans and Plex Mono are separate packages with separate copyright
  // years (2019 and 2017), so each keeps its own license file.
  Object.freeze({
    name: 'IBM Plex Sans',
    origin:
      'the Latin-subset variable woff2 of @fontsource-variable/ibm-plex-sans@5.3.0, ' +
      'copied unchanged',
    files: Object.freeze(['src/game/fonts/ibm-plex-sans-latin-wght-normal.woff2']),
    license: 'OFL-1.1',
    notice: Object.freeze({ file: 'src/game/fonts/OFL.txt', source: "that package's LICENSE file" }),
  }),
  Object.freeze({
    name: 'IBM Plex Mono',
    origin:
      'the Latin-subset 400 and 600 woff2 files of @fontsource/ibm-plex-mono@5.3.0, ' +
      'copied unchanged',
    files: Object.freeze([
      'src/game/fonts/ibm-plex-mono-latin-400-normal.woff2',
      'src/game/fonts/ibm-plex-mono-latin-600-normal.woff2',
    ]),
    license: 'OFL-1.1',
    notice: Object.freeze({
      file: 'src/game/fonts/OFL-ibm-plex-mono.txt',
      source: "that package's LICENSE file",
    }),
  }),
  Object.freeze({
    name: 'Atkinson Hyperlegible',
    origin:
      'the Latin-subset 400 and 700 woff2 files of @fontsource/atkinson-hyperlegible@5.3.0, ' +
      'copied unchanged',
    files: Object.freeze([
      'src/game/fonts/atkinson-hyperlegible-latin-400-normal.woff2',
      'src/game/fonts/atkinson-hyperlegible-latin-700-normal.woff2',
    ]),
    license: 'OFL-1.1',
    notice: Object.freeze({
      file: 'src/game/fonts/OFL-atkinson-hyperlegible.txt',
      source: "that package's LICENSE file",
    }),
  }),
  Object.freeze({
    name: 'Inter',
    origin:
      'the Latin-subset variable woff2 of @fontsource-variable/inter@5.3.0, ' +
      'copied unchanged',
    files: Object.freeze(['src/game/fonts/inter-latin-wght-normal.woff2']),
    license: 'OFL-1.1',
    notice: Object.freeze({
      file: 'src/game/fonts/OFL-inter.txt',
      source: "that package's LICENSE file",
    }),
  }),
]);

/**
 * Files that carry a provenance marker but no third-party code, each with the reason.
 */
export const FIRST_PARTY_WITH_MARKERS = Object.freeze({
  'src/sim/math/bits.ts':
    "Reads and writes a double's two 32-bit words with a DataView, the job fdlibm's __HI and " +
    '__LO macros do in C. The macros are named as the reference; no fdlibm code is copied.',
  'tools/baseline/angles.ts': 'Names fdlibm as the comparison target of the determinism baseline; no ported code.',
  'tools/baseline/tick-cost.mjs': 'Names fdlibm as one side of a cost comparison; no ported code.',
  'src/input/touch.ts':
    'Names V8 among the engines where exactly-specified double operations are already ' +
    'bit-identical, as the reason aim quantization needs no vendoring; no ported code.',
  'tools/baseline/run.mjs': "Names the pinned V8 angle baseline in an error message; no ported code.",
});

/** Every file any vendored source lists, sorted and deduplicated. */
export function vendoredFiles(sources = VENDORED_SOURCES) {
  return [...new Set(sources.flatMap((s) => s.files))].sort();
}

/**
 * The fdlibm permission notice from a file's header: the lines between its two `=====` rules,
 * with the comment leaders removed.
 */
export function headerNotice(text) {
  const lines = text.split('\n');
  const rules = lines.map((l, i) => (/^\s*\*\s*={20,}\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) throw new Error('no ===== notice block in the file header');
  return lines
    .slice(rules[0] + 1, rules[1])
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

/** The notice text for one vendored source. */
export function noticeText(source, root = ROOT) {
  if (source.notice.fromHeaderOf) {
    return headerNotice(readFileSync(path.join(root, source.notice.fromHeaderOf), 'utf8'));
  }
  return readFileSync(path.join(root, source.notice.file), 'utf8').trim();
}
