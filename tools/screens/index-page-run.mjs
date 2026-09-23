#!/usr/bin/env node
/**
 * Write `index.html` into a sweep directory (issue #936).
 *
 *   node tools/screens/index-page-run.mjs tmp/sweep/base
 *
 * `sweep.mjs` writes the page itself at the end of a run, from the reports it already holds,
 * so a fresh sweep needs nothing here. This exists for the sweeps already on disk, and for
 * regenerating one after the renderer changes without re-photographing 441 screens -- which
 * is why it reads the reports back rather than sharing the sweep's in-memory copy.
 *
 * THE CLI IS IN ITS OWN FILE, not at the foot of `index-page.mjs`, and **nothing imports this
 * file** -- `sweep.mjs` imports the pure renderer instead. A module that awaits at import
 * time and is imported by a sibling deadlocks the process: Node exits 13 with "Detected
 * unsettled top-level await" and names no cause (issue #947 measured it).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SCREEN_STATES } from './states.mjs';
import { MANIFEST } from './sweep-plan.mjs';
import { captureKey, renderIndexPage, sweepGrid } from './index-page.mjs';

/**
 * The measured boxes for every successful capture, read from the report written beside each
 * PNG.
 *
 * A report that is missing or unreadable yields no boxes for that cell rather than failing
 * the page: the PNG is the evidence, and a caption is a caption. `Promise.all` over the
 * results rather than a loop, because a full sweep is 441 small reads.
 */
export async function readMeasuredBoxes(/** @type {string} */ dir, /** @type {any[]} */ results) {
  const entries = await Promise.all(
    results
      .filter((r) => r.ok)
      .map(async (r) => {
        try {
          const raw = await readFile(join(dir, r.state, `${r.layout}.json`), 'utf8');
          const report = JSON.parse(raw);
          return [captureKey(r.state, r.layout), report?.producer?.measurements ?? []];
        } catch {
          return [captureKey(r.state, r.layout), []];
        }
      }),
  );
  return Object.fromEntries(entries);
}

/** Render a sweep directory's `index.html` and write it. Returns the path written. */
export async function writeIndexPage(/** @type {string} */ dir) {
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
  const boxes = await readMeasuredBoxes(dir, manifest.results ?? []);
  const grid = sweepGrid(manifest, SCREEN_STATES, boxes);
  const out = join(dir, 'index.html');
  await writeFile(out, renderIndexPage(grid, manifest));
  return out;
}

const dir = process.argv[2];
if (dir === undefined) {
  console.error('usage: node tools/screens/index-page-run.mjs <sweep-directory>');
  process.exit(2);
}
const written = await writeIndexPage(dir);
console.log(`Wrote ${written}.`);
