/**
 * Issue #888, run 3. TEMPORARY; deleted before the issue closes.
 *
 * Run 1: both targets capture fine in ISOLATION, under six browser configurations. The
 * GPU-process hypothesis is refuted.
 * Run 2: driven as the gate drives them -- 45 states through ONE browser -- both fail, at
 * positions 42 and 43, and nothing else in the run does. So it accumulates.
 *
 * This run asks the question that picks the fix: COUNT or IDENTITY? If 41 repetitions of one
 * cheap state are enough to break the target, the browser is leaking something per capture and
 * the fix is a lifecycle one. If only the real 41 predecessors do it, something specific in
 * them is responsible and the fix is to find it.
 */
import { serve, launchBrowser, captureState } from './capture.mjs';
import { subsetStates } from './baseline.mjs';
import { SCREEN_STATES } from './states.mjs';
import { recipeFor } from './check.mjs';

const TARGET = 'screen.startup.unsupported-render';
const FILLER = 'screen.main-menu';

async function capture(browser, base, state) {
  const v = recipeFor(state.id)?.viewport ?? { width: 1280, height: 800, devicePixelRatio: 2 };
  const { report, png } = await captureState(browser, base, state, {
    width: v.width, height: v.height, dpr: v.devicePixelRatio, timeout: 20000,
  });
  return { shot: png !== null, bytes: png?.length ?? 0, err: report.producer.screenshotError };
}

const states = subsetStates(SCREEN_STATES);
const target = states.find((s) => s.id === TARGET);
const filler = states.find((s) => s.id === FILLER);
const realPrefix = states.filter((s) => s.id !== TARGET);

const server = await serve('dist');
const base = `http://127.0.0.1:${server.address().port}/`;

/** @param {string} label @param {Array<object>} prefix */
async function arm(label, prefix) {
  const browser = await launchBrowser();
  let failedInPrefix = 0;
  for (const s of prefix) {
    try { const r = await capture(browser, base, s); if (!r.shot) failedInPrefix += 1; }
    catch { failedInPrefix += 1; }
  }
  let r;
  try { r = await capture(browser, base, target); }
  catch (e) { r = { shot: false, bytes: 0, err: `threw ${String(e).split('\n')[0].slice(0, 60)}` }; }
  await browser.close();
  console.log(`${label.padEnd(34)} prefix=${String(prefix.length).padStart(2)} prefixFailures=${failedInPrefix} -> target screenshot=${r.shot} bytes=${r.bytes}`);
}

console.log('\n=== COUNT or IDENTITY? ===');
await arm('41x the same cheap state', Array.from({ length: 41 }, () => filler));
await arm('the real 41 predecessors', realPrefix.slice(0, 41));
await arm('the real first 20', realPrefix.slice(0, 20));
await arm('the real first 10', realPrefix.slice(0, 10));
await arm('no prefix at all', []);
server.close();
