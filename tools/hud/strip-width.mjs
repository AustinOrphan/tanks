import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

/**
 * Measure the versus stock strip at a 390px viewport, for every player count and stock setting
 * the game allows, and say whether each fits -- for the `pips` arm (issue #835), the `marks` arm
 * (issue #1021), and a teams entry under either arm (issue #1055).
 *
 * WHY A TOOL AND NOT A UNIT TEST. The unit suite runs in jsdom, which reads declared values but
 * lays nothing out, so it can pin the sizing TABLE and cannot prove a width. This drives real
 * Chromium against the real stylesheet. `stock-cue.test.ts` pins the table; this proves the
 * widths the table was chosen from.
 *
 * MOUNTED WHERE THE PAGE PUTS IT, not calibrated (issue #1055). The strip is drawn inside
 * `.hud > .hud-topbar`, after the versus mode chip, with the bundled faces inlined. Until #1055
 * this tool mounted the strip alone and subtracted an 83.9px "surrounding context" fitted to
 * #835's page reading, and that drifted three ways with no number looking wrong: #987 moved
 * `--hud-space-*` onto `.hud`, so the strip's gap fell to 0; the face the strip inherits from
 * `.hud` never loaded, so it measured Times; and the constant was fitted to FFA entries that
 * carry #922's identity marker, which teams and `marks` entries do not draw. Its own alarm row,
 * four FFA players at three stocks at 10/3, read 227.6px where it said 261.1px.
 *
 * The first two are checked before anything is measured -- the face has loaded and the strip's
 * gap is the stylesheet's 10px -- and the run exits non-zero if either fails.
 *
 * THE BUDGET is the topbar's content edge: its right edge less its right padding, 380px at a
 * 390px viewport. That is 10px stricter than #835's budget, which counted to the viewport edge
 * (397px there was 7px over): a strip that runs into the padding has already overflowed its row,
 * even before anything is clipped. Both distances are printed.
 *
 * CHECKED AGAINST THE PAGE. On 2026-10-10 the built page (c200cf62) at 390x844 put the strip's
 * right edge at 355.2px for four teams at three stocks, 291.4px for three teams, and 370.2px for
 * four FFA players, under `?dev=1&stockCue=pips`. This tool reads all three to within 0.1px. Text
 * metrics are not portable across rasterisers, so another platform may differ by a pixel or two.
 *
 * At the default UI scale only: `.hud` declares `--hud-ui-scale: 1`, and since #1048 the strip is
 * sized from it, so 125% and 150% would each need their own run.
 *
 *   node tools/hud/strip-width.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = join(HERE, '../../src/game');

function fail(message) {
  console.error(`strip-width: ${message}`);
  process.exit(2);
}

// The bundled faces, inlined: `setContent` has no base URL for `url('./fonts/...')` to resolve
// against, and an unresolved face silently measures the fallback serif instead.
let inlined = 0;
const css = readFileSync(join(GAME, 'hud.css'), 'utf8').replace(/url\('\.\/fonts\/([^']+\.woff2)'\)/g, (_, file) => {
  inlined += 1;
  return `url('data:font/woff2;base64,${readFileSync(join(GAME, 'fonts', file)).toString('base64')}')`;
});
if (inlined === 0) fail("found no url('./fonts/...') in hud.css to inline");

// The chip that sits ahead of the strip in a versus topbar, read from its one definition.
const VS = /MODE_CHIP_LABELS = \{[^}]*\bversus: '([^']+)'/.exec(
  readFileSync(join(GAME, 'topbar-treatment.ts'), 'utf8'),
)?.[1];
if (VS === undefined) fail('could not read the versus label from MODE_CHIP_LABELS in topbar-treatment.ts');

// Mirrors narrowPipLayout() in src/presentation/stock-cue.ts, which `stock-cue.test.ts` pins.
const layoutFor = (slots, total) => {
  if (slots <= 2) return { kind: 'row', pip: 10, gap: 3 };
  if (slots === 3) return total <= 4 ? { kind: 'row', pip: 10, gap: 3 } : { kind: 'row', pip: 9, gap: 2 };
  if (total <= 3) return { kind: 'row', pip: 9, gap: 2 };
  return { kind: 'one', pip: 10 };
};

// Mirrors narrowMarkLayout() in the same file, pinned in the same test.
const markLayoutFor = (slots, total) => {
  if (slots <= 3 || total <= 3) return { kind: 'full' };
  if (total === 4) return { kind: 'row', mark: 8, gap: 2 };
  return { kind: 'one' };
};

const browser = await chromium.launch();
// NO AudioContext override here, deliberately (issue #877): this page is built with
// `setContent` from raw CSS and markup and never navigates to the app, so there is no
// boot path to remove a constructor from.
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.setContent(`<style>${css}</style><div class="hud"><div class="hud-topbar">`
  + `<div class="hud-stat hud-practice">${VS}</div><div class="hud-versus-stocks"></div></div></div>`);

const env = await page.evaluate(async () => {
  // A face that cannot load rejects here; the check below reports it rather than a stack trace.
  await document.fonts.load('500 16px "IBM Plex Sans"').catch(() => {});
  await document.fonts.ready;
  const strip = document.querySelector('.hud-versus-stocks');
  return {
    face: [...document.fonts].some((f) => f.family.replaceAll('"', '') === 'IBM Plex Sans' && f.status === 'loaded'),
    family: getComputedStyle(strip).fontFamily,
    gap: getComputedStyle(strip).columnGap,
  };
});
if (!env.face || !env.family.startsWith('"IBM Plex Sans"')) {
  fail(`the strip is not measuring the bundled face (loaded: ${env.face}; font-family: ${env.family})`);
}
if (env.gap !== '10px') fail(`the strip's gap computed to ${env.gap}, not the stylesheet's 10px`);

/** The leading identity marker an FFA entry carries (#922's shipped `shape`); its box is the same
 *  whatever the outline, so a circle stands in for every slot. */
const MARKER = '<svg class="hud-stock-marker" viewBox="-1.1 -1.1 2.2 2.2" aria-hidden="true">'
  + '<circle r="0.8" fill="none" stroke="currentColor"/></svg>';

/** One `pips` entry, as hud.ts builds it, after `lead` (the marker, or nothing) and `label`. */
function pipsEntry(lead, label, layout, total) {
  if (layout.kind === 'one') {
    // One full-size pip, then the count as a digit.
    return `<span class="hud-versus-stock-entry">${lead}${label}`
      + `<span class="hud-stock-pips"><span class="hud-stock-pip"></span></span>`
      + `<span class="hud-stock-pip-count">${total - 1}</span></span>`;
  }
  const vars = layout.pip === 10 ? '' : ` style="--hud-pip:${layout.pip}px;--hud-pip-gap:${layout.gap}px"`;
  return `<span class="hud-versus-stock-entry">${lead}${label}<span class="hud-stock-pips"${vars}>`
    + Array.from({ length: total }, (_, j) =>
        `<span class="hud-stock-pip${j >= total - 1 ? ' hud-stock-pip--lost' : ''}"></span>`).join('')
    + `</span></span>`;
}

const pipArm = (layout) => (layout.kind === 'one' ? 'pip+n' : `${layout.pip}/${layout.gap}`);

/** The pips arm in FFA: every entry led by its identity marker. */
function pipsStrip(players, total) {
  const layout = layoutFor(players, total);
  const html = Array.from({ length: players }, (_, i) => pipsEntry(MARKER, `P${i + 1} `, layout, total)).join('');
  return [{ html, arm: pipArm(layout) }];
}

/**
 * The marks arm's markup, as hud.ts builds it: the leading identity marker is suppressed, and
 * every mark is the same box whatever its outline, so a circle stands in for each slot's shape.
 */
function marksStrip(players, total) {
  const layout = markLayoutFor(players, total);
  const mark = (lost) => `<svg class="hud-stock-mark${lost ? ' hud-stock-mark--lost' : ''}" `
    + `viewBox="-1.1 -1.1 2.2 2.2" aria-hidden="true"><circle r="0.8" fill="currentColor"/></svg>`;
  const entry = (i) => {
    if (layout.kind === 'one') {
      // One full-size mark, then the count as a digit.
      return `<span class="hud-versus-stock-entry">P${i + 1} <span class="hud-stock-marks">${mark(false)}</span>`
        + `<span class="hud-stock-mark-count">${total - 1}</span></span>`;
    }
    const vars = layout.kind === 'row' ? ` style="--hud-mark:${layout.mark}px;--hud-mark-gap:${layout.gap}px"` : '';
    return `<span class="hud-versus-stock-entry">P${i + 1} <span class="hud-stock-marks"${vars}>`
      + Array.from({ length: total }, (_, j) => mark(j >= total - 1)).join('') + `</span></span>`;
  };
  const html = Array.from({ length: players }, (_, i) => entry(i)).join('');
  const arm = layout.kind === 'one' ? 'mark+n' : layout.kind === 'row' ? `${layout.mark}/${layout.gap}` : 'full';
  return [{ html, arm }];
}

/** Every way `players` slots can be split into teams A/B/C with at least two sides. */
function teamSplits(players) {
  let splits = [''];
  for (let i = 0; i < players; i++) splits = splits.flatMap((s) => ['A', 'B', 'C'].map((t) => s + t));
  return splits.filter((s) => new Set(s).size >= 2);
}

/**
 * A teams entry, as hud.ts builds it under EITHER arm: `pips` beside the A/B/C letter and no
 * marker, because `marks` hands a teams entry to `pips` (a teammate shares a side, not a slot's
 * outline). One candidate per legal split, since the letters are not the same width.
 */
function teamsStrip(players, total) {
  const layout = layoutFor(players, total);
  return teamSplits(players).map((split) => ({
    html: [...split].map((team, i) => pipsEntry('', `P${i + 1} ${team} `, layout, total)).join(''),
    arm: pipArm(layout),
    split,
  }));
}

/** Where the strip ends, and where it may end, for one strip's markup. */
const place = (html) => page.evaluate((markup) => {
  const strip = document.querySelector('.hud-versus-stocks');
  strip.innerHTML = markup;
  const bar = strip.parentElement;
  const r = strip.getBoundingClientRect();
  return {
    left: r.left,
    right: r.left + Math.max(r.width, strip.scrollWidth),
    limit: bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight),
  };
}, html);

/** The widest of a configuration's candidates, reported against the budget. */
async function measure(build, players, total) {
  let worst = null;
  for (const candidate of build(players, total)) {
    const at = await place(candidate.html);
    if (worst === null || at.right > worst.right) worst = { ...candidate, ...at };
  }
  const inside = worst.limit - worst.right;
  console.log(
    `${players}p x ${total}   ${worst.arm.padStart(6)}   right ${worst.right.toFixed(1).padStart(6)}px   `
    + `${inside >= 0 ? `fits, ${inside.toFixed(1)}px inside the padding` : `OVER the padding by ${(-inside).toFixed(1)}px`}, `
    + `${(390 - worst.right).toFixed(1)}px to the viewport${worst.split ? `   (widest split ${worst.split})` : ''}`,
  );
  return inside >= 0;
}

const origin = await place('');
console.log(`budget: the topbar's content edge, ${origin.limit.toFixed(1)}px at a 390px viewport; `
  + `the strip starts at ${origin.left.toFixed(1)}px, after the "${VS}" chip. UI scale 100%.`);
let allFit = true;
for (const [name, build, counts] of [
  ['pips (FFA, each entry led by its identity marker)', pipsStrip, [2, 3, 4]],
  ['marks (FFA, no leading marker)', marksStrip, [2, 3, 4]],
  // Teams is offered at three and four players only.
  ['teams (pips beside the A/B/C letter, under either arm)', teamsStrip, [3, 4]],
]) {
  console.log(`\n${name}`);
  let fit = 0;
  let of = 0;
  for (const players of counts) {
    for (const total of [1, 2, 3, 4, 5]) {
      of += 1;
      if (await measure(build, players, total)) fit += 1;
    }
  }
  console.log(`${name.split(' ')[0]}: ${fit} of ${of} configurations fit`);
  allFit = allFit && fit === of;
}
console.log(`\n${allFit ? 'every configuration fits' : 'SOME CONFIGURATION STILL OVERFLOWS'}`);
await browser.close();
process.exit(allFit ? 0 : 1);
