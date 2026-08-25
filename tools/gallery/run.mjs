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
 *   npm run gallery -- --elements tank --view close --skin flow --hull '#3d7bd6'
 *   npm run gallery -- --elements tank --skin flow --anim --frames 90 --out flow.gif
 *   npm run gallery -- --scene ai-tracking --anim --sweep TURRET_R --values 0.2,0.55 --out cmp.gif
 *
 *   npm run gallery -- --scene ai-tracking --anim --subdiv 1 --fps 60 --out clip.gif
 *
 * The --sweep line is --anim + --sweep together: one labelled animated gif per swept
 * variant, composed side by side into a single animated grid (see the assembly
 * section's `animated && shots.length > 1` branch).
 *
 * NORMAL-SPEED PLAYBACK needs `--subdiv 1 --fps 60`, as the last line shows, and the
 * defaults deliberately do NOT give it. `--subdiv` (default 3) renders three interpolated
 * frames per sim tick and `--fps` (default 20) plays them back at 20, so a moment plays at
 * 20/3 ticks per second against the sim's 60 -- nine times slower than real time, which is
 * what you want for inspecting a shape and wrong for judging whether something READS as
 * smooth. MEASURED on the 47-tick `ai-tracking` moment (47 ticks / 60Hz = 0.783s of game
 * time): the defaults produce 141 frames playing over 7.05s, and `--subdiv 1 --fps 60`
 * produces 47 frames over 0.790s -- within 0.9% of real time. The residual is GIF's
 * centisecond frame-delay quantisation, which cannot express 60fps exactly; it is a
 * property of the container, not of the capture.
 *
 * --skin/--hull/--accent dress the PLAYER tank through the game's own setPlayerStyle.
 * --frames gives an animated skin a timeline: every shipped element is static or a few
 * ticks long, and one age step is one sim tick (see subjects.ts's timelineDt).
 *
 * --sweep patches a constant in src/ between passes. The original is restored in a
 * finally block, and the runner refuses to start if the file is already dirty, so an
 * interrupted sweep cannot leave edited constants behind.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs, safeLabel, gridShape, DEFAULTS } from './args.mjs';

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
/** Actual pixel dimensions of a rendered file, so padding can match the cells. */
function probeSize(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
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
  // POLL, do not sleep. A fixed wait is a race that fails intermittently and reports it
  // as a navigation timeout thirty seconds later, which reads like a bug in the page
  // rather than a server that was not up yet.
  const deadline = Date.now() + 30000;
  for (;;) {
    if (vite.exitCode !== null) throw new Error(`vite exited with code ${vite.exitCode} before serving`);
    try {
      const res = await fetch(`http://localhost:${PORT}/`, { method: 'HEAD' });
      if (res.ok || res.status === 404) break; // listening either way
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`vite did not start on port ${PORT} within 30s`);
    await new Promise((r) => setTimeout(r, 200));
  }

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

  if (args.slowmo !== 1) {
    // Slow the game down by scaling the clocks the driver reads. BOTH of them:
    // driver.ts takes its per-frame delta from the rAF CALLBACK TIMESTAMP and uses
    // performance.now only to seed `last` on start/reset. Scaling performance.now
    // alone was measured to be a dead knob -- the game ran at full speed. The two
    // share a time origin, so one scale function serves both.
    await page.addInitScript(`(() => {
      const SCALE = ${args.slowmo};
      const orig = performance.now.bind(performance);
      const t0 = orig();
      const scale = (t) => t0 + (t - t0) * SCALE;
      performance.now = () => scale(orig());
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf((t) => cb(scale(t)));
    })()`);
  }

  /**
   * One rAF round-trip: the game steps and presents exactly one frame.
   *
   * Headless chromium throttles rAF when nothing forces frames -- a burst taken
   * without this came back as 45 copies of 4 distinct images.
   */
  const pumpFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  const q = (extra = {}) => {
    const p = new URLSearchParams({ elements: args.elements, view: args.view, w: String(args.w), h: String(args.h), ...extra });
    if (args.reach) p.set('reach', '1');
    if (args.timer) p.set('timer', '1');
    if (args.fill) p.set('fill', '1');
    if (args.skin !== 'solid') p.set('skin', args.skin);
    if (args.hull) p.set('hull', args.hull);
    if (args.accent) p.set('accent', args.accent);
    if (args.frames !== null) p.set('frames', String(args.frames));
    // Only when non-default, mirroring skin/hull/accent above: DEFAULTS.spawnAnim is
    // always defined, so an UNCONDITIONAL emit would set ?spawn-anim= on every gallery
    // invocation and fire setPlayerStyle through subjects.ts's widened guard even when
    // nothing else asked to be styled -- the exact regression this guard is against.
    if (args.spawnAnim !== DEFAULTS.spawnAnim) p.set('spawn-anim', args.spawnAnim);
    // q() is only ever reached once captureGame's own `args.scene === 'game'` branch
    // (above, in capture()) has already returned -- so 'game' can never land here, and
    // the only scene ids left are 'gallery' (the default; omitted, same as skin='solid')
    // and a moment id.
    if (args.scene !== 'gallery') p.set('scene', args.scene);
    return `http://localhost:${PORT}/tools/gallery/index.html?${p}`;
  };

  /**
   * The GAME's canvas, not the Customize panel's.
   *
   * A bare `locator('canvas')` matched two elements the moment the HUD gained its
   * persistent `.hud-preview` canvas, and Playwright's strict mode then failed EVERY
   * `--scene game` run with "resolved to 2 elements" while waiting for the page --
   * which reads as a page that never loaded. The preview canvas is hidden and empty
   * until Customize is opened, so it was never a candidate; it just made the selector
   * ambiguous.
   */
  const GAME_CANVAS = 'canvas:not(.hud-preview)';

  /**
   * Shoot the REAL game at its REAL camera: load it, leave the title screen, wait out
   * the opening countdown, then capture. No pose stepping -- the game owns its clock.
   */
  async function captureGame(prefix) {
    const qs = args.query ? `?${args.query}` : '';
    // 'domcontentloaded', not 'load'. A --sweep patches source between shots, so vite is
    // rebuilding when we navigate and may issue a full HMR reload mid-load -- the 'load'
    // event then never fires for the navigation we are awaiting, and it times out after
    // 30s looking like a broken page. Wait for the canvas the game actually creates.
    //
    // Retried once, because this degrades with SEQUENCE LENGTH: a two-variant sweep is
    // reliable and a six-variant one is not. Each variant is a fresh full load of a
    // WebGL game under software rendering, and the later ones are slower. A single
    // retry is the difference between a usable tool and one that fails a long sweep
    // after several minutes of work.
    for (let attempt = 0; ; attempt++) {
      try {
        await page.goto(`http://localhost:${PORT}/${qs}`, { waitUntil: 'domcontentloaded' });
        await page.locator(GAME_CANVAS).waitFor({ state: 'attached', timeout: 30000 });
        break;
      } catch (e) {
        if (attempt >= 1) throw e;
        console.log(`  (retrying ${prefix}: ${String(e).split('\n')[0]})`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await page.waitForTimeout(1500);
    // Leave the title screen first. Until it is gone the menu has no Start button to
    // find -- setState('splash') returns before the branch that writes the label, so
    // the locator below matches nothing -- and the panel-hidden check further down
    // reads TRUE while the splash is up, because the menu behind it is hidden too.
    // Both safeguards silently degrade into the Enter fallback without this.
    if (await page.locator('.hud-splash:not(.hud-splash--hidden)').count()) {
      await page.keyboard.press('Space');
      await page
        .waitForSelector('.hud-splash.hud-splash--hidden', { timeout: 5000 })
        .catch(() => {});
    }
    const start = page.locator('button', { hasText: /start|play/i }).first();
    if (await start.count()) await start.click();
    else await page.keyboard.press('Enter');
    // VERIFY the game actually left the title screen. One burst run silently shot 80
    // frames of the title panel; a still would have lied the same way.
    for (let tries = 0; ; tries++) {
      await pumpFrame();
      const hidden = await page.evaluate(
        () => document.querySelector('.hud-panel')?.className.includes('hidden') ?? false,
      );
      if (hidden) break;
      if (tries >= 20) throw new Error('HUD panel never hid: the game did not start');
      if (tries % 5 === 4) await start.click().catch(() => {});
    }
    if (args.burst > 1) {
      // A timeline, not a still: pump the settle (throttled rAF means waiting does not
      // advance the game -- ticks only happen inside frames), then one shot per frame.
      const s0 = Date.now();
      while (Date.now() - s0 < args.settle) await pumpFrame();
      for (let i = 0; i < args.burst; i++) {
        await pumpFrame();
        await page.locator(GAME_CANVAS).screenshot({ path: `${outDir}/${prefix}-${String(i).padStart(4, '0')}.png` });
      }
      return args.burst;
    }
    await page.waitForTimeout(args.settle);
    await page.locator(GAME_CANVAS).screenshot({ path: `${outDir}/${prefix}.png` });
    return 1;
  }

  async function capture(prefix) {
    if (args.scene === 'game') return captureGame(prefix);
    await page.goto(q(), { waitUntil: 'load' });
    await page.waitForFunction(() => window.GALLERY_READY === true, undefined, { timeout: 20000 });
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
        await new Promise((r) => setTimeout(r, 1200)); // let vite finish rebuilding
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

  const animated = (args.anim || args.burst > 1) && shots[0].n > 1;
  if (animated && shots.length === 1) {
    const target = outFile ?? `${outDir}/gallery.gif`;
    sh('ffmpeg', ['-y', '-framerate', String(args.fps), '-i', `${outDir}/frame-%04d.png`,
      '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop', '0', target]);
    console.log('wrote', target);
    return;
  }
  if (animated && shots.length > 1) {
    // --anim + --sweep: build one labelled, palette-quantized gif per variant (the
    // exact ffmpeg recipe the single-gif branch above uses), then hstack/vstack those
    // gifs into ONE final animated grid, reusing gridShape/probeSize/label from the
    // static-grid branch below. args.mjs already refuses --crop with animated output
    // (`--crop is not applied to animated output`), so there is no crop case to carry
    // into this branch -- every input here is a full, uncropped capture.
    //
    // Variants can capture different frame counts. Rather than pad a shorter variant
    // with a frozen last frame -- which would make that variant visibly STOP moving
    // while its neighbours kept animating, exactly the kind of misleading artefact
    // this tool exists to show correctly -- every variant is TRUNCATED to the
    // shortest variant's count. A dropped tail is still real captured motion; a
    // padded one would not be.
    const minN = Math.min(...shots.map((s) => s.n));
    const cells = shots.map((s, i) => {
      const dst = `${outDir}/anim-${i}.gif`;
      const vf = args.label
        ? `drawtext=text='${safeLabel(s.label)}':x=10:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=5,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`
        : 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';
      sh('ffmpeg', ['-y', '-framerate', String(args.fps), '-i', `${outDir}/${s.prefix}-%04d.png`,
        '-frames:v', String(minN), '-vf', vf, dst]);
      return dst;
    });
    const { cols, rows } = gridShape(cells.length);
    const pad = cols * rows - cells.length;
    // Pad cell, same reasoning as the static grid below: a blank clip at the real
    // cells' own pixel size (not the capture size) and the same truncated frame
    // count, so hstack/vstack sees uniform inputs.
    const cellSize = pad > 0 ? probeSize(cells[0]) : null;
    for (let i = 0; i < pad; i++) {
      const dst = `${outDir}/anim-${cells.length}.gif`;
      sh('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${cellSize.w}x${cellSize.h}:r=${args.fps}`,
        '-frames:v', String(minN), dst]);
      cells.push(dst);
    }
    const inputs = cells.flatMap((c) => ['-i', c]);
    // Same hstack/vstack shaping as the static grid below, including its inputs=1
    // workaround -- video streams hit the identical ffmpeg restriction stills do.
    let fc = '';
    for (let r = 0; r < rows; r++) {
      const row = Array.from({ length: cols }, (_, c) => `[${r * cols + c}:v]`).join('');
      fc += cols === 1 ? `${row}null[r${r}];` : `${row}hstack=inputs=${cols}[r${r}];`;
    }
    const stack = Array.from({ length: rows }, (_, r) => `[r${r}]`).join('');
    fc += rows === 1 ? `${stack}null[grid]` : `${stack}vstack=inputs=${rows}[grid]`;
    // Re-quantize the composed grid to its own fresh palette rather than reusing each
    // cell's already-quantized colours -- the same palettegen/paletteuse pair every
    // gif in this file is built with, applied once more at the composition stage.
    fc += ';[grid]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';
    const target = outFile ?? `${outDir}/grid.gif`;
    sh('ffmpeg', ['-y', ...inputs, '-filter_complex', fc, '-loop', '0', target]);
    console.log('wrote', target);
    return;
  }
  if (!animated && shots.length > 1) {
    const cells = shots.map((s, i) => {
      let src = `${outDir}/${s.prefix}.png`;
      const dst = `${outDir}/cell-${i}.png`;
      if (args.crop) {
        // Crop BEFORE labelling, or the label lands outside the kept region.
        const [, cw, ch, cx, cy] = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(args.crop);
        const cropped = `${outDir}/crop-${i}.png`;
        sh('ffmpeg', ['-y', '-i', src, '-vf', `crop=${cw}:${ch}:${cx}:${cy}`, cropped]);
        src = cropped;
      }
      if (args.label) {
        sh('ffmpeg', ['-y', '-i', src, '-vf',
          `drawtext=text='${safeLabel(s.label)}':x=10:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=5`, dst]);
      } else sh('cp', [src, dst]);
      return dst;
    });
    const { cols, rows } = gridShape(cells.length);
    const pad = cols * rows - cells.length;
    // Pad at the size the CELLS actually are, not the capture size. With --crop those
    // differ, and hstack refuses to stack mismatched inputs -- it fails with a bare
    // "Conversion failed!", which says nothing about sizes. Hit by every odd-numbered
    // sweep that also cropped.
    const cellSize = pad > 0 ? probeSize(cells[0]) : null;
    for (let i = 0; i < pad; i++) {
      const dst = `${outDir}/cell-${cells.length}.png`;
      sh('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${cellSize.w}x${cellSize.h}:d=1`, '-frames:v', '1', dst]);
      cells.push(dst);
    }
    const inputs = cells.flatMap((c) => ['-i', c]);
    // hstack/vstack REJECT inputs=1 -- "Numerical result out of range" -- so a single
    // row or a single column has to skip that stage entirely rather than pass a 1. A
    // two-variant sweep is 2x1 and hit this every time.
    let fc = '';
    for (let r = 0; r < rows; r++) {
      const row = Array.from({ length: cols }, (_, c) => `[${r * cols + c}:v]`).join('');
      fc += cols === 1 ? `${row}null[r${r}];` : `${row}hstack=inputs=${cols}[r${r}];`;
    }
    const stack = Array.from({ length: rows }, (_, r) => `[r${r}]`).join('');
    fc += rows === 1 ? `${stack}null` : `${stack}vstack=inputs=${rows}`;
    const target = outFile ?? `${outDir}/grid.png`;
    sh('ffmpeg', ['-y', ...inputs, '-filter_complex', fc, target]);
    console.log('wrote', target);
    return;
  }
  if (args.crop && shots.length === 1) {
    const [, cw, ch, cx, cy] = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(args.crop);
    const target = outFile ?? `${outDir}/frame-cropped.png`;
    sh('ffmpeg', ['-y', '-i', `${outDir}/${shots[0].prefix}.png`, '-vf', `crop=${cw}:${ch}:${cx}:${cy}`, target]);
    console.log('wrote', target);
    return;
  }
  console.log(`wrote ${shots.reduce((a, s) => a + s.n, 0)} frame(s) to ${outDir}`);
}

main()
  .catch((e) => { console.error(e.message ?? e); process.exitCode = 1; })
  .finally(() => vite?.kill());
