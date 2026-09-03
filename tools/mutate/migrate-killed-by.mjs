#!/usr/bin/env node
/**
 * One-off migration for issue #504: turn exact `expectFailures` counts into `killedBy`
 * lists of vitest full names, read from a `--report` file the harness wrote for a
 * complete run on the same commit.
 *
 *   npm run mutate -- --jobs auto --report /tmp/report.json
 *   node tools/mutate/migrate-killed-by.mjs /tmp/report.json [tools/mutate/manifests]
 *
 * Rules, so the result is reviewable rather than magic:
 *   - Only `expect: "killed"` entries with a count are touched. Survivors keep their 0.
 *   - An entry whose `why` states a population claim ("N of M", "N of M across ...")
 *     keeps its count: the number IS part of what that entry documents.
 *   - Every other entry gets `killedBy` = every test the report saw fail, sorted, and
 *     loses `expectFailures`. Naming all of them is the same pin the count was, made
 *     explicit; a later PR can narrow a list to the tests that matter.
 *   - An entry the report does not cover, or that the report saw survive, is left alone
 *     and listed, so nothing is rewritten on a guess.
 * Kept in the repository (rather than pasted into a PR body) because the manifest is
 * generated data as far as this migration is concerned, and generated documents are
 * updated through their generators.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readManifestFiles } from './run.mjs';

const [reportPath, manifestPath = 'tools/mutate/manifests'] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: migrate-killed-by.mjs <report.json> [manifest.json or a directory of them]');
  process.exit(2);
}
const POPULATION_CLAIM = /\b\d+ of \d+\b/;

/**
 * @param {{ id: string, expect: string, expectFailures?: number, killedBy?: string[], why: string }[]} manifest
 * @param {Map<string, { status: string, failedTests: string[] }>} byId
 */
export function migrate(manifest, byId) {
  const kept = [];
  const skipped = [];
  let migrated = 0;
  const out = manifest.map((entry) => {
    if (entry.expect !== 'killed' || entry.expectFailures === undefined || entry.killedBy !== undefined) return entry;
    if (POPULATION_CLAIM.test(entry.why)) {
      kept.push(entry.id);
      return entry;
    }
    const seen = byId.get(entry.id);
    if (!seen || seen.status !== 'KILLED' || seen.failedTests.length === 0) {
      skipped.push(entry.id);
      return entry;
    }
    const { expectFailures: _dropped, ...rest } = entry;
    migrated += 1;
    return { ...rest, killedBy: [...new Set(seen.failedTests)].sort() };
  });
  return { manifest: out, migrated, kept, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const byId = new Map(report.entries.map((/** @type {any} */ r) => [r.id, r]));
  let migrated = 0;
  /** @type {string[]} */ const kept = [];
  /** @type {string[]} */ const skipped = [];
  // One file at a time, each written back where it came from (issue #505).
  for (const file of readManifestFiles(manifestPath)) {
    const result = migrate(file.entries, byId);
    writeFileSync(file.path, JSON.stringify(result.manifest, null, 2) + '\n');
    migrated += result.migrated;
    kept.push(...result.kept);
    skipped.push(...result.skipped);
  }
  console.log(`migrated ${migrated} entr${migrated === 1 ? 'y' : 'ies'} to killedBy; kept a count on ${kept.length} (population claims); left ${skipped.length} untouched`);
  if (kept.length) console.log('kept:', kept.join(', '));
  if (skipped.length) console.log('skipped (not in the report, survived, or named no failing test):', skipped.join(', '));
}
