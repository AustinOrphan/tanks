/**
 * Issue #888, run 6 -- the fix, verified. TEMPORARY; deleted before the issue closes.
 *
 * Run 5 showed a retry rescues the capture, but that retry re-ran the WHOLE of `captureState`.
 * `capture.mjs` now retries only the screenshot call, which is the surgical form. This drives
 * the real 45-state sequence and reports every state whose screenshot still fails -- the same
 * shape as run 2, which is what produced the failures in the first place.
 */
import { serve, launchBrowser, captureState } from './capture.mjs';
import { subsetStates } from './baseline.mjs';
import { SCREEN_STATES } from './states.mjs';
import { recipeFor } from './check.mjs';

const states = subsetStates(SCREEN_STATES);
const server = await serve('dist');
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser();
const t0 = Date.now();
let failures = 0;
for (const [i, state] of states.entries()) {
  const v = recipeFor(state.id)?.viewport ?? { width: 1280, height: 800, devicePixelRatio: 2 };
  let row;
  try {
    const { report, png } = await captureState(browser, base, state, { width: v.width, height: v.height, dpr: v.devicePixelRatio, timeout: 20000 });
    row = { shot: png !== null, bytes: png?.length ?? 0, err: report.producer.screenshotError };
  } catch (e) { row = { shot: false, bytes: 0, err: `threw ${String(e).split('\n')[0].slice(0, 70)}` }; }
  if (!row.shot) { failures += 1; console.log(`>>> [${i + 1}/${states.length}] ${state.id}: screenshot=false err=${row.err}`); }
}
console.log(`\nsequence complete: ${states.length} states in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failures} screenshot failure(s)`);
await browser.close();
server.close();
