// Issue #1022 evidence driver. Boots a built dist through the repository's own `versus-round`
// flow (the same storage, splash, diagnostics detour and Level Select steps record.mjs runs),
// reads the stock strip from the DOM, shoots the topbar, then keeps the match running until
// the first stock is lost and shoots a burst through the loss cue.
//
//   node drive.mjs --dist D --arm head|main --case ffa-2p|ffa-4p|teams-4p|reversal-ffa-4p \
//     --w 1280 --h 800 --dpr 2 --reduced 0|1 --seed 7 --level 1 --loss 1|0 --lossBudget 120 --out O
//
// Uses the worktree's tools for both arms (tools/screens and tools/shared are identical on
// origin/main and HEAD), so the only variable between arms is the served bundle.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const WT = '/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow';
const { findFlow, buildFlowUrl, parseDiagnostics } = await import(`${WT}/tools/screens/flow.mjs`);
const { runStep } = await import(`${WT}/tools/screens/steps.mjs`);
const { serve } = await import(`${WT}/tools/screens/capture.mjs`);
const { audioContextOverrideSource } = await import(`${WT}/tools/shared/audio-context.mjs`);
const { loadChromium } = await import(`${WT}/tools/shared/playwright.mjs`);
const { launchArgumentsFor } = await import(`${WT}/tools/screens/record.mjs`);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, token, i, all) => {
    if (token.startsWith('--')) acc.push([token.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const CASES = {
  'ffa-2p': { mode: 'ffa', players: 2, flags: {} },
  'ffa-4p': { mode: 'ffa', players: 4, flags: {} },
  'teams-4p': { mode: 'teams', players: 4, flags: {} },
  'reversal-ffa-4p': { mode: 'ffa', players: 4, flags: { identityMarker: 'solid' } },
};
const c = CASES[args.case];
if (!c) throw new Error(`unknown case ${args.case}`);
const viewport = { width: Number(args.w), height: Number(args.h) };
const dpr = Number(args.dpr ?? 2);
const reduced = args.reduced === '1';
const wantLoss = args.loss !== '0';
const lossBudgetMs = Number(args.lossBudget ?? 120) * 1000;
const out = args.out;
const timeout = 60000;
await mkdir(out, { recursive: true });

const flow = findFlow('versus-round');
const inputs = {
  level: Number(args.level ?? 1), seed: Number(args.seed ?? 7), driver: 'autoplay',
  flags: c.flags, mode: c.mode, players: c.players, bots: c.players,
};
const url = buildFlowUrl(inputs);

const PLAYING_IN = `(() => {
  const touch = document.querySelector('.hud-touch');
  const panel = document.querySelector('.hud-panel');
  const count = document.querySelector('.hud-count');
  const playing = touch !== null && !touch.classList.contains('hud-touch--hidden');
  const panelHidden = panel === null || getComputedStyle(panel).display === 'none';
  const countdown = count !== null && !count.classList.contains('hud-count--hidden');
  return { playing, panelHidden, countdown };
})()`;

/** Everything the strip says about itself, read from the DOM. */
const READ_STRIP = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const strip = document.querySelector('.hud-versus-stocks');
  const topbar = document.querySelector('.hud-topbar');
  const r = strip.getBoundingClientRect();
  const b = topbar.getBoundingClientRect();
  const entries = [...strip.querySelectorAll('.hud-versus-stock-entry')].map((e) => {
    const img = e.querySelector('[role="img"]');
    return {
      text: e.textContent,
      name: img ? img.getAttribute('aria-label') : null,
      color: e.style.color,
      marks: e.querySelectorAll('.hud-stock-mark').length,
      marksLost: e.querySelectorAll('.hud-stock-mark--lost').length,
      pips: e.querySelectorAll('.hud-stock-pip').length,
      pipsLost: e.querySelectorAll('.hud-stock-pip--lost').length,
      leadingMarker: e.querySelectorAll('.hud-stock-marker').length,
      count: (e.querySelector('.hud-stock-mark-count, .hud-stock-pip-count') || {}).textContent ?? null,
      cue: e.querySelectorAll('.hud-stock-cue').length,
      classes: [...new Set([...e.querySelectorAll('*')].flatMap((n) => [...n.classList]))].sort(),
    };
  });
  const cues = [...strip.querySelectorAll('.hud-stock-cue')].map((el) => {
    const anims = el.getAnimations().map((a) => {
      const t = a.effect.getComputedTiming();
      return { name: a.animationName ?? null, localTime: t.localTime === null ? null : round(t.localTime), progress: t.progress === null ? null : Math.round(t.progress * 1000) / 1000, duration: t.duration, playState: a.playState };
    });
    const cs = getComputedStyle(el);
    return { cls: [...el.classList].join(' '), delay: el.style.animationDelay, transform: cs.transform, scale: cs.scale, anims };
  });
  const replay = globalThis.__tanks && globalThis.__tanks.replay;
  return {
    ticks: typeof replay === 'function' ? replay().ticks.length : null,
    now: performance.now(),
    strip: { left: round(r.left), right: round(r.right), width: round(r.width), top: round(r.top), height: round(r.height) },
    topbar: { left: round(b.left), top: round(b.top), width: round(b.width), height: round(b.height), contentRight: round(b.right - parseFloat(getComputedStyle(topbar).paddingRight)) },
    font: getComputedStyle(strip).fontFamily,
    narrow: matchMedia('(max-width: 480px)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    hudReducedClass: document.querySelector('.hud')?.classList.contains('hud--reduced-motion') ?? null,
    entries,
    cues,
  };
})()`;

/** A per-entry stock reading that sees BOTH arms change: the row's name, else the text. */
const STOCK_KEY = `(() => [...document.querySelectorAll('.hud-versus-stocks .hud-versus-stock-entry')]
  .map((e) => (e.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '') + '|' + e.textContent).join(';'))()`;

const facts = { arm: args.arm, case: args.case, viewport, dpr, reduced, url, dist: args.dist };
const server = await serve(args.dist);
const base = `http://127.0.0.1:${server.address().port}/`;
const chromium = await loadChromium();
const browser = await chromium.launch({ headless: true, args: launchArgumentsFor('host-gpu') });
try {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: dpr, reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  await context.addInitScript(audioContextOverrideSource());
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((entries) => {
    localStorage.clear();
    for (const [k, v] of entries) localStorage.setItem(k, v);
  }, Object.entries(flow.storage));
  await page.goto(`${base}${url}`, { waitUntil: 'load' });
  for (const step of flow.open) await runStep(page, step, timeout);
  for (const step of [
    { click: '.hud-devtools-open' }, { waitVisible: '.hud-devtools' },
    { click: '.hud-diag-copy' }, { waitVisible: '.hud-diag-out' },
  ]) await runStep(page, step, timeout);
  facts.diagnostics = parseDiagnostics(await page.evaluate("document.querySelector('.hud-diag-out').value"));
  await runStep(page, { click: '.hud-devtools-back' }, timeout);
  for (const step of flow.start(inputs)) await runStep(page, step, timeout);
  await page.waitForFunction(`(() => { const s = ${PLAYING_IN}; return s.playing && s.panelHidden && !s.countdown; })()`, undefined, { timeout });
  facts.world = await page.evaluate(`(() => { const m = globalThis.__tanks.replay().meta; return { seed: m.seed, arenaId: m.arenaId }; })()`);
  // Let one more status push land so the strip is the settled start-of-round one.
  await page.waitForTimeout(500);
  const start = await page.evaluate(READ_STRIP);
  facts.start = start;
  const clipFor = (s) => ({
    x: 0, y: Math.max(0, s.topbar.top - 4), width: viewport.width, height: Math.ceil(s.topbar.height + 8),
  });
  await page.screenshot({ path: join(out, 'start-full.png') });
  await page.screenshot({ path: join(out, 'start-topbar.png'), clip: clipFor(start) });

  if (wantLoss) {
    const key0 = await page.evaluate(STOCK_KEY);
    let detected = null;
    try {
      await page.waitForFunction(
        ({ k, src }) => (0, eval)(src) !== k,
        { k: key0, src: STOCK_KEY },
        { timeout: lossBudgetMs, polling: 'raf' },
      );
      detected = Date.now();
    } catch {
      facts.loss = { found: false, budgetMs: lossBudgetMs };
    }
    if (detected !== null) {
      const shots = [];
      const t0 = detected;
      for (let i = 0; Date.now() - t0 < 1100 && i < 40; i++) {
        const before = await page.evaluate(READ_STRIP);
        const file = `cue-${String(i).padStart(2, '0')}.png`;
        await page.screenshot({ path: join(out, file), clip: clipFor(before) });
        const after = await page.evaluate(READ_STRIP);
        shots.push({ file, msSinceDetect: Date.now() - t0, before, after });
      }
      await page.waitForTimeout(1200);
      const settled = await page.evaluate(READ_STRIP);
      await page.screenshot({ path: join(out, 'settled-topbar.png'), clip: clipFor(settled) });
      await page.screenshot({ path: join(out, 'settled-full.png') });
      facts.loss = { found: true, startTicks: start.ticks, shots, settled };
    }
  }
  facts.pageErrors = pageErrors;
  await context.close();
} finally {
  await browser.close();
  await new Promise((ok) => server.close(ok));
}
await writeFile(join(out, 'facts.json'), JSON.stringify(facts, null, 2));
const s = facts.start;
console.log(`${facts.arm} ${facts.case} ${viewport.width}x${viewport.height}${reduced ? ' reduced' : ''}: arena ${facts.world.arenaId} seed ${facts.world.seed}; `
  + `strip right ${s.strip.right} of ${s.topbar.contentRight}; entries ${JSON.stringify(s.entries.map((e) => [e.text, e.name, e.marks, e.pips, e.leadingMarker]))}; `
  + `loss ${facts.loss ? (facts.loss.found ? `at tick ~${facts.loss.shots[0].before.ticks} (${facts.loss.shots.length} shots)` : 'not found') : 'skipped'}; errors ${facts.pageErrors.length}`);
