/**
 * The production bundle budget (issue #945).
 *
 * WHY IT EXISTS. Issue #251 requires that "ordinary production startup remains within the
 * recorded budget", and no budget was recorded anywhere: the nearest gate, `npm run
 * audit:prod`, audits dependency vulnerabilities and says nothing about size. So nothing
 * could show a change had made startup worse, and the one measurement anybody had was
 * whatever they ran by hand.
 *
 * WHAT IT MEASURES, and why both numbers. Raw bytes are what a source map decomposes and
 * what a reader can attribute to a module; gzipped bytes are what a player actually waits
 * for, and the two do not move together -- this bundle is 1,184,867 B raw and 328,025 B
 * gzipped, a 3.6x ratio that a minifier change alone can shift. A budget on one of them is
 * half a budget, so both are asserted.
 *
 * Fonts are deliberately NOT in it. They are six woff2 files totalling 159,028 B, they do
 * not change when code does, and folding them in would add that much constant weight to
 * every reading -- 11% of the 1,387,585 B that JS, CSS and fonts come to together -- so a
 * JavaScript regression would read 11% smaller against the larger total. They are reported
 * beside the budget rather than inside it.
 *
 * WHERE THE CEILINGS COME FROM. Measured on `main` at 0b1b513 (one build, this box), BY
 * THIS FILE'S OWN `gzipSize`:
 *
 *            raw          gzip
 *   JS    1,184,867 B     328,025 B
 *   CSS      43,690 B       8,240 B
 *
 * Those gzip figures are NOT what `gzip -9` prints at a shell: the same bundle comes to
 * 326,304 B there, 1,721 B (0.5%) smaller, and the stylesheet 34 B larger. Two
 * implementations of the same format disagree slightly, and a budget compared against a
 * number some other tool produced would carry that disagreement as invisible headroom. So
 * the baseline recorded here is the one this gate measures, and a reader reproducing it
 * should call `gzipSize` rather than the command line.
 *
 * The ceilings below are those numbers plus 10%, and the 10% is argued rather than
 * conventional. Attributed through the build's own source map (99.9% of the bundle's bytes
 * accounted for), the largest single first-party module outside `hud.ts` is
 * `src/audio/synth.ts` at 41.7 KB raw -- so a 118 KB raw allowance fits roughly two of the
 * biggest modules this repository has ever added at once, and an ordinary feature does not
 * come close. It is also far below the 564.8 KB (48.8%) that `three` occupies, so a
 * dependency bump on that scale trips this immediately, which is the regression actually
 * worth catching: issue #800's `three` move is what put a 92.9 s number in `tools/gl/run.mjs`
 * and nothing noticed the bundle at all.
 *
 * RAISE IT DELIBERATELY. A gate that fails on an honest feature teaches people to raise the
 * number without reading it. If a change genuinely needs more room, move the ceiling in the
 * same pull request as the change, and say in the message what grew and why -- the way this
 * comment records its own baseline.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The ceilings, in bytes. See the header for where they come from and how to move them.
 *
 * An object rather than four constants so a test can read the whole budget and a failure
 * can name which half of it was exceeded.
 */
export const BUDGET = Object.freeze({
  js: Object.freeze({ raw: 1_303_000, gzip: 361_000 }),
  css: Object.freeze({ raw: 48_000, gzip: 9_100 }),
});

/** The measured baseline the ceilings were set from, kept so the headroom stays legible. */
export const BASELINE = Object.freeze({
  commit: '0b1b513',
  js: Object.freeze({ raw: 1_184_867, gzip: 328_025 }),
  css: Object.freeze({ raw: 43_690, gzip: 8_240 }),
});

/**
 * zlib at level 9 -- an approximation of what a static host serves, and the ONE
 * implementation the ceilings above were measured with. See the header: the `gzip` command
 * disagrees with this by 0.5% on the same bytes, so a budget must pick one and stay on it.
 */
export function gzipSize(buffer) {
  return gzipSync(buffer, { level: 9 }).length;
}

/**
 * Total the built assets by kind.
 *
 * @param {{name: string, bytes: Buffer}[]} files
 * @returns {{js: {raw: number, gzip: number, count: number}, css: {raw: number, gzip: number, count: number}, fonts: {raw: number, count: number}}}
 */
export function measureBundle(files) {
  const zero = () => ({ raw: 0, gzip: 0, count: 0 });
  const out = { js: zero(), css: zero(), fonts: { raw: 0, count: 0 } };
  for (const { name, bytes } of files) {
    if (name.endsWith('.js')) {
      out.js.raw += bytes.length;
      out.js.gzip += gzipSize(bytes);
      out.js.count++;
    } else if (name.endsWith('.css')) {
      out.css.raw += bytes.length;
      out.css.gzip += gzipSize(bytes);
      out.css.count++;
    } else if (/\.(woff2?|ttf|otf)$/.test(name)) {
      out.fonts.raw += bytes.length;
      out.fonts.count++;
    }
  }
  return out;
}

/**
 * Every way this build is over budget, one message each. Empty means within it.
 *
 * @param {ReturnType<typeof measureBundle>} measured
 * @param {typeof BUDGET} budget
 * @returns {string[]}
 */
export function budgetFailures(measured, budget = BUDGET) {
  const failures = [];

  // THE NON-VACUITY GUARD, and it is the whole reason this function can be trusted. A
  // build that emitted no JavaScript is under every ceiling, and the shell one-liner this
  // replaces in spirit -- `du -sh dist` and a human glance -- would have called that a pass.
  // `tools/portability/check.mjs` carries the same guard for the same reason, after its own
  // predecessor passed on an empty dist/.
  if (measured.js.count === 0) {
    failures.push('no JS bundle found under assets/ -- the build produced nothing to weigh');
    return failures;
  }
  if (measured.css.count === 0) {
    failures.push('no CSS found under assets/ -- the build produced no stylesheet to weigh');
    return failures;
  }

  for (const kind of ['js', 'css']) {
    for (const form of ['raw', 'gzip']) {
      const actual = measured[kind][form];
      const ceiling = budget[kind][form];
      if (actual > ceiling) {
        failures.push(
          `${kind} ${form} is ${actual.toLocaleString()} B, over the ${ceiling.toLocaleString()} B ceiling ` +
            `by ${(actual - ceiling).toLocaleString()} B (${((100 * (actual - ceiling)) / ceiling).toFixed(1)}%). ` +
            `Baseline when the ceiling was set: ${BASELINE[kind][form].toLocaleString()} B. ` +
            `If this growth is intended, raise the ceiling in tools/bundle-budget/check.mjs in the same ` +
            `pull request and say what grew.`,
        );
      }
    }
  }
  return failures;
}

/** How much of each ceiling this build uses, for the line the gate prints when it passes. */
export function budgetReport(measured, budget = BUDGET) {
  const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`;
  return [
    `js  ${measured.js.raw.toLocaleString()} B raw (${pct(measured.js.raw, budget.js.raw)} of budget), ` +
      `${measured.js.gzip.toLocaleString()} B gzip (${pct(measured.js.gzip, budget.js.gzip)})`,
    `css ${measured.css.raw.toLocaleString()} B raw (${pct(measured.css.raw, budget.css.raw)} of budget), ` +
      `${measured.css.gzip.toLocaleString()} B gzip (${pct(measured.css.gzip, budget.css.gzip)})`,
    `fonts ${measured.fonts.raw.toLocaleString()} B over ${measured.fonts.count} file(s) -- reported, not budgeted`,
  ];
}

/** Read every built asset under `dir`, recursively, as {name, bytes}. */
export function readBuiltAssets(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ name: relative(dir, full).split('\\').join('/'), bytes: readFileSync(full) });
    }
  };
  walk(dir);
  return out;
}

// CLI only when invoked directly, so the test can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'dist';
  const measured = measureBundle(readBuiltAssets(dir));
  const failures = budgetFailures(measured);
  for (const line of budgetReport(measured)) console.log(line);
  if (failures.length) {
    console.error(`\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`within budget: ${dir} weighed against the ceilings set from ${BASELINE.commit}`);
}
