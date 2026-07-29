#!/usr/bin/env node
/**
 * Render any game element as stills, an animation, or a labelled sweep grid.
 *
 * Everything it draws goes through the REAL render modules against a REAL World, so a
 * shape defect here is a shape defect in the game. That matters: screenshots have already
 * caught two things every unit test passed -- a shell nose that was an open hemisphere,
 * visible only from overhead, and blast growth that was linear when it should ease out.
 *
 *   npm run gallery -- --subject mine --view low
 *   npm run gallery -- --subject blast --anim --out blast.gif
 *   npm run gallery -- --subject mine --view low --sweep MINE_DOME_H --values 0.04,0.08,0.12
 *
 * --sweep patches a constant in src/ between passes. The original is restored in a
 * finally block, and the runner refuses to start if the file is already dirty, so an
 * interrupted sweep cannot leave edited constants behind.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs, safeLabel, gridShape } from './args.mjs';

const PORT = 5599;
const ROOT = new URL('../../', import.meta.url).pathname;
const PW = process.env.PLAYWRIGHT_MODULE ?? 'playwright';

const args = parseArgs(process.argv.slice(2));
const outDir = args.out.endsWith('.gif') || args.out.endsWith('.png')
  ? `${ROOT}gallery-out` : `${ROOT}${args.out}`;
const outFile = args.out.endsWith('.gif') || args.out.endsWith('.png')
  ? `${ROOT}${args.out}` : null;

function sh(cmd, argv) {
  return execFileSync(cmd, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function has(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Files a sweep will edit. Refuse to run if any is already modified. */
function assertClean(files) {
  const dirty = sh('git', ['status', '--porcelain', '--', ...files]).trim();
  if (dirty) {
    console.error('refusing to sweep with uncommitted changes in the files it patches:');
    console.error(dirty);
    console.error('commit or stash them first -- a sweep rewrites these and restores them after.');
    process.exit(2);
  }
}

function findConstant(name) {
  const roots = ['src/render', 'src/sim'];
  for (const dir of roots) {
    for (const f of readdirSync(`${ROOT}${dir}`)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const path = `${ROOT}${dir}/${f}`;
      const src = readFileSync(path, 'utf8');
      const re = new RegExp(`(const\\s+${name}\\s*=\\s*)([^;]+)(;)`);
      if (re.test(src)) return { path, rel: `${dir}/${f}`, re };
    }
  }
  throw new Error(`could not find a constant named ${name} under src/render or src/sim`);
}

let vite;
async function main() {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith('.png')) rmSync(`${outDir}/${f}`);

  vite = spawn(`${ROOT}node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 3500));

  const { chromium } = await import(PW);
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  // Every path out of here must close the browser. It did not, and an error inside the
  // sweep loop left node alive on the open Chromium handle -- the run did not fail, it
  // HUNG, which is far worse to diagnose.
  try {
    await run(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function run(browser) {
  const page = await browser.newPage({ viewport: { width: args.w + 40, height: args.h + 40 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const q = (extra = {}) => {
    const p = new URLSearchParams({ elements: args.elements, view: args.view, w: String(args.w), h: String(args.h), ...extra });
    if (args.reach) p.set('reach', '1');
    if (args.timer) p.set('timer', '1');
    if (args.fill) p.set('fill', '1');
    return `http://localhost:${PORT}/tools/gallery/index.html?${p}`;
  };

  async function capture(prefix) {
    await page.goto(q(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.GALLERY_READY === true, { timeout: 20000 });
    const frames = await page.evaluate(() => window.GALLERY_FRAMES);
    const canvas = page.locator('canvas');
    if (!args.anim || frames <= 1) {
      await canvas.screenshot({ path: `${outDir}/${prefix}.png` });
      return 1;
    }
    let n = 0;
    for (let age = 0; age < frames; age++) {
      for (let s = 0; s < args.subdiv; s++) {
        await page.evaluate(([a, al]) => window.GALLERY_DRAW(a, al), [age, s / args.subdiv]);
        await canvas.screenshot({ path: `${outDir}/${prefix}-${String(n++).padStart(4, '0')}.png` });
      }
    }
    return n;
  }

  const shots = [];
  if (args.sweep) {
    const targets = args.sweep.map(findConstant);
    assertClean([...new Set(targets.map((t) => t.rel))]);
    // Snapshot each distinct FILE once. Two constants in one file must be patched into
    // the same buffer, or the second write reverts the first.
    const files = new Map();
    for (const t of targets) if (!files.has(t.path)) files.set(t.path, readFileSync(t.path, 'utf8'));
    try {
      for (const variant of args.values) {
        const edited = new Map(files);
        targets.forEach((t, i) => {
          const before = edited.get(t.path);
          // Check the PATTERN matched, not that the text changed. A variant may set a
          // constant to the value it already holds -- the first one usually does, since
          // sweeps tend to start from the shipped value -- and treating that as a failed
          // patch aborted the run before it rendered anything.
          if (!t.re.test(before)) throw new Error(`could not find ${args.sweep[i]} to patch in ${t.rel}`);
          edited.set(t.path, before.replace(t.re, `$1${variant[i]}$3`));
        });
        for (const [path, text] of edited) writeFileSync(path, text);
        await new Promise((r) => setTimeout(r, 700)); // let vite pick the edits up
        const prefix = `sweep-${shots.length}`;
        const n = await capture(prefix);
        const auto = args.sweep.map((name, i) => `${name} ${variant[i]}`).join('  ');
        shots.push({ prefix, n, label: args.labels ? args.labels[shots.length] : auto });
      }
    } finally {
      for (const [path, text] of files) writeFileSync(path, text);
      const rels = [...new Set(targets.map((t) => t.rel))];
      const after = sh('git', ['status', '--porcelain', '--', ...rels]).trim();
      console.log(after ? `WARNING: left modified\n${after}` : `restored ${rels.join(', ')}`);
    }
  } else {
    const n = await capture('frame');
    shots.push({ prefix: 'frame', n, label: `${args.subject} ${args.view}` });
  }

  console.log('pageerrors:', errors.length ? errors.slice(0, 3).join(' | ') : 'none');

  if (!has('ffmpeg')) {
    console.log(`wrote PNG frames to ${outDir} (install ffmpeg for gif/grid assembly)`);
    return;
  }

  const animated = args.anim && shots[0].n > 1;
  if (animated && shots.length === 1) {
    const target = outFile ?? `${outDir}/gallery.gif`;
    sh('ffmpeg', ['-y', '-framerate', String(args.fps), '-i', `${outDir}/frame-%04d.png`,
      '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0', target]);
    console.log('wrote', target);
    return;
  }
  if (!animated && shots.length > 1) {
    const cells = shots.map((s, i) => {
      const src = `${outDir}/${s.prefix}.png`;
      const dst = `${outDir}/cell-${i}.png`;
      if (args.label) {
        sh('ffmpeg', ['-y', '-i', src, '-vf',
          `drawtext=text='${safeLabel(s.label)}':x=10:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=5`, dst]);
      } else sh('cp', [src, dst]);
      return dst;
    });
    const { cols, rows } = gridShape(cells.length);
    const pad = cols * rows - cells.length;
    for (let i = 0; i < pad; i++) {
      sh('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${args.w}x${args.h}:d=1`, '-frames:v', '1', `${outDir}/cell-${cells.length + i}.png`]);
      cells.push(`${outDir}/cell-${cells.length + i}.png`);
    }
    const inputs = cells.flatMap((c) => ['-i', c]);
    let fc = '';
    for (let r = 0; r < rows; r++) {
      const row = Array.from({ length: cols }, (_, c) => `[${r * cols + c}:v]`).join('');
      fc += `${row}hstack=inputs=${cols}[r${r}];`;
    }
    fc += Array.from({ length: rows }, (_, r) => `[r${r}]`).join('') + `vstack=inputs=${rows}`;
    const target = outFile ?? `${outDir}/grid.png`;
    sh('ffmpeg', ['-y', ...inputs, '-filter_complex', fc, target]);
    console.log('wrote', target);
    return;
  }
  console.log(`wrote ${shots.reduce((a, s) => a + s.n, 0)} frame(s) to ${outDir}`);
}

main()
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => vite?.kill());
