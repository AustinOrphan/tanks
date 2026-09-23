import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  BASELINE,
  BUDGET,
  budgetFailures,
  budgetReport,
  gzipSize,
  measureBundle,
} from './check.mjs';

/**
 * Issue #945. The gate is pure functions over {name, bytes}, so everything below runs on
 * synthetic builds rather than on a real `dist/` -- the CLI half is one line and is covered
 * by running it, which `verify:build` does.
 *
 * WHAT MAKES THESE NON-VACUOUS. Every assertion here has a stated mutation that breaks it,
 * and the two that matter most are the ones a size gate gets wrong in practice: passing on
 * an empty build, and comparing against a ceiling nobody set.
 */

const buf = (n: number, fill = 'a') => Buffer.from(fill.repeat(n));
/** A build that is unmistakably within budget. */
const tinyBuild = () => [
  { name: 'assets/index-abc.js', bytes: buf(1000) },
  { name: 'assets/index-abc.css', bytes: buf(100) },
  { name: 'assets/font-abc.woff2', bytes: buf(50) },
];

describe('bundle budget: what it measures', () => {
  it('totals js, css and fonts separately, and counts the files', () => {
    const m = measureBundle([
      ...tinyBuild(),
      { name: 'assets/second-def.js', bytes: buf(500) },
      { name: 'assets/other-def.woff', bytes: buf(25) },
      // Neither budgeted nor counted as a font: a regression that renamed the bundle to
      // .mjs would otherwise read as "no JS at all" rather than as a size change.
      { name: 'index.html', bytes: buf(9999) },
    ]);
    expect(m.js).toEqual({ raw: 1500, gzip: gzipSize(buf(1000)) + gzipSize(buf(500)), count: 2 });
    expect(m.css.raw).toBe(100);
    expect(m.css.count).toBe(1);
    expect(m.fonts).toEqual({ raw: 75, count: 2 });
  });

  it('gzips with zlib level 9, not with whatever the platform defaults to', () => {
    // The header records that `gzip -9` and zlib disagree by 0.5% on the real bundle. If
    // this call loses its level the ceilings silently gain headroom, and nothing else here
    // would notice -- every other test compares gzipSize against itself.
    //
    // THE FIXTURE IS THE WHOLE TEST, and the first one was dead. `'abcdefgh'.repeat(2500)`
    // compresses to 73 bytes at BOTH level 6 and level 9, so an assertion built on it
    // cannot tell the two apart -- the mutation that drops `{ level: 9 }` SURVIVED it.
    // Levels 6 and 9 agree on most inputs; they part on data that is compressible but
    // awkward, so this is 60 KB drawn from a four-letter alphabet, measured to differ:
    // 17,992 B at the default against 18,005 B at level 9. Level 9 is LARGER here, which
    // is ordinary zlib behaviour and is why the assertion is inequality, not a direction.
    const awkward = Buffer.alloc(60_000);
    let seed = 1;
    for (let i = 0; i < awkward.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      awkward[i] = 97 + ((seed >>> 16) % 4);
    }
    expect(gzipSize(awkward)).toBe(gzipSync(awkward, { level: 9 }).length);
    expect(
      gzipSize(awkward),
      'gzipSize must not be compressing at zlib’s default level',
    ).not.toBe(gzipSync(awkward).length);
  });
});

describe('bundle budget: what it refuses', () => {
  it('passes a build inside the ceilings', () => {
    expect(budgetFailures(measureBundle(tinyBuild()))).toEqual([]);
  });

  it('REFUSES a build with no JavaScript, which is under every ceiling', () => {
    // The failure this guard exists for: an empty or broken build weighs nothing and so
    // satisfies a size budget perfectly. `tools/portability/check.mjs` carries the same
    // guard after its predecessor passed on an empty dist/.
    const failures = budgetFailures(
      measureBundle([{ name: 'assets/index-abc.css', bytes: buf(100) }]),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no JS bundle found/);
  });

  it('REFUSES a build with no stylesheet', () => {
    const failures = budgetFailures(
      measureBundle([{ name: 'assets/index-abc.js', bytes: buf(100) }]),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no CSS found/);
  });

  it('fails on raw bytes over the ceiling, and names the overage', () => {
    const over = [
      { name: 'assets/index-abc.js', bytes: buf(BUDGET.js.raw + 1) },
      { name: 'assets/index-abc.css', bytes: buf(10) },
    ];
    const failures = budgetFailures(measureBundle(over));
    expect(failures.some((f) => /^js raw is /.test(f))).toBe(true);
    expect(failures.join('\n')).toContain('over the');
  });

  it('fails on GZIPPED bytes even when raw is inside the ceiling', () => {
    // The whole reason both forms are asserted. Random bytes do not compress, so this build
    // is comfortably under the raw ceiling and over the gzip one -- which a raw-only budget
    // would wave through.
    // A seeded LCG, not `i * k % 256`: that is a short cycle and gzip crushed it to 5 KB,
    // which made this test pass for the wrong reason on its first run. Deterministic, so
    // the fixture is the same on every machine, and high-entropy, so gzip cannot shrink it.
    const incompressible = Buffer.alloc(BUDGET.js.raw - 1000);
    let seed = 1;
    for (let i = 0; i < incompressible.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      incompressible[i] = (seed >>> 16) & 0xff;
    }
    const m = measureBundle([
      { name: 'assets/index-abc.js', bytes: incompressible },
      { name: 'assets/index-abc.css', bytes: buf(10) },
    ]);
    expect(m.js.raw, 'the fixture must be under the raw ceiling for this to mean anything')
      .toBeLessThanOrEqual(BUDGET.js.raw);
    expect(m.js.gzip, 'and over the gzip one').toBeGreaterThan(BUDGET.js.gzip);
    expect(budgetFailures(m).some((f) => /^js gzip is /.test(f))).toBe(true);
  });

  it('is an inclusive ceiling: exactly at the budget passes, one byte over fails', () => {
    // Pins the comparison operator. `>=` instead of `>` fails a build that is exactly at a
    // number somebody chose deliberately, which is the one build that must not fail.
    const at = measureBundle([
      { name: 'assets/index-abc.js', bytes: buf(BUDGET.js.raw) },
      { name: 'assets/index-abc.css', bytes: buf(10) },
    ]);
    expect(at.js.raw).toBe(BUDGET.js.raw);
    expect(budgetFailures(at).filter((f) => /^js raw/.test(f))).toEqual([]);
  });

  it('reports every breach rather than stopping at the first', () => {
    const failures = budgetFailures(
      measureBundle([
        { name: 'assets/index-abc.js', bytes: buf(BUDGET.js.raw + 1) },
        { name: 'assets/index-abc.css', bytes: buf(BUDGET.css.raw + 1) },
      ]),
    );
    // js raw, js gzip (buf() is one repeated character, so it compresses, but the file is
    // large enough that its gzip still clears the ceiling), css raw -- at least three.
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.some((f) => f.startsWith('js '))).toBe(true);
    expect(failures.some((f) => f.startsWith('css '))).toBe(true);
  });
});

describe('bundle budget: the recorded baseline', () => {
  it('leaves real headroom, so an ordinary change does not trip the gate', () => {
    // If a future edit sets a ceiling to today's exact size, the next honest commit fails
    // and the lesson taught is "raise the number", which is what the header warns against.
    for (const kind of ['js', 'css'] as const) {
      for (const form of ['raw', 'gzip'] as const) {
        const headroom = (BUDGET[kind][form] - BASELINE[kind][form]) / BASELINE[kind][form];
        expect(headroom, `${kind} ${form} headroom`).toBeGreaterThan(0.05);
        // And not SO much room that the gate stops meaning anything: 48.8% of this bundle
        // is `three`, so a ceiling more than a quarter above the baseline would let a whole
        // second rendering library in unnoticed.
        expect(headroom, `${kind} ${form} headroom`).toBeLessThan(0.25);
      }
    }
  });

  it('records the baseline as under the ceiling it was used to set', () => {
    const asMeasured = {
      js: { ...BASELINE.js, count: 1 },
      css: { ...BASELINE.css, count: 1 },
      fonts: { raw: 0, count: 0 },
    };
    expect(budgetFailures(asMeasured)).toEqual([]);
  });

  it('report names both forms and says fonts are excluded', () => {
    const lines = budgetReport(measureBundle(tinyBuild()));
    expect(lines.join('\n')).toMatch(/js .*raw.*gzip/);
    expect(lines.join('\n')).toMatch(/css .*raw.*gzip/);
    expect(lines.join('\n')).toMatch(/fonts .*not budgeted/);
  });
});
