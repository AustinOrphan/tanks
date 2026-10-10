/**
 * Measure the versus stock strip at a 390px viewport, for every player count and stock setting
 * the game allows, and say whether each fits -- for the `pips` arm (issue #835), the `marks` arm
 * (issue #1021), and a teams entry, which draws its A/B/C letter before its pips (issue #1055).
 *
 * WHY A TOOL AND NOT A UNIT TEST. The unit suite runs in jsdom, which reads declared values but
 * lays nothing out, so it can pin the sizing TABLE and cannot prove a width. This drives real
 * Chromium against the real HUD. `stock-cue.test.ts` pins the table; this proves the widths the
 * table was chosen from.
 *
 * THE REAL HUD, NOT A COPY OF ITS MARKUP (issue #1055). This tool used to paste hand-built entry
 * markup and the bare stylesheet into an empty page and compare the width with 254.1px, a budget
 * calibrated once against #835's page measurement. Every part of that drifted without a sound:
 * #987 moved the spacing tokens onto `.hud`, so the bare strip lost the 10px between entries; the
 * bundled face never loaded on that page, which fell back to the browser's serif; and the
 * hand-built FFA entry had no identity mark, which the page has drawn ahead of each FFA entry,
 * under every arm but `marks`, since #922. At four players and three stocks the bare strip read
 * 207.6px where the page's strip is 247.7px wide without the mark (both in a 390px viewport).
 * So `strip-width-page.ts` now mounts `createHud` itself, in a page Vite serves with the
 * stylesheet and face the game ships, pushes a versus status, and measures the strip where the
 * page draws it: after the topbar's session chip, inside the topbar's padding. Nothing here
 * mirrors a layout rule; the HUD applies `narrowPipLayout` and `narrowMarkLayout` itself, under
 * the real `NARROW_STRIP_QUERY`. Checked against the game page itself, booted at 390x844 as a
 * four-player teams session under `?dev=1&stockCue=pips`: its strip's right edge read 355.16px,
 * and this tool reads 355.2px.
 *
 * Every row also checks that the shipped face really loaded (a run with the font files blocked
 * flags all 40 rows), and every teams row that `marks` and `pips` drew the same markup.
 *
 * FITS means the strip's right edge is inside the topbar's content box -- 380px at 390px, where
 * the topbar's narrow padding is 10px -- so the strip keeps the margin the bar gives every other
 * reading, rather than merely escaping the clip at the viewport edge.
 *
 * Measured at the default UI scale (100%), which is the scale this page runs at: the strip is
 * under the player's UI scale since #1048, so a larger scale needs its own measurement.
 *
 * THE CONTROL. Before the sweep, the four-player three-stock teams strip is measured once at
 * 320px, where it cannot fit; a run that reports it fitting there exits 1, because a yardstick
 * that cannot fail measures nothing.
 *
 *   node tools/hud/strip-width.mjs
 *
 * `STRIP_WIDTH_PORT` moves the Vite server off 5183.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadChromium } from '../shared/playwright.mjs';

const PORT = Number(process.env.STRIP_WIDTH_PORT ?? 5183);
const BASE = `http://localhost:${PORT}/`;

async function respondsOn(url, ms = 1000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return false;
  }
}

if (await respondsOn(BASE)) {
  console.error(
    `Something is already listening on ${BASE}.\n` +
      'Refusing to run: it would be measured instead of this checkout.\n' +
      'Stop it or set STRIP_WIDTH_PORT to a free port.',
  );
  process.exit(2);
}

/** Every slot on its own, as an FFA match has them. */
const ffa = (players, total) => Array.from({ length: players }, (_, slot) => ({ slot, stock: total }));
/**
 * Lettered A, B, A, B: the parity a `?dev=1&mode=teams` session assigns. It is also the widest
 * strip any legal split draws, because A and B measure the same and C is narrower (four A
 * entries read 305.0px at four players and three stocks, four B 304.9px, four C 303.4px).
 */
const teams = (players, total) =>
  Array.from({ length: players }, (_, slot) => ({ slot, stock: total, team: slot % 2 }));

const REPORTS = [
  {
    name: 'pips', note: 'FFA, with the identity mark the page draws ahead of each entry',
    cue: 'pips', players: [2, 3, 4], stocks: ffa,
  },
  {
    name: 'marks', note: 'FFA; the arm suppresses the leading mark',
    cue: 'marks', players: [2, 3, 4], stocks: ffa,
  },
  {
    // Teams is offered at three and four players only. Measured under `marks`, which hands a
    // teams entry to `pips` (issue #1022 ships it), and required to draw exactly what `pips`
    // draws.
    name: 'teams', note: '`P1 A ` and its pips, under `marks` and `pips` alike',
    cue: 'marks', same: 'pips', players: [3, 4], stocks: teams,
  },
];

const VITE_BIN = new URL('../../node_modules/.bin/vite', import.meta.url).pathname;
const vite = spawn(VITE_BIN, ['--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
let viteExited = false;
vite.on('exit', () => {
  viteExited = true;
});

let browser;
try {
  for (let i = 0; ; i++) {
    if (viteExited) throw new Error('vite exited before serving; is the port taken?');
    if (await respondsOn(BASE)) break;
    if (i > 120) throw new Error(`vite did not start on ${BASE} within 60s`);
    await sleep(500);
  }

  const chromium = await loadChromium();
  browser = await chromium.launch();
  const pageErrors = [];
  // NO AudioContext override here, deliberately (issue #877): the page is
  // `tools/hud/strip-width.html`, not the app. It mounts the HUD alone, and `createHud` never
  // constructs an AudioContext -- the audio stack is wired in by the page's boot, which this
  // page does not run -- so there is no constructor for an override to remove.
  async function open(width) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${BASE}tools/hud/strip-width.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.stripReady === true, undefined, { timeout: 60000 });
    return page;
  }
  const read = (page, cue, stocks) =>
    page.evaluate(([c, s]) => window.measureStrip(c, s), [cue, stocks]);

  let ok = true;
  const control = await read(await open(320), 'marks', teams(4, 3));
  const controlFits = control.right <= control.edge;
  console.log(
    'control: four-player three-stock teams strip at 320px, '
    + `right edge ${control.right}px against ${control.edge}px: `
    + `${controlFits ? 'FITS -- the yardstick cannot fail' : 'overflows, as it must'}`,
  );
  if (controlFits) ok = false;

  const page = await open(390);
  for (const report of REPORTS) {
    console.log(`\n${report.name} (${report.note})`);
    let fit = 0;
    let total = 0;
    for (const players of report.players) {
      for (let stocks = 1; stocks <= 5; stocks++) {
        const r = await read(page, report.cue, report.stocks(players, stocks));
        total += 1;
        const fits = r.right <= r.edge;
        if (fits) fit += 1;
        if (!r.face) ok = false;
        let same = '';
        if (report.same !== undefined) {
          const other = await read(page, report.same, report.stocks(players, stocks));
          if (other.html !== r.html) {
            ok = false;
            same = `   DIFFERS under ${report.same}`;
          }
        }
        console.log(
          `${players}p x ${stocks}   ${r.layout.padStart(7)}   strip ${String(r.width).padStart(6)}px   `
          + `right ${String(r.right).padStart(6)}px   `
          + (fits ? `fits, ${(r.edge - r.right).toFixed(1)}px spare` : `OVER by ${(r.right - r.edge).toFixed(1)}px`)
          + `${r.face ? '' : '   FACE NOT LOADED'}${same}`,
        );
      }
    }
    console.log(`${report.name}: ${fit} of ${total} configurations fit`);
    if (fit !== total) ok = false;
  }
  for (const e of pageErrors) console.error(`page error: ${e}`);
  if (pageErrors.length > 0) ok = false;
  console.log(`\n${ok ? 'every configuration fits' : 'SOME CONFIGURATION OVERFLOWS, OR A CHECK FAILED'}`);
  if (!ok) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  vite.kill('SIGTERM');
}
