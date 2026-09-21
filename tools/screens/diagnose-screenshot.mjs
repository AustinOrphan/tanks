/**
 * Issue #888: why `Page.captureScreenshot` fails on the two WebGL-refused states.
 *
 * TEMPORARY. Deleted before that issue closes.
 *
 * Run 1 refuted the obvious hypothesis: driving those two states through a hand-written
 * capture, on Linux, with six different browser configurations, every screenshot succeeded.
 * So the fault is not the state in isolation -- it is something the REAL run does. The
 * difference under test here is SEQUENCE: the gate captures 45 states through one browser,
 * and these two sit at 43 and 44.
 */
import { serve, launchBrowser, captureState } from './capture.mjs';
import { subsetStates } from './baseline.mjs';
import { SCREEN_STATES } from './states.mjs';
import { recipeFor } from './check.mjs';

const TARGETS = ['screen.startup.unsupported-render', 'screen.startup.probe-blocked'];
const VIEWPORT = { width: 1280, height: 800, dpr: 2 };

async function capture(browser, base, state) {
  const v = recipeFor(state.id)?.viewport ?? { width: VIEWPORT.width, height: VIEWPORT.height, devicePixelRatio: VIEWPORT.dpr };
  const { report, png } = await captureState(browser, base, state, {
    width: v.width, height: v.height, dpr: v.devicePixelRatio, timeout: 20000,
  });
  return { shot: png !== null, bytes: png?.length ?? 0, err: report.producer.screenshotError };
}

const states = subsetStates(SCREEN_STATES);
const server = await serve('dist');
const base = `http://127.0.0.1:${server.address().port}/`;

console.log(`\n=== ISOLATED: the two targets alone, fresh browser each ===`);
for (const id of TARGETS) {
  const state = states.find((s) => s.id === id);
  const browser = await launchBrowser();
  const r = await capture(browser, base, state).catch((e) => ({ shot: false, bytes: 0, err: `threw ${String(e).slice(0, 60)}` }));
  await browser.close();
  console.log(`ISOLATED ${id}: screenshot=${r.shot} bytes=${r.bytes}${r.err ? ` err=${r.err}` : ''}`);
}

console.log(`\n=== SEQUENCE: all ${states.length} states through ONE browser, as the gate does ===`);
{
  const browser = await launchBrowser();
  let i = 0;
  for (const state of states) {
    i += 1;
    let r;
    try { r = await capture(browser, base, state); }
    catch (e) { r = { shot: false, bytes: 0, err: `threw ${String(e).split('\n')[0].slice(0, 70)}` }; }
    const flag = r.shot ? '   ' : '>>>';
    if (!r.shot || TARGETS.includes(state.id)) {
      console.log(`${flag} [${String(i).padStart(2)}/${states.length}] ${state.id}: screenshot=${r.shot} bytes=${r.bytes}${r.err ? ` err=${r.err}` : ''}`);
    }
  }
  await browser.close();
}
server.close();
