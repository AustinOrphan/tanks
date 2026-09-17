/**
 * Third-party source vendored into `src/` (issue #771), and the files that only look like it.
 *
 * `render.mjs` lists runtime dependencies from `node_modules`, which covers code that arrives
 * through npm. Three files under `src/sim/math` did not: they are ports of fdlibm and of V8,
 * made so the simulation's trigonometry is bit-identical in every engine (issue #133). Their
 * notices are preserved in the files' own headers, but `CONTENT-LICENSE.md` classified all of
 * `src/**` as first-party code under `LICENSE`, and the generated notices never mentioned them.
 *
 * This module is the one declared list both surfaces are checked against:
 * `vendored.test.ts` fails when a file carrying a third-party provenance marker is on neither
 * list below, and when `CONTENT-LICENSE.md` stops naming a vendored file.
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
  /the V8 project authors/,
  /\bfdlibm\b/,
  /\bnetlib\b/,
  /transliterat/i,
  /ported line-by-line/i,
]);

/**
 * Where each vendored body of code came from, which files carry it, and its notice.
 *
 * `notice.fromHeaderOf` reads the notice out of that file's own header, between the fdlibm
 * `=====` rules, so the text in THIRD-PARTY-NOTICES.md is quoted from the source rather than
 * retyped. `notice.file` is a licence stored verbatim beside this module.
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
