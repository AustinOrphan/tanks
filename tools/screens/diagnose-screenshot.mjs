/**
 * Issue #888, run 4. TEMPORARY; deleted before the issue closes.
 *
 * Run 1: isolated, both targets capture under six browser configurations. GPU-process theory dead.
 * Run 2: in the gate's own 45-state sequence, both fail at 42 and 43. It accumulates.
 * Run 3: 41 repetitions of one cheap state do NOT break it; the real 41 predecessors do, and a
 *        prefix of 20 does not. So it is the IDENTITY of a predecessor, not the count.
 *
 * This run names it: every non-target state is run ALONE before the target, in a fresh browser,
 * so a single poisoning predecessor shows up as one failing row.
 */
import { serve, launchBrowser, captureState } from './capture.mjs';
import { subsetStates } from './baseline.mjs';
import { SCREEN_STATES } from './states.mjs';
import { recipeFor } from './check.mjs';

const TARGET = 'screen.startup.unsupported-render';

async function capture(browser, base, state) {
  const v = recipeFor(state.id)?.viewport ?? { width: 1280, height: 800, devicePixelRatio: 2 };
  const { report, png } = await captureState(browser, base, state, {
    width: v.width, height: v.height, dpr: v.devicePixelRatio, timeout: 20000,
  });
  return { shot: png !== null, bytes: png?.length ?? 0, err: report.producer.screenshotError };
}

const states = subsetStates(SCREEN_STATES);
const target = states.find((s) => s.id === TARGET);
const server = await serve('dist');
const base = `http://127.0.0.1:${server.address().port}/`;

console.log('\n=== which single predecessor poisons the target? ===');
const poisoners = [];
for (const s of states) {
  if (s.id === TARGET) continue;
  const browser = await launchBrowser();
  let pre = 'ok';
  try { const r = await capture(browser, base, s); if (!r.shot) pre = 'own-shot-failed'; }
  catch (e) { pre = `threw ${String(e).split('\n')[0].slice(0, 40)}`; }
  let r;
  try { r = await capture(browser, base, target); }
  catch (e) { r = { shot: false, bytes: 0, err: `threw ${String(e).split('\n')[0].slice(0, 50)}` }; }
  await browser.close();
  if (!r.shot) { poisoners.push(s.id); console.log(`>>> POISONS  ${s.id}  (its own capture: ${pre})`); }
}
console.log(`\npoisoning predecessors: ${poisoners.length === 0 ? 'NONE -- the cause needs two or more together' : poisoners.join(', ')}`);
server.close();
