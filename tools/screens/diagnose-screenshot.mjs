/**
 * Issue #888, run 5. TEMPORARY; deleted before the issue closes.
 *
 * Established: predecessor IDENTITY, not count (run 3). The ten poisoners are exactly the
 * states that CLICK INTO A LIVE MATCH -- `.hud-continue`, `.hud-versus-start`, `.hud-new-game`
 * -- so a real WebGL context is created and then thrown away with the page. `captureState`
 * already closes its context in a `finally`, so this is not a leaked context: it is something
 * Chromium keeps at BROWSER level once a GL-bearing page has existed, which then refuses a
 * screenshot of a later page that has no GL context of its own.
 *
 * This run measures which mitigation actually works against the real failing sequence, and
 * what it costs.
 */
import { serve, launchBrowser, captureState } from './capture.mjs';
import { subsetStates } from './baseline.mjs';
import { SCREEN_STATES } from './states.mjs';
import { recipeFor } from './check.mjs';

const TARGET = 'screen.startup.unsupported-render';

async function capture(browser, base, state, { retry = false } = {}) {
  const v = recipeFor(state.id)?.viewport ?? { width: 1280, height: 800, devicePixelRatio: 2 };
  const shoot = () => captureState(browser, base, state, { width: v.width, height: v.height, dpr: v.devicePixelRatio, timeout: 20000 });
  let { report, png } = await shoot();
  if (png === null && retry) ({ report, png } = await shoot());
  return { shot: png !== null, bytes: png?.length ?? 0, err: report.producer.screenshotError };
}

const states = subsetStates(SCREEN_STATES);
const target = states.find((s) => s.id === TARGET);
const prefix = states.filter((s) => s.id !== TARGET).slice(0, 41);
const server = await serve('dist');
const base = `http://127.0.0.1:${server.address().port}/`;

async function arm(label, { retry = false, relaunchEvery = 0, freshEach = false }) {
  const t0 = Date.now();
  let browser = await launchBrowser();
  let launches = 1;
  let i = 0;
  for (const s of prefix) {
    i += 1;
    if (freshEach || (relaunchEvery > 0 && i % relaunchEvery === 1 && i > 1)) {
      await browser.close(); browser = await launchBrowser(); launches += 1;
    }
    try { await capture(browser, base, s, { retry }); } catch { /* prefix failures are not the subject */ }
  }
  if (freshEach) { await browser.close(); browser = await launchBrowser(); launches += 1; }
  let r;
  try { r = await capture(browser, base, target, { retry }); }
  catch (e) { r = { shot: false, bytes: 0, err: `threw ${String(e).split('\n')[0].slice(0, 50)}` }; }
  await browser.close();
  console.log(`${label.padEnd(30)} launches=${String(launches).padStart(2)} seconds=${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} -> target screenshot=${r.shot} bytes=${r.bytes}`);
}

console.log('\n=== which mitigation rescues the target, and at what cost? ===');
await arm('shipped (control)', {});
await arm('retry the screenshot once', { retry: true });
await arm('relaunch every 10 states', { relaunchEvery: 10 });
await arm('fresh browser per state', { freshEach: true });
server.close();
