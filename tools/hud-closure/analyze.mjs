#!/usr/bin/env node
/**
 * Print who owns what inside `createHud` (issue #767).
 *
 *   npm run hud:closure                      Markdown tables for the working tree
 *   npm run hud:closure -- --json            the same report as JSON
 *   npm run hud:closure -- --strict          exit 1 on a write across a pane boundary
 *   npm run hud:closure -- --strict --pane Customize
 *
 * The analysis is in `closure.mjs` and the attribution data in `attribution.mjs`. This file only
 * reads arguments, the manifest and git, and prints.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CORRECTIONS, PANES } from './attribution.mjs';
import { attribute, collectOwners, formatMarkdown, paneReport, programForFile, strictFailures } from './closure.mjs';
import { readManifest, readScopeCosts } from '../mutate/run.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_FILE = 'src/game/hud.ts';
const FUNCTION_NAME = 'createHud';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { json: false, strict: false, pane: /** @type {string | null} */ (null), file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--pane' || a === '--file') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--pane') args.pane = value;
      else args.file = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

/** The commit the report describes, marked when the analysed file differs from it. */
function describeSource(/** @type {string} */ file) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT }).toString().trim() !== '';
    return dirty ? `\`${sha}\` plus uncommitted changes to the file` : `\`${sha}\``;
  } catch {
    return 'an unknown commit (git unavailable)';
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const absolute = resolve(ROOT, args.file);
  if (!existsSync(absolute)) throw new Error(`no such file: ${args.file}`);
  const file = relative(ROOT, absolute);

  const program = programForFile(ts, ROOT, absolute);
  const collected = collectOwners(ts, program, absolute, FUNCTION_NAME);
  const { staleCorrections, crossPaneStatements } = attribute(collected.owners, { panes: PANES, corrections: CORRECTIONS });

  const entries = readManifest(join(ROOT, 'tools/mutate/manifests')).filter((e) => e.file === file);
  const costs = readScopeCosts(join(ROOT, 'tools/mutate/scope-costs.json'), (message) => console.error(message));
  const costOf = (/** @type {readonly string[]} */ tests) => {
    const v = costs[JSON.stringify(tests)];
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const report = paneReport(collected, PANES.map((p) => p.pane), { entries, costOf });
  const label = describeSource(file);

  if (args.json) {
    console.log(JSON.stringify({ file, source: label, ...report, staleCorrections, crossPaneStatements: crossPaneStatements.map((o) => o.start) }, null, 2));
  } else {
    console.log(formatMarkdown(report, { label, file, staleCorrections, crossPaneStatements }));
  }

  if (args.strict) {
    const failures = strictFailures(report, staleCorrections, args.pane);
    for (const f of failures) console.error(`strict: ${f}`);
    if (failures.length > 0) process.exit(1);
    console.error(`strict: no write crosses ${args.pane === null ? 'any pane boundary' : `the ${args.pane} boundary`}, and every correction names an owner.`);
  }
}

const entry = process.argv[1];
if (entry && existsSync(entry) && fileURLToPath(import.meta.url) === realpathSync(entry)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
