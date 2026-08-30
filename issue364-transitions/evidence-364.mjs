/**
 * Visual evidence for issue #364 -- the one interruptible transition contract.
 *
 * Run against a SERVED PRODUCTION BUILD, once per ref, with the same browser binary:
 *
 *   node /tmp/evidence-364.mjs --url http://127.0.0.1:5051/ --out /tmp/ev/main --label main
 *
 * Three captures, each with an explicit control:
 *
 *  1. `cut-vs-crossfade` -- the Main Menu -> Stats navigation sampled at three points.
 *     `--ui-transition-duration` is overridden to 1500ms through an injected stylesheet
 *     so a 150ms crossfade is samplable at all by a screenshot that costs tens of ms.
 *     The SAME injection runs on both refs, which is what makes it a control rather than
 *     a thumb on the scale: `main` declares no such token and nothing there reads one, so
 *     the injection is inert and `main` still swaps in a single frame.
 *  2. `real-timing` -- the same navigation with NO injection, recorded as video at the
 *     shipped 150ms, so the evidence is not only of the slowed shape.
 *  3. `reduced-motion` -- the same navigation in a context with
 *     `prefers-reduced-motion: reduce`, which the default `'system'` setting resolves to
 *     true. On the branch the swap is instant; nothing is mid-transition at t=0.
 *
 * Every frame is written with the ref label baked into its filename, so a pair cannot be
 * mixed up after the fact.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg('url');
const out = arg('out');
const label = arg('label');
if (!url || !out || !label) {
  console.error('usage: --url <url> --out <dir> --label <ref-label>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const VIEWPORT = { width: 1280, height: 800 };
const SLOW_MS = 30000;

/** Dismiss the Launch gate and land on the Main Menu, settled. */
async function toMainMenu(page) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('.hud-splash', { state: 'attached' });
  await page.waitForTimeout(600);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
}

/** What the page can tell us about the frame, in one readable record. */
async function probe(page) {
  return page.evaluate(() => {
    const cls = (sel) => {
      const el = document.querySelector(sel);
      return el ? [...el.classList].join(' ') : '(absent)';
    };
    const shown = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { display: cs.display, opacity: Number(cs.opacity).toFixed(3) };
    };
    return {
      panel: { classes: cls('.hud-panel'), style: shown('.hud-panel') },
      stats: { classes: cls('.hud-stats'), style: shown('.hud-stats') },
      splash: { classes: cls('.hud-splash'), style: shown('.hud-splash') },
      ground: { classes: cls('.ui-app-ground'), style: shown('.ui-app-ground') },
      token: getComputedStyle(document.documentElement)
        .getPropertyValue('--ui-transition-duration')
        .trim(),
    };
  });
}

const record = {};

const browser = await chromium.launch();

// ---- 1. cut vs crossfade, slowed so a screenshot can see it -----------------------
{
  const ctx = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  await toMainMenu(page);
  // The SAME injection on both refs. `main` has no `--ui-transition-duration` consumer,
  // so this is inert there.
  await page.addStyleTag({ content: `:root { --ui-transition-duration: ${SLOW_MS}ms; }` });
  await page.waitForTimeout(200);

  const samples = [];
  await page.click('.hud-stats-open');
  // BRACKETED: the DOM is read immediately before and immediately after each screenshot,
  // so the frame that was captured is pinned between two measured states rather than
  // described by one taken at a different moment. A screenshot on this machine costs
  // hundreds of milliseconds, which is why the token is slowed to 8000ms -- at the
  // shipped 150ms every "sample" landed on the settled frame and all three files came
  // back byte-identical. That failure is what the `before`/`after` pair now makes
  // impossible to miss.
  // Back to back, with ONE long wait at the end. A screenshot on this machine costs
  // seconds, so the capture cost itself is the sampling interval -- adding waits between
  // them only pushed every frame past the end of the animation.
  const started = Date.now();
  for (const [name, wait] of [
    ['a-early', 0],
    ['b-middle', 0],
    ['c-late', 0],
    ['d-settled', 32000],
  ]) {
    if (wait) await page.waitForTimeout(wait);
    const before = await probe(page);
    const at = Date.now() - started;
    await page.screenshot({ path: join(out, `slowed-${name}-${label}.png`), animations: 'allow' });
    const after = await probe(page);
    samples.push({ name, atMs: at, before, after });
  }
  record.slowed = samples;
  await ctx.close();
}

// ---- 2. the shipped 150ms, as video ------------------------------------------------
{
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    reducedMotion: 'no-preference',
    recordVideo: { dir: join(out, 'video'), size: VIEWPORT },
  });
  const page = await ctx.newPage();
  await toMainMenu(page);
  await page.click('.hud-stats-open');
  await page.waitForTimeout(1200);
  await ctx.close(); // flushes the video
}

// ---- 3. reduced motion --------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await toMainMenu(page);
  await page.addStyleTag({ content: `:root { --ui-transition-duration: ${SLOW_MS}ms; }` });
  await page.waitForTimeout(200);
  await page.click('.hud-stats-open');
  // NO wait: if the swap is instant, the outgoing panel is already gone in this frame,
  // even with the duration token slowed to 1500ms.
  const before = await probe(page);
  await page.screenshot({ path: join(out, `reduced-t000-${label}.png`), animations: 'allow' });
  record.reduced = { before, after: await probe(page) };
  await ctx.close();
}

await browser.close();
writeFileSync(join(out, `probe-${label}.json`), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
