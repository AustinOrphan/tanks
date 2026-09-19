import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

/**
 * Measure the versus stock strip's width at a 390px viewport, for every player count and stock
 * setting the game allows, and say whether each fits (issue #835).
 *
 * WHY A TOOL AND NOT A UNIT TEST. The unit suite runs in jsdom, which reads declared values but
 * lays nothing out, so it can pin the sizing TABLE and cannot prove a width. This drives real
 * Chromium against the real stylesheet. `stock-cue.test.ts` pins the table; this proves the
 * widths the table was chosen from.
 *
 * CALIBRATED AGAINST THE PAGE, not assumed. It mounts the strip alone, without the topbar
 * around it, so its absolute numbers are smaller than a full-page measurement. The offset is
 * fixed and checkable: issue #835 measured the four-player three-stock strip at 345px on the
 * page, this harness reads 261.1px for the same markup, so the surrounding context is 83.9px --
 * and the issue's 338px budget is 254.1px here, where 261.1px is duly the 7px over that the
 * issue reported. If that row ever stops reading 7px over on an unfixed build, the calibration
 * has drifted and the numbers below mean nothing.
 *
 *   node tools/hud/strip-width.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, '../../src/game/hud.css'), 'utf8');
const BUDGET = 338 - 83.9;

// Mirrors narrowPipLayout() in src/presentation/stock-cue.ts, which `stock-cue.test.ts` pins.
const layoutFor = (slots, total) => {
  if (slots <= 2) return { kind: 'row', pip: 10, gap: 3 };
  if (slots === 3) return total <= 4 ? { kind: 'row', pip: 10, gap: 3 } : { kind: 'row', pip: 9, gap: 2 };
  if (total <= 3) return { kind: 'row', pip: 9, gap: 2 };
  return { kind: 'one', pip: 10 };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

async function measure(players, total) {
  const layout = layoutFor(players, total);
  const entry = (i) => {
    if (layout.kind === 'one') {
      // One full-size pip, then the count as a digit.
      return `<span class="hud-versus-stock-entry">P${i + 1} `
        + `<span class="hud-stock-pips"><span class="hud-stock-pip"></span></span>`
        + `<span class="hud-stock-pip-count">${total - 1}</span></span>`;
    }
    const vars = layout.pip === 10 ? '' : ` style="--hud-pip:${layout.pip}px;--hud-pip-gap:${layout.gap}px"`;
    return `<span class="hud-versus-stock-entry">P${i + 1} <span class="hud-stock-pips"${vars}>`
      + Array.from({ length: total }, (_, j) =>
          `<span class="hud-stock-pip${j >= total - 1 ? ' hud-stock-pip--lost' : ''}"></span>`).join('')
      + `</span></span>`;
  };
  const html = `<div class="hud-versus-stocks">${Array.from({ length: players }, (_, i) => entry(i)).join('')}</div>`;
  await page.setContent(`<style>${css}</style><div style="position:absolute;left:0;top:0;display:inline-block">${html}</div>`);
  const w = await page.evaluate(() =>
    Math.round(document.querySelector('.hud-versus-stocks').getBoundingClientRect().width * 10) / 10);
  const arm = layout.kind === 'one' ? 'pip+n' : `${layout.pip}/${layout.gap}`;
  console.log(
    `${players}p x ${total}   ${arm.padStart(6)}   ${String(w).padStart(7)}px   `
    + `${w <= BUDGET ? `fits, ${(BUDGET - w).toFixed(1)}px spare` : `OVER by ${(w - BUDGET).toFixed(1)}px`}`,
  );
  return w <= BUDGET;
}

console.log(`budget ${BUDGET.toFixed(1)}px at a 390px viewport\n`);
let allFit = true;
for (const players of [2, 3, 4]) {
  for (const total of [1, 2, 3, 4, 5]) allFit = (await measure(players, total)) && allFit;
}
console.log(`\n${allFit ? 'every configuration fits' : 'SOME CONFIGURATION STILL OVERFLOWS'}`);
await browser.close();
process.exit(allFit ? 0 : 1);
