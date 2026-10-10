/**
 * Issue #983 visual evidence: the Versus Setup Map row, before (origin/main) and after (HEAD).
 *
 *   node capture-983.mjs --arm before|after --dist <dist> --out <dir> [--cases a,b] [--layouts x,y]
 *
 * Reuses the worktree's screen-capture pieces rather than a parallel recipe:
 *   - launchBrowser / serve           tools/screens/capture.mjs (software GL, hinting off)
 *   - runStep                         tools/screens/steps.mjs
 *   - audioContextOverrideSource      tools/shared/audio-context.mjs
 *   - saves and reach steps           tools/screens/states.mjs (screen.versus-setup*)
 *   - viewport + DPR                  tools/screens/sweep-plan.mjs LAYOUTS (390x844@2, 1280x800@1)
 * The browser context options mirror captureStateOnce in capture.mjs exactly. The one browser
 * driver serves both arms; only `--dist` differs.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = '/Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow';
const { launchBrowser, serve } = await import(`${REPO}/tools/screens/capture.mjs`);
const { runStep } = await import(`${REPO}/tools/screens/steps.mjs`);
const { audioContextOverrideSource } = await import(`${REPO}/tools/shared/audio-context.mjs`);
const { findScreenState } = await import(`${REPO}/tools/screens/states.mjs`);
const { LAYOUTS } = await import(`${REPO}/tools/screens/sweep-plan.mjs`);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

// ---- Saves and steps, read from the catalogue --------------------------------------------
const base = findScreenState('screen.versus-setup'); // MID_CAMPAIGN, PAST_SPLASH + open
const fresh = findScreenState('screen.versus-setup.fresh'); // storage {}
const teams = findScreenState('screen.versus-setup.teams');
const MID_CAMPAIGN = base.storage;
const FRESH = fresh.storage;
if (Object.keys(FRESH).length !== 0) throw new Error('fresh state is no longer an empty save');
if (JSON.parse(MID_CAMPAIGN['tanks.progress.v1']).levelId !== 'level-02') {
  throw new Error('MID_CAMPAIGN no longer clears levels 1-2');
}
// All five levels cleared: the same save with progress at the last level and no active run
// (an ended run is the key's absence -- src/game/run.ts carries only status 'active').
const ALL_CLEARED = Object.fromEntries(
  Object.entries(MID_CAMPAIGN)
    .filter(([k]) => k !== 'tanks.run.v2')
    .map(([k, v]) => [k, k === 'tanks.progress.v1' ? JSON.stringify({ levelId: 'level-05' }) : v]),
);
const OPEN = base.steps; // [press Space, waitHidden splash, click open, waitVisible setup]
if (OPEN.length !== 4 || OPEN[2].click !== '.hud-versus-open') throw new Error('unexpected OPEN steps');
const TEAMS_CLICK = teams.steps.find((s) => s.click?.includes('[data-mode="teams"]'));
const TEAMS_WAIT = teams.steps.find((s) => s.waitVisible === '.hud-versus-friendlyfire-btn');
if (!TEAMS_CLICK || !TEAMS_WAIT) throw new Error('teams steps moved');
const DUEL = '.hud-versus-map-row [data-map="vs-duel-01"]';

const CASES = [
  { id: 'fresh-2p-ffa', save: 'fresh', storage: FRESH, players: '2', mode: 'ffa', steps: [...OPEN] },
  {
    id: 'fresh-4p-teams', save: 'fresh', storage: FRESH, players: '4', mode: 'teams',
    steps: [
      ...OPEN,
      { waitVisible: DUEL },
      { click: '.hud-versus-players-row [data-players="4"]' },
      { waitHidden: DUEL },
      TEAMS_CLICK,
      TEAMS_WAIT,
    ],
  },
  {
    id: 'mid-3p-ffa', save: 'MID_CAMPAIGN', storage: MID_CAMPAIGN, players: '3', mode: 'ffa',
    steps: [
      ...OPEN,
      { waitVisible: DUEL },
      { click: '.hud-versus-players-row [data-players="3"]' },
      { waitHidden: DUEL },
    ],
  },
  { id: 'cleared-2p-ffa', save: 'all five cleared', storage: ALL_CLEARED, players: '2', mode: 'ffa', steps: [...OPEN] },
];

const LAYOUT_NAMES = ['390x844', '1280x800'];

// ---- One capture ---------------------------------------------------------------------------
async function captureCase(browser, baseUrl, c, layout, outDir) {
  const { width, height, dpr } = layout;
  const pageErrors = [];
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    hasTouch: false,
    isMobile: false,
    javaScriptEnabled: true,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.addInitScript(audioContextOverrideSource());
    if (Object.keys(c.storage).length > 0) {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.evaluate((entries) => {
        localStorage.clear();
        for (const [k, v] of entries) localStorage.setItem(k, v);
      }, Object.entries(c.storage));
    }
    await page.goto(baseUrl, { waitUntil: 'load' });
    for (const step of c.steps) await runStep(page, step, 20000);
    await page.waitForTimeout(250);
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((d) => setTimeout(d, 5000))]));

    // Park the pointer OUTSIDE the viewport. The reach steps leave it where `.hud-versus-open`
    // was clicked, and once the pane scrolls a card lands under it and paints its :hover state
    // -- an artefact of the capture, not of either build. Every screenshot below records what,
    // if anything, is still under :hover, and a hovered map card fails the capture.
    if (!process.argv.includes('--no-park')) await page.mouse.move(-1, -1); // --no-park: negative control
    const hovered = () => page.evaluate(() => {
      const els = [...document.querySelectorAll(':hover')];
      const deepest = els[els.length - 1];
      return {
        count: els.length,
        deepest: deepest ? `${deepest.tagName.toLowerCase()}${deepest.className ? `.${String(deepest.className).trim().split(/\s+/).join('.')}` : ''}` : null,
        mapCard: els.some((e) => e.matches('.hud-versus-map-card')),
      };
    });
    const hoverLog = [];
    const noteHover = async (when) => {
      const h = await hovered();
      hoverLog.push({ when, ...h });
      if (h.mapCard) throw new Error(`${c.id}: a map card is under :hover at ${when}`);
    };

    // The pane as opened (scrolled to its top), for context.
    await noteHover('opened');
    const opened = await page.screenshot();

    const dom = await page.evaluate(() => {
      const row = document.querySelector('.hud-versus-map-row');
      const pressed = (sel, key) => [...document.querySelectorAll(sel)]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset[key]);
      const note = document.querySelector('.hud-versus-map-note');
      const cards = [...row.querySelectorAll('[data-map]')];
      const r = row.getBoundingClientRect();
      return {
        cards: cards.map((b) => ({
          map: b.dataset.map,
          name: b.querySelector('.hud-versus-map-name')?.textContent ?? null,
          config: b.querySelector('.hud-versus-map-config')?.textContent ?? null,
          selected: b.getAttribute('aria-pressed') === 'true',
          box: (() => { const q = b.getBoundingClientRect(); return { w: Math.round(q.width), h: Math.round(q.height) }; })(),
        })),
        players: pressed('.hud-versus-players-row [data-players]', 'players'),
        mode: pressed('.hud-versus-mode-row [data-mode]', 'mode'),
        mapNote: note && !note.classList.contains('hud-versus-map-note--hidden') ? note.textContent.trim() : null,
        rowBox: { w: Math.round(r.width), h: Math.round(r.height) },
        gridTemplateColumns: getComputedStyle(row).gridTemplateColumns,
      };
    });
    if (dom.players.join() !== c.players || dom.mode.join() !== c.mode) {
      throw new Error(`${c.id}: pane shows players=${dom.players} mode=${dom.mode}, expected ${c.players}/${c.mode}`);
    }

    // ---- The Map section (h2 + card row + note), stitched from scrolled slices -------------
    // The pane (`.hud-versus-setup`) is the scroll container; the sticky actions bar covers
    // the bottom of its scrollport, so a slice stops at the bar's top. Viewport unchanged.
    const geometry = () => page.evaluate(() => {
      const row = document.querySelector('.hud-versus-map-row');
      const section = row.closest('.hud-versus-row');
      const pane = document.querySelector('.hud-versus-setup');
      const bar = pane.querySelector('.hud-versus-actions');
      const pr = pane.getBoundingClientRect();
      let vTop = Math.max(0, pr.top + pane.clientTop);
      let vBottom = Math.min(window.innerHeight, pr.top + pane.clientTop + pane.clientHeight);
      const topbar = document.querySelector('.hud-topbar');
      if (topbar) {
        const t = topbar.getBoundingClientRect();
        if (getComputedStyle(topbar).display !== 'none' && t.bottom > vTop && t.top <= vTop) vTop = t.bottom;
      }
      if (bar && getComputedStyle(bar).display !== 'none') {
        const b = bar.getBoundingClientRect();
        if (b.top < vBottom && b.bottom > vTop) vBottom = Math.min(vBottom, b.top);
      }
      const s = section.getBoundingClientRect();
      return { vTop, vBottom, sTop: s.top, sLeft: s.left, sWidth: s.width, sHeight: s.height, scrollTop: pane.scrollTop, scrollMax: pane.scrollHeight - pane.clientHeight };
    });
    const setScroll = (y) => page.evaluate((top) => new Promise((done) => {
      document.querySelector('.hud-versus-setup').scrollTop = top;
      requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)));
    }), y);

    // CSS px of pane background kept above and below the section. Small below, so the next
    // row's selection badge (it overhangs its button upward) stays out of the crop.
    const MARGIN = 8;
    const MARGIN_BOTTOM = 3;
    let g = await geometry();
    const sectionTop0 = g.sTop - g.vTop + g.scrollTop; // section top within the scroll content
    const total = Math.ceil(g.sHeight) + MARGIN + MARGIN_BOTTOM;
    const start = sectionTop0 - MARGIN;
    const slices = [];
    let covered = 0;
    let guard = 0;
    while (covered < total && guard++ < 40) {
      await setScroll(Math.max(0, Math.floor(start + covered)));
      g = await geometry();
      const want = g.sTop - MARGIN + covered; // viewport y of the next uncovered line
      const top = Math.max(want, g.vTop);
      if (top > want + 0.5) throw new Error(`${c.id}: slice ${slices.length} starts below its target (${top} > ${want})`);
      const bottom = Math.min(g.sTop - MARGIN + total, g.vBottom);
      const h = Math.floor(bottom - top);
      if (h <= 0) throw new Error(`${c.id}: empty slice at covered=${covered}`);
      const clip = { x: Math.max(0, Math.floor(g.sLeft)), y: top, width: Math.min(width, Math.ceil(g.sWidth)), height: h };
      await noteHover(`slice ${slices.length}`);
      const png = await page.screenshot({ clip });
      const name = `slice-${String(slices.length).padStart(2, '0')}.png`;
      slices.push({ file: name, offset: covered, height: h, scrollTop: g.scrollTop, clip });
      await mkdir(join(outDir, 'slices'), { recursive: true });
      await writeFile(join(outDir, 'slices', name), png);
      covered += h;
    }
    if (covered < total) throw new Error(`${c.id}: stitched ${covered} of ${total}`);

    // The viewport with the Map section brought to the top of the scrollport.
    await setScroll(Math.max(0, Math.floor(start)));
    await noteHover('viewport');
    const inView = await page.screenshot();

    await writeFile(join(outDir, 'opened.png'), opened);
    await writeFile(join(outDir, 'viewport.png'), inView);
    const report = {
      case: c.id, save: c.save, layout: layout.name, viewport: { width, height, dpr },
      storage: c.storage, steps: c.steps, dom,
      stitch: { totalCss: total, marginCss: MARGIN, marginBottomCss: MARGIN_BOTTOM, slices, scrollMax: g.scrollMax },
      hover: hoverLog,
      pageErrors,
    };
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await context.close();
  }
}

// ---- Main ----------------------------------------------------------------------------------
const arm = arg('arm');
const dist = resolve(arg('dist'));
const out = resolve(arg('out'));
if (!['before', 'after'].includes(arm)) throw new Error('--arm before|after');
if (!existsSync(join(dist, 'index.html'))) throw new Error(`no index.html under ${dist}`);
const onlyCases = arg('cases')?.split(',');
const onlyLayouts = arg('layouts')?.split(',') ?? LAYOUT_NAMES;
const layouts = onlyLayouts.map((n) => {
  const l = LAYOUTS.find((x) => x.name === n);
  if (!l) throw new Error(`unknown layout ${n}`);
  return l;
});

const browser = await launchBrowser();
const server = await serve(dist);
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
let failed = 0;
try {
  for (const c of CASES.filter((x) => !onlyCases || onlyCases.includes(x.id))) {
    for (const layout of layouts) {
      const dir = join(out, c.id, layout.name, arm);
      await mkdir(dir, { recursive: true });
      try {
        const r = await captureCase(browser, baseUrl, c, layout, dir);
        console.log(`${arm} ${c.id} ${layout.name}: ${r.dom.cards.length} cards [${r.dom.cards.map((x) => x.map).join(' ')}] slices=${r.stitch.slices.length} pageErrors=${r.pageErrors.length}`);
      } catch (e) {
        failed += 1;
        console.error(`${arm} ${c.id} ${layout.name}: FAILED ${e?.stack ?? e}`);
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
