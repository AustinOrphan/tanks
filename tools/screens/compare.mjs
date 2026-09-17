#!/usr/bin/env node
/**
 * Compare two screen-state sweeps byte for byte (issue #766).
 *
 *   npm run screens:compare -- --base tmp/sweep/base --head tmp/sweep/head \
 *     [--base-control tmp/sweep/base-2] [--head-control tmp/sweep/head-2] \
 *     [--states a,b] [--layouts x,y] [--json]
 *
 * Every state and layout either sweep names is classified as `identical`, `different`, `missing`
 * or `unstable` (see `classifyPair` in `sweep-plan.mjs`). The command exits 0 only when every pair
 * is identical. `--states` and `--layouts` restrict the comparison, so control sweeps need to cover
 * only the pairs being settled.
 *
 * READ BACK, NOT TRUSTED. Each frame's hash is recomputed from the file on disk. A file that does
 * not match the hash its own manifest recorded is an error, because the manifest no longer
 * describes the directory.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MANIFEST, capturePaths, compareExitCode, compareManifests } from './sweep-plan.mjs';

function arg(/** @type {string} */ name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** A sweep's manifest, with every recorded hash checked against its file. */
function readSweep(/** @type {string} */ dir) {
  const path = resolve(dir, MANIFEST);
  if (!existsSync(path)) throw new Error(`no ${MANIFEST} in ${dir}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const r of manifest.results) {
    if (!r.ok) continue;
    const { png } = capturePaths(resolve(dir), r.state, r.layout);
    if (!existsSync(png)) throw new Error(`${dir}: ${r.state} ${r.layout} is recorded but ${png} is missing`);
    const actual = createHash('sha256').update(readFileSync(png)).digest('hex');
    if (actual !== r.sha256) throw new Error(`${dir}: ${r.state} ${r.layout} does not match the hash its manifest recorded`);
  }
  return manifest;
}

function main() {
  const baseDir = arg('base');
  const headDir = arg('head');
  if (baseDir === undefined || headDir === undefined) throw new Error('--base and --head are required');
  const baseControlDir = arg('base-control');
  const headControlDir = arg('head-control');
  const list = (/** @type {string} */ name) => {
    const raw = arg(name);
    return raw === undefined ? undefined : raw.split(',').map((s) => s.trim()).filter(Boolean);
  };
  const result = compareManifests({
    base: readSweep(baseDir),
    head: readSweep(headDir),
    baseControl: baseControlDir === undefined ? undefined : readSweep(baseControlDir),
    headControl: headControlDir === undefined ? undefined : readSweep(headControlDir),
    only: { states: list('states'), layouts: list('layouts') },
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const t = result.totals;
    console.log(`${t.pairs} pairs: ${t.identical} identical, ${t.different} different, ${t.missing} missing, ${t.unstable} unstable`);
    console.log(`measurements identical in ${t.measurementsIdentical} of ${t.pairs} pairs`);
    console.log(`controls: base ${result.controls.base ? 'yes' : 'no'}, head ${result.controls.head ? 'yes' : 'no'}; game canvas ${result.options.hideGame ? 'hidden' : 'shown'}`);
    for (const p of result.pairs) {
      if (p.outcome !== 'identical') console.log(`  ${p.outcome.padEnd(9)} ${p.state} ${p.layout} (measurements ${p.measurements})`);
    }
  }
  process.exit(compareExitCode(result));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
