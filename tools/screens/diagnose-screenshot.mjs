/**
 * Issue #888: why `Page.captureScreenshot` fails on the two WebGL-refused states.
 *
 * TEMPORARY. Exists to be run once on a Linux runner and deleted; it is a diagnostic, not a
 * tool. One run answers the question AND tests every candidate fix, because the failure does
 * not reproduce on macOS and a CI round trip per idea is the whole cost of this issue.
 */
import { serve, launchBrowser } from './capture.mjs';
import { webglOverrideSource, audioContextOverrideSource } from './steps.mjs';

const BASE_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--font-render-hinting=none'];

/** Each arm is a candidate fix; `none` is the shipped configuration. */
const ARMS = [
  { id: 'shipped', args: [], perContext: false, retry: false, beyondViewport: false },
  { id: 'retry-once', args: [], perContext: false, retry: true, beyondViewport: false },
  { id: 'fresh-context', args: [], perContext: true, retry: false, beyondViewport: false },
  { id: 'beyond-viewport', args: [], perContext: false, retry: false, beyondViewport: true },
  { id: 'disable-gpu', args: ['--disable-gpu'], perContext: false, retry: false, beyondViewport: false },
  { id: 'angle-swiftshader', args: ['--use-angle=swiftshader'], perContext: false, retry: false, beyondViewport: false },
];

/** The four states that bracket the failure: two that work, two that do not. */
const MODES = ['ok', 'match-build-fails', 'unsupported', 'probe-blocked'];

async function shoot(browser, base, mode, arm) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  await page.addInitScript(audioContextOverrideSource());
  if (mode !== 'ok') await page.addInitScript(webglOverrideSource(mode));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector(mode === 'ok' ? '.hud-splash' : '[role="alert"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length).catch(() => -1);
  const opts = arm.beyondViewport ? { captureBeyondViewport: true } : {};
  let result = 'ok'; let bytes = 0;
  try {
    const png = await page.screenshot(opts);
    bytes = png.length;
  } catch (e) {
    result = String(e).split('\n')[0].slice(0, 90);
    if (arm.retry) {
      await page.waitForTimeout(250);
      try { const png = await page.screenshot(opts); bytes = png.length; result = 'ok-on-retry'; }
      catch (e2) { result = `retry also failed: ${String(e2).split('\n')[0].slice(0, 60)}`; }
    }
  }
  await context.close();
  return { result, bytes, canvases, errors: errors.length };
}

const server = await serve('dist');
const base = `http://127.0.0.1:${server.address().port}/`;
console.log('| arm | mode | screenshot | bytes | canvases | pageErrors |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const arm of ARMS) {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = arm.args.length === 0 ? await launchBrowser() : await chromium.launch({ args: [...BASE_ARGS, ...arm.args] });
  } catch (e) { console.log(`| ${arm.id} | - | LAUNCH FAILED ${String(e).slice(0, 60)} | | | |`); continue; }
  for (const mode of MODES) {
    let row;
    try { row = await shoot(browser, base, mode, arm); }
    catch (e) { row = { result: `threw: ${String(e).split('\n')[0].slice(0, 70)}`, bytes: 0, canvases: -1, errors: -1 }; }
    console.log(`| ${arm.id} | ${mode} | ${row.result} | ${row.bytes} | ${row.canvases} | ${row.errors} |`);
  }
  await browser.close();
}
server.close();
