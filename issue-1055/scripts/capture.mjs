/**
 * Issue #1055 visual evidence: the teams stock strip at a 390x844 viewport, before and after.
 *
 *   node capture.mjs <worktree> <trees-dir> <out-dir>
 *
 * <trees-dir>/before and <trees-dir>/after are `git archive` exports (src, package.json,
 * tsconfig.json) of the branch's merge base and of HEAD, each with node_modules linked to the
 * worktree's and with HEAD's `tools/hud/strip-width-page.ts` + `strip-width.html` in it. This
 * script copies `cue.html` + `cue-page.ts` (beside it) into each tree, serves each tree with
 * the worktree's Vite on its own port, and drives the worktree's Playwright Chromium.
 *
 * Three passes (before, after, and after again as the noise floor), each of two parts:
 *   rest  -- HEAD's own `window.measureStrip` (the page `tools/hud/strip-width.mjs` drives) for
 *            all 10 teams configurations, cropped to the topbar.
 *   cue   -- `cue-page.ts`: a stock loss on the one-pip fallback, frozen at fixed times into the
 *            cue and held 1.5s after it in real time, with full and reduced motion.
 *
 * Writes PNGs under <out-dir>/png and every reading to <out-dir>/readings.json. Nothing in the
 * worktree is written; Vite's dependency cache goes to <trees-dir>/.vite-<tree>.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const [WORKTREE, TREES, OUT] = process.argv.slice(2);
if (!WORKTREE || !TREES || !OUT) {
  console.error('usage: node capture.mjs <worktree> <trees-dir> <out-dir>');
  process.exit(2);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const { createServer } = await import(pathToFileURL(join(WORKTREE, 'node_modules/vite/dist/node/index.js')).href);
const { loadChromium } = await import(pathToFileURL(join(WORKTREE, 'tools/shared/playwright.mjs')).href);

const VIEWPORT = { width: 390, height: 844 };
const DPR = 3;
/**
 * Three passes: the two trees, then HEAD's tree a second time. `repeat` is the noise floor: any
 * pixel it differs from `after` by is the harness, not the stylesheet.
 */
const PASSES = [
  { name: 'before', tree: 'before', port: 5191 },
  { name: 'after', tree: 'after', port: 5192 },
  { name: 'repeat', tree: 'after', port: 5193 },
];

/** Lettered A, B, A, B, as `tools/hud/strip-width.mjs` (HEAD) builds the teams report. */
const teams = (players, total) =>
  Array.from({ length: players }, (_, slot) => ({ slot, stock: total, team: slot % 2 }));
const ffa = (players, total) => Array.from({ length: players }, (_, slot) => ({ slot, stock: total }));
/** `base` with slot 0's stock set to `stock`. */
const p1At = (base, stock) => base.map((s) => (s.slot === 0 ? { ...s, stock } : s));

/**
 * The cue scenarios. `steps` are later pushes; a step `{ wait }` sleeps in real time. The last
 * push is the loss that is photographed.
 */
const SCENARIOS = [
  {
    id: 'teams-4x5-first-loss', cue: 'marks', changed: true,
    title: 'Teams, 4 players x 5 stocks: P1 A goes 5 -> 4 (one-pip fallback, still holding stock)',
    start: teams(4, 5), steps: [p1At(teams(4, 5), 4)],
  },
  {
    id: 'teams-4x4-first-loss', cue: 'marks', changed: true,
    title: 'Teams, 4 players x 4 stocks: P1 A goes 4 -> 3 (one-pip fallback, still holding stock)',
    start: teams(4, 4), steps: [p1At(teams(4, 4), 3)],
  },
  {
    id: 'teams-4x5-to-one', cue: 'marks', changed: true,
    title: 'Teams, 4 players x 5 stocks: P1 A goes 2 -> 1 (one-pip fallback, last stock held)',
    start: teams(4, 5), steps: [p1At(teams(4, 5), 2), { wait: 800 }, p1At(teams(4, 5), 1)],
  },
  {
    id: 'teams-4x4-out-control', cue: 'marks', changed: false,
    title: 'CONTROL. Teams, 4 x 4: P1 A goes 1 -> 0 (pip is --lost; the new rule must not match)',
    start: teams(4, 4), steps: [p1At(teams(4, 4), 1), { wait: 800 }, p1At(teams(4, 4), 0)],
  },
  {
    id: 'teams-3x5-row-control', cue: 'marks', changed: false,
    title: 'CONTROL. Teams, 3 x 5 (9/2 row): P1 A goes 5 -> 4 (row cue pip is --lost; unchanged)',
    start: teams(3, 5), steps: [p1At(teams(3, 5), 4)],
  },
  {
    id: 'ffa-4x5-first-loss', cue: 'pips', changed: true,
    title: 'Supplementary, FFA under `pips`, 4 x 5: P1 goes 5 -> 4 (the same shared fallback rule)',
    start: ffa(4, 5), steps: [p1At(ffa(4, 5), 4)],
  },
];
const FRAMES_MS = [0, 105, 210, 350, 525, 700];
const HELD_MS = 1500;

mkdirSync(join(OUT, 'png'), { recursive: true });
const readings = { viewport: VIEWPORT, dpr: DPR, framesMs: FRAMES_MS, heldMs: HELD_MS, trees: {} };

async function respondsOn(url, ms = 1000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return false;
  }
}

const pad = (b, px, py = px) => ({ x: b.x - px, y: b.y - py, width: b.width + 2 * px, height: b.height + 2 * py });
/** The topbar, full viewport width, with a few px above and below. */
const topbarClip = (r) => ({ x: 0, y: Math.max(0, r.topbar.y - 4), width: VIEWPORT.width, height: r.topbar.height + 8 });
/** The first entry, with room for the 1.6x swell and the 2.2x burst ring. */
const entryClip = (r) => {
  const e = r.entries[0];
  const cy = e.y + e.height / 2;
  return { x: Math.max(0, e.x - 14), y: Math.max(0, cy - 26), width: e.width + 28, height: 52 };
};

const chromium = await loadChromium();
const browser = await chromium.launch();
const pageErrors = [];
try {
  for (const { name: tree, tree: dirName, port } of PASSES) {
    const root = join(TREES, dirName);
    mkdirSync(join(root, 'tools/media-1055'), { recursive: true });
    copyFileSync(join(HERE, 'cue.html'), join(root, 'tools/media-1055/cue.html'));
    copyFileSync(join(HERE, 'cue-page.ts'), join(root, 'tools/media-1055/cue-page.ts'));
    const base = `http://localhost:${port}/`;
    if (await respondsOn(base)) throw new Error(`${base} is already serving; refusing to measure it`);
    const server = await createServer({
      root, configFile: false, cacheDir: join(TREES, `.vite-${dirName}`), logLevel: 'warn',
      server: { port, strictPort: true, fs: { strict: false } },
    });
    await server.listen();
    const tr = { root, tree: dirName, rest: [], cue: [] };
    readings.trees[tree] = tr;
    try {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR });
      const open = async (path, ready) => {
        const page = await context.newPage();
        page.on('pageerror', (e) => pageErrors.push(`${tree} ${path}: ${e}`));
        await page.goto(base + path, { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction((k) => window[k] === true, ready, { timeout: 60000 });
        return page;
      };

      // REST: HEAD's measureStrip, the page strip-width.mjs measures.
      const rest = await open('tools/hud/strip-width.html', 'stripReady');
      for (const players of [3, 4]) {
        for (let stocks = 1; stocks <= 5; stocks++) {
          const pipsHtml = (await rest.evaluate(([s]) => window.measureStrip('pips', s), [teams(players, stocks)])).html;
          const r = await rest.evaluate(([s]) => window.measureStrip('marks', s), [teams(players, stocks)]);
          const topbar = await rest.evaluate(() => {
            const b = document.querySelector('.hud-topbar').getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height };
          });
          const file = `png/rest/${tree}-teams-${players}x${stocks}.png`;
          mkdirSync(join(OUT, 'png/rest'), { recursive: true });
          await rest.screenshot({ path: join(OUT, file), clip: topbarClip({ topbar }) });
          tr.rest.push({
            players, stocks, file, layout: r.layout, width: r.width, right: r.right, edge: r.edge,
            spare: Math.round((r.edge - r.right) * 10) / 10, face: r.face, labels: r.labels,
            sameUnderPips: pipsHtml === r.html,
          });
        }
      }
      await rest.close();

      // CUE: a loss on the same HUD, frozen at fixed times, then held in real time.
      const cuePage = await open('tools/media-1055/cue.html', 'cueReady');
      const run = (s, reduced) => cuePage.evaluate(async ([sc, red]) => {
        await window.mountStrip(sc.cue, sc.start, red);
        let r = null;
        for (const step of sc.steps) {
          if (step.wait !== undefined) await new Promise((res) => setTimeout(res, step.wait));
          else r = window.pushStrip(step);
        }
        return r;
      }, [s, reduced]);
      for (const s of SCENARIOS) {
        for (const reduced of [false, true]) {
          const motion = reduced ? 'reduced' : 'full';
          const dir = `png/cue/${s.id}`;
          mkdirSync(join(OUT, dir), { recursive: true });
          const atLoss = await run(s, reduced);
          const frames = [];
          for (const ms of FRAMES_MS) {
            const r = await cuePage.evaluate((t) => window.freezeStrip(t), ms);
            const file = `${dir}/${tree}-${motion}-t${String(ms).padStart(4, '0')}.png`;
            await cuePage.screenshot({ path: join(OUT, file), clip: entryClip(r) });
            frames.push({ ms, file, pip: r.pip });
          }
          // HELD: a fresh run, left alone for HELD_MS of real time, nothing frozen.
          await run(s, reduced);
          await sleep(HELD_MS);
          const held = await cuePage.evaluate(() => window.readStrip());
          const heldTopbar = `${dir}/${tree}-${motion}-held-topbar.png`;
          const heldEntry = `${dir}/${tree}-${motion}-held-entry.png`;
          await cuePage.screenshot({ path: join(OUT, heldTopbar), clip: topbarClip(held) });
          await cuePage.screenshot({ path: join(OUT, heldEntry), clip: entryClip(held) });
          tr.cue.push({
            id: s.id, motion, atLoss: { pipClasses: atLoss.pipClasses, animations: atLoss.animations },
            frames, held: {
              topbar: heldTopbar, entry: heldEntry, pip: held.pip, pipClasses: held.pipClasses,
              animations: held.animations, face: held.face,
              stripRight: held.strip.x + held.strip.width, edge: held.edge,
            },
          });
        }
      }
      await cuePage.close();
      await context.close();
    } finally {
      await server.close();
    }
  }
} finally {
  await browser.close();
}
readings.scenarios = SCENARIOS.map(({ id, title, cue, changed }) => ({ id, title, cue, changed }));
readings.pageErrors = pageErrors;
writeFileSync(join(OUT, 'readings.json'), `${JSON.stringify(readings, null, 2)}\n`);
for (const e of pageErrors) console.error(`page error: ${e}`);
console.log(`wrote ${join(OUT, 'readings.json')}`);
if (pageErrors.length > 0) process.exitCode = 1;
