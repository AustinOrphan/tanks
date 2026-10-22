// #946 criterion 5, the three readings the ruling names, on a built dist served by
// `vite preview` (spawned directly) at /:
//   1. .hud-devtools-open, .hud-devbadge, .hud-devtools: displayed (computed display and
//      visibility walked up from each) and reachable by Tab, ordinary URL vs ?dev=1;
//   2. .hud-devcfg-body and .hud-selftest-list child elements on an ordinary URL;
//   3. own property names of window after boot, ordinary vs ?dev=1, checked against every
//      export name of the 14 developer modules.
// usage: node criterion5.mjs <tree with dist/> <port> <out.json>
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/austinorphan/src/tanks/.claude/worktrees/closing-946';
const [tree, portArg, out] = process.argv.slice(2);
const port = Number(portArg);
const require = createRequire(`${REPO}/package.json`);
const { chromium } = require('playwright');
const { audioContextOverrideSource } = await import(pathToFileURL(`${REPO}/tools/shared/audio-context.mjs`).href);

const DEV = [
  'src/game/devtools-menu.ts', 'src/game/dev-config.ts', 'src/game/dev-config-menu.ts',
  'src/game/dev-actions.ts', 'src/game/dev-exports.ts', 'src/game/dev-diagnostics.ts',
  'src/game/controller-selftest.ts', 'src/game/gallery-workbench.ts', 'src/game/gallery-selection.ts',
  'src/game/gallery-command.ts', 'src/render/gallery/moments.ts', 'src/render/gallery/moment-scene.ts',
  'src/render/gallery/subjects.ts', 'src/render/gallery/workbench-scene.ts',
];
// A <tree> that is a URL is the deployed site: no server, and the export names come from the
// 1c3a193e worktree's source.
const remote = /^https?:\/\//.test(tree);
const sourceRoot = remote ? REPO : tree;
const exportNames = new Set();
for (const f of DEV) {
  const src = readFileSync(join(sourceRoot, f), 'utf8');
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) exportNames.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
      if (name) exportNames.add(name);
    }
  }
}

const server = remote ? { kill() {} } : spawn(join(tree, 'node_modules/.bin/vite'),
  ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
  { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] });
const base = remote ? tree : `http://127.0.0.1:${port}/`;
for (let i = 0; i < 100; i++) {
  try { const r = await fetch(base); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});

const SELECTORS = ['.hud-devtools-open', '.hud-devbadge', '.hud-devtools'];
const readings = (page) => page.evaluate((sels) => {
  const shown = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return { displayed: false, hiddenBy: n.className || n.tagName, why: 'display:none' };
      if (cs.visibility === 'hidden') return { displayed: false, hiddenBy: n.className || n.tagName, why: 'visibility:hidden' };
    }
    return { displayed: true };
  };
  const entries = {};
  for (const s of sels) {
    const all = [...document.querySelectorAll(s)];
    entries[s] = { inDom: all.length, ...(all[0] ? shown(all[0]) : {}), classes: all[0]?.className ?? null };
  }
  const kids = (s) => {
    const el = document.querySelector(s);
    return el ? { childElements: el.childElementCount, innerHTMLLength: el.innerHTML.length } : null;
  };
  return {
    entries,
    devcfgBody: kids('.hud-devcfg-body'),
    selftestList: kids('.hud-selftest-list'),
    galleryBody: kids('.hud-gallery-body'),
    windowProps: Object.getOwnPropertyNames(window),
  };
}, SELECTORS);

// Tab through the page and record every element that takes focus.
const tabWalk = async (page, presses = 80) => {
  const seen = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      return `${a.tagName.toLowerCase()}.${(a.className || '').toString().trim().split(/\s+/).join('.')}`;
    }));
  }
  const distinct = [...new Set(seen.filter(Boolean))];
  return { presses, distinctFocused: distinct.length, distinct };
};

async function arm(name, path, round) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(audioContextOverrideSource());
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  const scripts = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url().replace(base, '/')); });
  await page.goto(base + path, { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('canvas', { state: 'attached', timeout: 60000 });
  await page.keyboard.press('Space');
  await page.waitForSelector('.hud-splash', { state: 'hidden', timeout: 60000 });
  await page.waitForSelector('.hud-new-game', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);
  const menu = await readings(page);
  const tabs = await tabWalk(page);
  const devFocused = tabs.distinct.filter((d) => /hud-devtools|hud-devbadge|hud-devcfg|hud-selftest|hud-diag|hud-export|hud-devact|hud-prodsave|hud-devreset/.test(d));
  let inRound = null;
  if (round) {
    await page.click('.hud-new-game');
    await page.waitForSelector('.hud-panel', { state: 'hidden', timeout: 30000 });
    await page.waitForTimeout(3000);
    const r = await readings(page);
    delete r.windowProps;
    inRound = r;
  }
  await context.close();
  return { path, scripts, errors, failed, menu: { ...menu, windowProps: undefined }, windowProps: menu.windowProps,
    tabs, devFocused, inRound };
}

const result = { tree, base, chromium: browser.version(), devExportNames: exportNames.size };
try {
  result.ordinary = await arm('ordinary', '', true);
  result.dev = await arm('dev', '?dev=1', false);
} finally {
  await browser.close();
  server.kill();
}
const o = new Set(result.ordinary.windowProps);
const d = new Set(result.dev.windowProps);
result.windowDiff = {
  ordinaryCount: o.size, devCount: d.size,
  onlyDev: [...d].filter((p) => !o.has(p)),
  onlyOrdinary: [...o].filter((p) => !d.has(p)),
  devExportNamesOnWindowOrdinary: [...o].filter((p) => exportNames.has(p)),
  devExportNamesOnWindowDev: [...d].filter((p) => exportNames.has(p)),
  underscoreGlobalsOrdinary: [...o].filter((p) => p.startsWith('__')),
  underscoreGlobalsDev: [...d].filter((p) => p.startsWith('__')),
};
delete result.ordinary.windowProps;
delete result.dev.windowProps;
writeFileSync(out, JSON.stringify(result, null, 2));
const show = (label, a) => {
  console.log(`== ${label} ${a.path || '/'}  scripts: ${a.scripts.join(', ')}`);
  console.log(`  page errors ${a.errors.length}, failed requests ${a.failed.length}`);
  for (const [s, e] of Object.entries(a.menu.entries)) console.log(`  menu ${s}: ${JSON.stringify(e)}`);
  console.log(`  menu .hud-devcfg-body ${JSON.stringify(a.menu.devcfgBody)}, .hud-selftest-list ${JSON.stringify(a.menu.selftestList)}, .hud-gallery-body ${JSON.stringify(a.menu.galleryBody)}`);
  console.log(`  tab walk: ${a.tabs.presses} presses, ${a.tabs.distinctFocused} distinct focused: ${a.tabs.distinct.join(' ; ')}`);
  console.log(`  developer controls focused by Tab: ${a.devFocused.length ? a.devFocused.join(', ') : 'none'}`);
  if (a.inRound) {
    for (const [s, e] of Object.entries(a.inRound.entries)) console.log(`  round ${s}: ${JSON.stringify(e)}`);
    console.log(`  round .hud-devcfg-body ${JSON.stringify(a.inRound.devcfgBody)}, .hud-selftest-list ${JSON.stringify(a.inRound.selftestList)}`);
  }
};
show('ordinary', result.ordinary);
show('dev', result.dev);
console.log(`window: ordinary ${result.windowDiff.ordinaryCount}, dev ${result.windowDiff.devCount}; only in dev: ${JSON.stringify(result.windowDiff.onlyDev)}; only in ordinary: ${JSON.stringify(result.windowDiff.onlyOrdinary)}`);
console.log(`developer export names checked: ${exportNames.size}; on window (ordinary): ${JSON.stringify(result.windowDiff.devExportNamesOnWindowOrdinary)}; on window (dev): ${JSON.stringify(result.windowDiff.devExportNamesOnWindowDev)}`);
console.log(`__ globals: ordinary ${JSON.stringify(result.windowDiff.underscoreGlobalsOrdinary)}, dev ${JSON.stringify(result.windowDiff.underscoreGlobalsDev)}`);
