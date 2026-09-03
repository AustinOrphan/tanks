#!/usr/bin/env node
/**
 * Regenerates tools/mutate/scope-costs.json -- the median wall seconds per entry of each
 * exact test scope -- from one or more `--report` files (issue #507). The pool balances
 * its workers with it; nothing else reads it, and a stale file only costs idle time.
 *
 *   npm run mutate -- --jobs auto --report /tmp/report.json
 *   node tools/mutate/scope-costs.mjs /tmp/report.json [more reports...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readManifest } from './run.mjs';

const OUT = fileURLToPath(new URL('./scope-costs.json', import.meta.url));
const MANIFEST = fileURLToPath(new URL('./manifests', import.meta.url));

/**
 * Pure: entries carry `seconds`, the manifest says which scope each belongs to.
 * @param {{ id: string, seconds?: number | null }[]} reportEntries
 * @param {{ id: string, tests: string[] }[]} manifest
 * @returns {Record<string, number>}
 */
export function scopeCosts(reportEntries, manifest) {
  const scopeOf = new Map(manifest.map((e) => [e.id, JSON.stringify(e.tests)]));
  /** @type {Map<string, number[]>} */
  const samples = new Map();
  for (const r of reportEntries) {
    const scope = scopeOf.get(r.id);
    if (scope === undefined || typeof r.seconds !== 'number' || !(r.seconds > 0)) continue;
    const list = samples.get(scope) ?? [];
    list.push(r.seconds);
    samples.set(scope, list);
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const [scope, list] of [...samples.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted = [...list].sort((a, b) => a - b);
    out[scope] = Number(sorted[Math.floor(sorted.length / 2)].toFixed(1));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports = process.argv.slice(2);
  if (reports.length === 0) {
    console.error('usage: scope-costs.mjs <report.json> [more...]');
    process.exit(2);
  }
  const manifest = readManifest(MANIFEST);
  const entries = reports.flatMap((p) => JSON.parse(readFileSync(p, 'utf8')).entries);
  const costs = scopeCosts(entries, manifest);
  writeFileSync(OUT, JSON.stringify(costs, null, 2) + '\n');
  console.log(`wrote ${OUT}: ${Object.keys(costs).length} scope(s) from ${entries.length} report entr${entries.length === 1 ? 'y' : 'ies'}`);
}
