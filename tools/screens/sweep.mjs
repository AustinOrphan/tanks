#!/usr/bin/env node
/**
 * Photograph every screen state at every layout in the matrix, from one built `dist` (issue #766).
 *
 *   npm run screens:sweep -- --dist dist --out tmp/sweep/base
 *   npm run screens:sweep -- --dist dist --out tmp/sweep/one --states screen.customize --layouts 320x568,1280x800
 *   npm run screens:sweep -- --dist dist --out tmp/sweep/hud --hide-game
 *   npm run screens:sweep -- --dist ../other-worktree/dist --out tmp/sweep/head --hide-game
 *
 * Writes `<out>/<state>/<layout>.png`, the producer report beside it as `<layout>.json`, and one
 * `manifest.json`. One browser and one static server serve the whole run, and every capture
 * gets a fresh browser context. `--out` must not exist yet, so a sweep never mixes with an
 * older one.
 *
 * A capture that fails is recorded in the manifest with its error, and the sweep goes on. The
 * command exits 1 when any capture failed. The manifest is rewritten after every capture with
 * `complete: false`, and only the last write says `complete: true`, so a sweep that was stopped
 * still records what it took, and `compare.mjs` refuses it.
 *
 * `compare.mjs` compares two sweeps. The procedure is in this directory's README.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SCREEN_STATES } from './states.mjs';
import { captureState, launchBrowser, serve } from './capture.mjs';
import { LAYOUTS, MANIFEST, capturePaths, select, sweepManifest } from './sweep-plan.mjs';
import { captureKey, renderIndexPage, sweepGrid } from './index-page.mjs';

function arg(/** @type {string} */ name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/**
 * What the swept build was made from: the commit of the checkout that holds `dist`, which is not
 * necessarily the checkout running this tool. A sweep of another worktree's build is the normal
 * before/after case. `--source` overrides it, for a `dist` built somewhere version control cannot
 * see.
 */
function sourceDescription(/** @type {string} */ dist) {
  const given = arg('source');
  if (given !== undefined) return given;
  const cwd = dirname(dist);
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'index.html', 'public'], { cwd }).toString().trim() !== '';
    return dirty ? `${sha} with uncommitted changes under src/, index.html or public/` : sha;
  } catch {
    return `unknown (no checkout holds ${dist}; pass --source)`;
  }
}

async function main() {
  const dist = resolve(arg('dist') ?? 'dist');
  const outArg = arg('out');
  if (outArg === undefined) throw new Error('--out is required: the directory this sweep creates');
  const out = resolve(outArg);
  if (existsSync(out)) throw new Error(`${outArg} already exists; a sweep writes into a new directory`);
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error(`no index.html under ${dist}`);
  const timeout = Number(arg('timeout') ?? 20000);
  const states = select(SCREEN_STATES, arg('states'), (s) => s.id, 'state');
  const layouts = select(LAYOUTS, arg('layouts'), (l) => l.name, 'layout');
  const options = { hideGame: process.argv.includes('--hide-game') };

  const browser = await launchBrowser();
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const results = [];
  /** Measured boxes per capture, for the index page written at the end. */
  const boxes = {};
  const total = states.length * layouts.length;
  const source = sourceDescription(dist);
  await mkdir(out, { recursive: true });
  const writeManifest = (complete) =>
    writeFile(resolve(out, MANIFEST), `${JSON.stringify(sweepManifest({ dist, source, options, states, layouts, results, complete }), null, 2)}\n`);
  try {
    for (const state of states) {
      for (const layout of layouts) {
        const paths = capturePaths(out, state.id, layout.name);
        const started = Date.now();
        try {
          const { png, report } = await captureState(browser, base, state, { ...layout, timeout, ...options });
          await mkdir(dirname(paths.png), { recursive: true });
          await writeFile(paths.png, png);
          await writeFile(paths.report, `${JSON.stringify(report, null, 2)}\n`);
          const sha256 = createHash('sha256').update(png).digest('hex');
          const measurementsSha256 = createHash('sha256').update(JSON.stringify(report.producer.measurements)).digest('hex');
          results.push({ state: state.id, layout: layout.name, ok: true, sha256, measurementsSha256, pageErrors: report.producer.pageErrors.length });
          // Kept for the index page (issue #936), from the report already in hand. Reading
          // the 441 reports back off disk afterwards would be the same data at 441 extra
          // reads; `index-page-run.mjs` does that only because an OLD sweep has no other
          // source for it.
          boxes[captureKey(state.id, layout.name)] = report.producer.measurements;
          console.log(`[${results.length}/${total}] ${state.id} ${layout.name} ${sha256.slice(0, 12)} ${Date.now() - started}ms`);
        } catch (error) {
          const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
          results.push({ state: state.id, layout: layout.name, ok: false, error: message });
          console.log(`[${results.length}/${total}] ${state.id} ${layout.name} FAILED: ${message}`);
        }
        await writeManifest(false);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  await writeManifest(true);
  const manifest = sweepManifest({ dist, source, options, states, layouts, results, complete: true });
  // The page a person actually reads (issue #936). Written even when captures failed, and
  // ESPECIALLY then: a failed cell is drawn with its error, so the page says what is missing
  // instead of quietly having fewer pictures in it.
  await writeFile(
    resolve(out, 'index.html'),
    renderIndexPage(sweepGrid(manifest, SCREEN_STATES, boxes), manifest),
  );
  console.log(`${manifest.captures - manifest.failed} of ${manifest.captures} captures written to ${outArg}; ${manifest.failed} failed`);
  console.log(`Open ${outArg}/index.html to review them as a grid.`);
  if (manifest.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(2);
});
