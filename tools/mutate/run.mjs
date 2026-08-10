#!/usr/bin/env node
/**
 * Hand-picked mutation testing: apply a hand-picked edit to a src/ file, run a scoped
 * slice of the suite, restore, and report KILLED / SURVIVED / FAILED-TO-APPLY.
 *
 * This exists because doing this by hand with ad-hoc `perl -0pi -e` one-liners has
 * twice produced a false "SURVIVED": the pattern silently failed to match, the file
 * came back byte-identical, and the (unchanged) suite passing read as "no coverage
 * gap" when really nothing was mutated at all. So every step here is provable:
 *   - the find/replace is asserted to have actually changed the file's bytes
 *   - an ambiguous find (matches more than once) is refused, not guessed at
 *   - the restore is read back and byte-compared, not assumed from a zero exit
 *   - the declared outcome (killed/survives) is checked against what really happened,
 *     and a mismatch is what makes `npm run mutate`'s exit code non-zero -- so a
 *     stale count in a PR body or manifest entry fails the tool instead of being
 *     believed
 *   - a manifest entry can also pin the exact failure COUNT (`expectFailures`), which
 *     an outcome-only check cannot see drift: "fails 4 of 12" quietly becoming "fails
 *     5 of 13" when a test is added is `killed` both times, and only expectFailures
 *     turns that into a mismatch too
 *
 *   npm run mutate
 *   npm run mutate -- --manifest tools/mutate/manifest.json
 *   npm run mutate -- --only skins-min-accent-delta-200
 *
 * See tools/mutate/orchestrate.test.ts for the harness's own tests, including the
 * negative controls this file's own doc comment above promises: a find that does not
 * match must report FAILED-TO-APPLY, and a manifest with a wrong declared outcome
 * must produce a non-zero exit.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAt, validateManifest } from './lib.mjs';
import { runManifest, computeExitCode, STATUS } from './orchestrate.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;

export function parseArgs(argv) {
  const args = { manifest: 'tools/mutate/manifest.json', only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') args.manifest = argv[++i];
    else if (argv[i] === '--only') args.only = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function sh(cmd, argv) {
  return execFileSync(cmd, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Pure decision on top of a `git status --porcelain` string, so it is testable without
 *  shelling out to git. Kept separate from assertAllClean's process.exit -- a test can
 *  assert the message without a real git repo or a real process exit. */
export function dirtyReport(porcelain) {
  const dirty = porcelain.trim();
  if (!dirty) return null;
  return (
    'refusing to start: uncommitted changes in files this manifest mutates:\n' +
    `${dirty}\n` +
    'commit or stash them first -- a mutation run rewrites these and restores them after.'
  );
}

/** Files this run will touch, dirty-checked up front so an interrupted PRIOR run or
 *  unrelated in-progress edit is caught before anything is mutated -- the same
 *  refuse-if-dirty precedent tools/gallery/run.mjs follows for its --sweep. */
function assertAllClean(files) {
  const report = dirtyReport(sh('git', ['status', '--porcelain', '--', ...files]));
  if (report) {
    console.error(report);
    process.exit(2);
  }
}

/** Runs vitest against a scoped set of test files and returns exact pass/fail counts,
 *  read from its own JSON reporter rather than parsed off stdout text or inferred from
 *  the exit code -- an exit code says a mutation was applied and something ran, not
 *  how many assertions failed. --outputFile keeps the JSON off stdout, which also
 *  carries vite/test console noise that would otherwise have to be stripped first. */
export function runTestsReal(testFiles) {
  const outFile = join(tmpdir(), `tanks-mutate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const vitestBin = join(ROOT, 'node_modules/.bin/vitest');
    const res = spawnSync(vitestBin, ['run', ...testFiles, '--reporter=json', `--outputFile=${outFile}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (!existsSync(outFile)) {
      throw new Error(
        `vitest produced no report (exit ${res.status}). stderr:\n${(res.stderr ?? '').slice(0, 2000)}`,
      );
    }
    const report = JSON.parse(readFileSync(outFile, 'utf8'));
    return { failed: report.numFailedTests, total: report.numTotalTests };
  } finally {
    rmSync(outFile, { force: true });
  }
}

export function formatResult(result, index, count, entry) {
  const head = `[${index}/${count}] ${result.id}`;
  if (result.status === STATUS.FAILED_TO_APPLY || result.status === STATUS.ERROR) {
    // Always a mismatch by construction -- these never carry a declared outcome to
    // compare against, they mean the mutation never actually ran.
    return `${head} ... ${result.status} -- ${result.detail}`;
  }
  let tag = 'matches declared outcome';
  if (!result.matches) {
    // Two distinct ways to mismatch: the outcome itself (killed vs. survives), or --
    // when the manifest pins expectFailures -- the SAME outcome with a drifted count.
    // The second is the one an outcome-only check would miss: "fails 4 of 12" quietly
    // becoming "fails 5 of 13" is `killed` both times.
    tag = result.status.toLowerCase() === entry.expect
      ? `MISMATCH: manifest declared ${entry.expectFailures} failure(s), got ${result.failed}`
      : `MISMATCH: manifest declared "${entry.expect}"`;
  }
  const equiv = result.status === STATUS.SURVIVES && entry.equivalent ? ' [equivalent mutant]' : '';
  return `${head} ... ${result.status}${equiv} (${result.detail}) -- ${tag}`;
}

// Registered inside main(), not at module scope: this file is imported (for
// parseArgs/formatResult/dirtyReport/runTestsReal) by orchestrate.test.ts, which runs
// inside the NORMAL `npm test` vitest process -- installing a SIGINT/SIGTERM handler at
// import time would suppress that outer process's own Ctrl+C handling too.
let interrupted = false;
function installSignalHandlers() {
  // A blocking spawnSync child (vitest) shares the foreground process group, so
  // Ctrl+C reaches it too and it dies on its own default disposition -- spawnSync
  // then returns to us and runOne's try/finally restores the file exactly as it
  // would on any other exception. Registering a handler here does not (and cannot)
  // interrupt that blocking call; its job is narrower and just as necessary: without
  // ANY handler, Node's default SIGINT action would kill THIS process outright, at
  // the OS's discretion, possibly before spawnSync unblocks and finally runs. With a
  // handler installed, the default action is suppressed and we merely set a flag,
  // checked BETWEEN mutations, so no new (riskier) mutation starts after a Ctrl+C.
  function onSignal(sig) {
    if (interrupted) {
      // second Ctrl+C: stop being polite and let the default action kill us.
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.kill(process.pid, sig);
      return;
    }
    interrupted = true;
    console.error(`\nreceived ${sig} -- letting the in-flight mutation finish and restore, then stopping`);
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

async function main() {
  installSignalHandlers();
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = join(ROOT, args.manifest);
  const allEntries = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(allEntries);

  const entries = args.only ? allEntries.filter((e) => e.id === args.only) : allEntries;
  if (args.only && entries.length === 0) {
    console.error(`no manifest entry with id "${args.only}"`);
    process.exit(2);
  }

  const files = [...new Set(entries.map((e) => e.file))];
  assertAllClean(files);

  const deps = {
    readFile: (file) => readFileSync(join(ROOT, file), 'utf8'),
    gitPorcelain: (file) => sh('git', ['status', '--porcelain', '--', file]),
    applyToDisk: (file, content) => writeFileSync(join(ROOT, file), content),
    restoreToDisk: (file, content) => writeFileSync(join(ROOT, file), content),
    runTests: runTestsReal,
    onResult: (result, index, count, entry) => console.log(formatResult(result, index, count, entry)),
    shouldStop: () => interrupted,
  };

  let results;
  try {
    results = runManifest(entries, deps, applyAt);
  } catch (e) {
    console.error('\nFATAL:', e.message ?? e);
    console.error('Stopped early -- check `git status` / `git diff` for the file named above before doing anything else.');
    process.exitCode = 3;
    return;
  }

  const killed = results.filter((r) => r.status === STATUS.KILLED).length;
  const survives = results.filter((r) => r.status === STATUS.SURVIVES).length;
  const failedToApply = results.filter((r) => r.status === STATUS.FAILED_TO_APPLY).length;
  const errors = results.filter((r) => r.status === STATUS.ERROR).length;
  const mismatches = results.filter((r) => !r.matches).length;

  console.log(
    `\n${results.length}/${entries.length} mutation(s) ran: ${killed} killed, ${survives} survives, ` +
    `${failedToApply} failed-to-apply, ${errors} error -- ${mismatches} mismatch(es) vs. declared outcome`,
  );

  if (interrupted) {
    console.error(`stopped early after Ctrl+C: ${entries.length - results.length} entr${entries.length - results.length === 1 ? 'y' : 'ies'} not run`);
    process.exitCode = 130;
    return;
  }

  process.exitCode = computeExitCode(results);
}

// Guarded so tests can import parseArgs/formatResult/dirtyReport/runTestsReal without
// running the CLI (and without it fighting the test runner over argv/exit codes).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
