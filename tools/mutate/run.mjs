#!/usr/bin/env node
/**
 * Hand-picked mutation testing: apply a hand-picked edit to a src/ file, run a scoped
 * slice of the suite, restore, and report KILLED / SURVIVES / FAILED-TO-APPLY /
 * BASELINE-RED / INTERRUPTED.
 *
 * This exists because doing this by hand with ad-hoc `perl -0pi -e` one-liners has
 * twice produced a false "SURVIVED": the pattern silently failed to match, the file
 * came back byte-identical, and the (unchanged) suite passing read as "no coverage
 * gap" when really nothing was mutated at all. So every step here is provable:
 *   - the find/replace is asserted to have actually changed the file's bytes
 *   - an ambiguous find (matches more than once) is refused, not guessed at
 *   - the scoped tests must be GREEN on the unmutated file first (a baseline check) --
 *     otherwise a pre-existing red test elsewhere in the same file reports every
 *     mutation "KILLED" regardless of what it does, at exit 0
 *   - the manifest's declared `tests` must actually be able to REACH the mutated file
 *     (checked once per file via `vitest related`, before anything is mutated) --
 *     otherwise a mutation scoped to the wrong test file reports SURVIVES, which reads
 *     as "nothing catches this" when the true state is "this was never measured"
 *   - a whole test file failing to COLLECT (a broken import, a syntax error the
 *     mutation introduced) is treated as caught, not as zero failures -- vitest's own
 *     JSON reporter carries `success`/`numFailedTestSuites` for exactly this, and an
 *     outcome built only from `numFailedTests` would call it SURVIVES
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
 * What SURVIVES actually means: the declared `tests`, run under vitest, did not fail
 * and did not fail to collect. It does NOT mean the repo's full gate (`tsc --noEmit &&
 * vitest run`) missed it -- a type-only mutation (e.g. widening a `const X = 43` to
 * `const X: string = 43`) can still be caught by `tsc` alone even when every vitest
 * assertion in scope passes. This harness does not run `tsc` as part of the verdict
 * (doubling the cost of every entry for a category hand-picked mutations rarely land
 * in), so read SURVIVES as "vitest, scoped, does not catch it" -- confirm separately
 * with `npm test` if a mutation might be type-only.
 *
 *   npm run mutate
 *   npm run mutate -- --manifest tools/mutate/manifest.json
 *   npm run mutate -- --only skins-min-accent-delta-200
 *
 * Exit codes: 0 clean, every entry matched its declared outcome. 1 ran clean but at
 * least one entry's actual outcome (or expectFailures count) did not match. 2 refused
 * to start at all -- a dirty file, an unreachable manifest entry, a probe that could
 * not determine relatedness, or any other setup-time failure; nothing was touched.
 * 3 a restore's post-write byte-compare disagreed -- the working tree may genuinely be
 * mutated, the one code that means "stop and look by hand". 4 some other failure mid-run
 * (an indeterminate probe, a subprocess timeout) -- the in-flight entry WAS restored
 * and verified before this surfaced, unlike 3. 130 interrupted (SIGINT/SIGTERM) before
 * or during a run; whatever was mutated at that point was restored and verified.
 *
 * See tools/mutate/orchestrate.test.ts for the harness's own tests, including the
 * negative controls this file's own doc comment above promises: a find that does not
 * match must report FAILED-TO-APPLY, and a manifest with a wrong declared outcome
 * must produce a non-zero exit.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAt, validateManifest, findUnreachableEntries } from './lib.mjs';
import { runManifest, computeExitCode, STATUS, NO_VERDICT_STATUSES, RestoreFailedError } from './orchestrate.mjs';

// fileURLToPath, not `new URL(...).pathname`: the latter leaves percent-encoding in
// place (a repo checked out under a path with a space or a non-ASCII character would
// get a ROOT that does not exist on disk), and does the wrong thing on Windows drive
// letters. fileURLToPath is the platform-correct inverse of pathToFileURL.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// A blocking subprocess (vitest, or `vitest related`) with no timeout cannot be
// interrupted by vitest's OWN test timeout when this harness's meta-tests run it
// inside a vitest worker -- a hang here would hang `npm test` forever, not just this
// tool. Generous, because a full related-files probe or a large scoped run can
// legitimately take tens of seconds; short enough that a genuine hang still surfaces.
const SUBPROCESS_TIMEOUT_MS = 180_000;
const SUBPROCESS_KILL_SIGNAL = 'SIGKILL';

export function parseArgs(argv) {
  const args = { manifest: 'tools/mutate/manifest.json', only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') args.manifest = argv[++i];
    else if (argv[i] === '--only') args.only = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/** `--manifest` may be given as an absolute path (a reviewer pointing at a scratch
 *  copy outside the repo, say) -- `join(ROOT, x)` on an absolute `x` does NOT jump to
 *  filesystem root the way `path.resolve` would; it silently concatenates, so an
 *  absolute path was being resolved as if it were repo-relative. */
export function resolveManifestPath(root, manifestArg) {
  return isAbsolute(manifestArg) ? manifestArg : join(root, manifestArg);
}

function sh(cmd, argv) {
  return execFileSync(cmd, argv, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUBPROCESS_TIMEOUT_MS,
    killSignal: SUBPROCESS_KILL_SIGNAL,
  }).toString();
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

/** Pure formatting for the reachability preflight's refusal, so it is testable without
 *  a real vitest subprocess. */
export function unreachableReport(problems) {
  if (problems.length === 0) return null;
  const lines = problems.map(
    (p) => `  ${p.id}: ${p.file} -- declared tests [${p.tests.join(', ')}] are not among the ` +
      `${p.related.length} test file(s) vitest's own dependency graph relates to ${p.file}` +
      (p.related.length ? `:\n    ${p.related.join('\n    ')}` : ' (none -- nothing tests this file at all)'),
  );
  return (
    'refusing to start: these manifest entries cannot possibly be measured -- their declared\n' +
    '"tests" do not reach the file they mutate, so a mutation there can only ever report\n' +
    'SURVIVES, indistinguishable from "genuinely not caught":\n' +
    `${lines.join('\n')}\n` +
    'fix the "tests" list (or add coverage), then re-run.'
  );
}

/**
 * Classifies why a `vitest`-spawning subprocess produced no output file, from its
 * spawnSync result alone (`{ status, signal, error }` -- the shape spawnSync always
 * returns, real or faked). Pure and exported so it is testable without spawning a
 * real, deliberately-broken vitest binary per case.
 *
 * Three reasons, and they must never be conflated:
 *
 *   - 'interrupted': a real SIGINT/SIGTERM reached the child (res.signal is one of
 *     those), OR vitest caught the signal ITSELF and exited its own way -- measured
 *     directly: vitest handles SIGINT internally and exits status 130 with signal
 *     NULL, not by dying from the signal the way an unhandled child would, so
 *     checking `res.signal` alone misses it. Safe to treat as a graceful stop: this
 *     classifier only ever runs before anything has been mutated (the reachability
 *     preflight) or from inside runOne's try/finally (which always restores
 *     regardless of what this returns).
 *   - 'timeout': the child was killed by OUR OWN configured killSignal (SIGKILL)
 *     after SUBPROCESS_TIMEOUT_MS -- checked BEFORE the general interrupted case,
 *     since SIGKILL is also "a signal". A real, distinct failure that must not be
 *     silently absorbed as a graceful interruption. (A false positive is possible if
 *     something else sends SIGKILL, e.g. the OS OOM-killer -- spawnSync's result
 *     carries no elapsed-time or origin information to distinguish that further, and
 *     this is not worth a wall-clock measurement to close.)
 *   - 'indeterminate': anything else -- `res.error` set (the binary could not even be
 *     launched: deleted, wrong permissions, ENOENT) or a plain nonzero exit with no
 *     report written (a crash, a broken vitest install). This is the case that was
 *     previously conflated with "found nothing" -- measured directly (see
 *     orchestrate.test.ts): a genuinely-empty-but-successful probe (a file nothing
 *     imports) DOES write a report (`testResults: []`, exit 0, status 0). A MISSING
 *     report is therefore never a legitimate "found nothing" -- reporting one as such
 *     is the exact false claim ("nothing tests this file at all") this classifier
 *     exists to prevent when the true state is "the probe itself never completed".
 */
export function classifySubprocessFailure(res) {
  if (res.signal === SUBPROCESS_KILL_SIGNAL) {
    return { reason: 'timeout', detail: `killed after ${SUBPROCESS_TIMEOUT_MS}ms with no response` };
  }
  if (res.signal != null || res.status === 130) {
    return { reason: 'interrupted', detail: res.signal ? `signal ${res.signal}` : 'vitest exited 130 (its own SIGINT handling)' };
  }
  if (res.error) {
    return { reason: 'indeterminate', detail: `could not launch vitest: ${res.error.message}` };
  }
  return { reason: 'indeterminate', detail: `vitest exited ${res.status} without writing a report` };
}

/** Turns a classifySubprocessFailure verdict into a thrown, appropriately-flagged
 *  Error. `.interrupted` is what runOne's catch blocks check; `.timeout` and
 *  `.indeterminate` are not treated as interruptions anywhere -- they propagate as
 *  real failures, restored-but-surfaced (see run()'s runManifest catch below). */
function failureError(verdict, what) {
  const err = new Error(
    verdict.reason === 'interrupted'
      ? `${what} was interrupted (${verdict.detail})`
      : `${what} failed -- ${verdict.detail}`,
  );
  err[verdict.reason] = true; // .interrupted, .timeout, or .indeterminate
  return err;
}

const relatedCache = new Map();

/** The set of test files vitest's OWN dependency graph says are related to `file`,
 *  relative to ROOT. One real `vitest related` subprocess per DISTINCT file in the
 *  manifest (cached), run once up front, before anything is mutated -- this is a
 *  manifest-correctness check, not a per-mutation cost.
 *
 *  `vitestBin` is overridable (default: the real binary) so tests can point this at a
 *  deliberately broken stub without touching the real installation every other test
 *  in this process depends on -- see orchestrate.test.ts's real end-to-end cases for
 *  a stub that exits 1 and one that does not exist at all. Exported for the same
 *  reason: this is the exact function that produced review's false "nothing tests
 *  this file at all" claim, and it had no test of its own. */
export function relatedFilesFor(file, vitestBin = join(ROOT, 'node_modules/.bin/vitest')) {
  const cacheKey = `${vitestBin}\0${file}`;
  if (relatedCache.has(cacheKey)) return relatedCache.get(cacheKey);
  const outFile = join(tmpdir(), `tanks-mutate-related-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  let related;
  try {
    const res = spawnSync(vitestBin, ['related', file, '--run', '--reporter=json', `--outputFile=${outFile}`], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
      killSignal: SUBPROCESS_KILL_SIGNAL,
    });
    if (!existsSync(outFile)) {
      throw failureError(classifySubprocessFailure(res), `vitest related, probing ${file},`);
    }
    const report = JSON.parse(readFileSync(outFile, 'utf8'));
    related = new Set((report.testResults ?? []).map((r) => relative(ROOT, r.name).split('\\').join('/')));
  } finally {
    rmSync(outFile, { force: true });
  }
  relatedCache.set(cacheKey, related);
  return related;
}

/** Runs vitest against a scoped set of test files and returns exact pass/fail counts
 *  AND collection health, read from its own JSON reporter rather than parsed off
 *  stdout text or inferred from the exit code -- an exit code says a mutation was
 *  applied and something ran, not how many assertions failed, and says nothing at all
 *  about a file that failed to collect. --outputFile keeps the JSON off stdout, which
 *  also carries vite/test console noise that would otherwise have to be stripped
 *  first. */
export function runTestsReal(testFiles) {
  const outFile = join(tmpdir(), `tanks-mutate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const vitestBin = join(ROOT, 'node_modules/.bin/vitest');
    const res = spawnSync(vitestBin, ['run', ...testFiles, '--reporter=json', `--outputFile=${outFile}`], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
      killSignal: SUBPROCESS_KILL_SIGNAL,
    });
    if (!existsSync(outFile)) {
      throw failureError(classifySubprocessFailure(res), 'vitest run');
    }
    const report = JSON.parse(readFileSync(outFile, 'utf8'));
    return {
      failed: report.numFailedTests,
      total: report.numTotalTests,
      failedSuites: report.numFailedTestSuites,
    };
  } finally {
    rmSync(outFile, { force: true });
  }
}

export function formatResult(result, index, count, entry) {
  const head = `[${index}/${count}] ${result.id}`;
  if (NO_VERDICT_STATUSES.has(result.status)) {
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
//
// What this handler does NOT do, despite an earlier draft's comment claiming it: it
// does not make the harness respond to a signal WHILE a mutation is in flight. Measured
// live: the handler's own log line printed in 0 of 10 SIGINT trials. The reason is
// structural, not a bug in the handler -- `run()` and everything it calls (runManifest,
// runOne, the vitest spawnSync calls) is fully synchronous, and Node cannot dispatch a
// registered signal handler's JS callback until the current synchronous call stack
// unwinds. For a multi-entry run, that means "not until the whole run has already
// finished" -- by which point there is nothing left to interrupt.
//
// What this handler DOES do, and the only reason it exists: a blocking spawnSync child
// (vitest) shares the foreground process group, so Ctrl+C reaches it directly too, and
// the child dies on ITS OWN disposition (or, for vitest specifically, its own SIGINT
// handling -- see classifySubprocessFailure). spawnSync then returns to us with a
// result whose signal/status IS the real interruption signal, checked synchronously,
// with no race. Registering ANY handler here changes this process's OWN kernel-level
// signal disposition the moment `process.on` is called (a synchronous effect, unlike
// the JS callback body) -- without it, Node's default SIGINT action would terminate
// THIS process outright, at the OS's discretion, possibly before spawnSync unblocks
// and runOne's `finally` (the restore) ever runs. So the handler's real job is narrow:
// stay alive long enough to finish restoring, nothing more.
let secondSignal = false;
function installSignalHandlers() {
  function onSignal(sig) {
    if (secondSignal) {
      // second Ctrl+C: stop being polite and let the default action kill us. (Since
      // the first press's callback could not run until the synchronous work below
      // returns either, THIS callback is subject to the identical delay -- but by
      // the time it does run, the run is over one way or another, so "kill us now"
      // is always safe.)
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.kill(process.pid, sig);
      return;
    }
    secondSignal = true;
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

async function run() {
  installSignalHandlers();
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolveManifestPath(ROOT, args.manifest);
  const allEntries = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(allEntries);

  const entries = args.only ? allEntries.filter((e) => e.id === args.only) : allEntries;
  if (args.only && entries.length === 0) {
    console.error(`no manifest entry with id "${args.only}"`);
    process.exit(2);
  }

  // Every `tests` path too, not just `file`: a dirty-but-passing test file would
  // otherwise silently fold someone's uncommitted WIP into the baseline and
  // post-mutation counts, unnoticed because it never flips killed/survives on its
  // own -- only the exact numbers would be wrong, and wrong quietly.
  const files = [...new Set(entries.flatMap((e) => [e.file, ...e.tests]))];
  assertAllClean(files);

  // Reachability preflight: refuse to start (nothing mutated yet) if any entry's
  // declared `tests` cannot possibly exercise its `file`. One `vitest related` call
  // per distinct file, cached. Nothing is mutated yet at this point either way, so an
  // interruption here is always safe -- report it plainly (exit 130, matching the
  // interrupted-mid-run exit code) rather than letting it surface as a confusing
  // "these entries are unreachable" refusal, which is what a failed `vitest related`
  // probe would otherwise look like (see classifySubprocessFailure/relatedFilesFor).
  // An INDETERMINATE probe (not interrupted, just failed -- a broken vitest install,
  // a deleted binary) is deliberately NOT distinguished from any other setup failure
  // here: it falls through to main()'s catch and reports "could not determine which
  // tests relate to ..." at exit 2, which is honest about not knowing, rather than
  // "nothing tests this file" (a confident, false, zero-coverage claim).
  let unreachable;
  try {
    unreachable = findUnreachableEntries(entries, relatedFilesFor);
  } catch (e) {
    if (e?.interrupted) {
      console.error(`\ninterrupted during the reachability preflight; nothing was mutated`);
      process.exitCode = 130;
      return;
    }
    throw e;
  }
  const report = unreachableReport(unreachable);
  if (report) {
    console.error(report);
    process.exit(2);
  }

  const deps = {
    readFile: (file) => readFileSync(join(ROOT, file), 'utf8'),
    gitPorcelain: (file) => sh('git', ['status', '--porcelain', '--', file]),
    applyToDisk: (file, content) => writeFileSync(join(ROOT, file), content),
    restoreToDisk: (file, content) => writeFileSync(join(ROOT, file), content),
    runTests: runTestsReal,
    onResult: (result, index, count, entry) => console.log(formatResult(result, index, count, entry)),
  };

  let results;
  try {
    results = runManifest(entries, deps, applyAt);
  } catch (e) {
    if (e instanceof RestoreFailedError) {
      // The one truly alarming case: the post-mutation byte-compare disagreed, so the
      // working tree really may be left mutated. Exit 3 is reserved for exactly this.
      console.error('\nFATAL:', e.message);
      console.error('Stopped early -- check `git status` / `git diff` for the file named above before doing anything else.');
      process.exitCode = 3;
      return;
    }
    // Any other exception that reached here (an indeterminate probe failure, a
    // subprocess timeout, an unexpected crash) still passed through runOne's
    // try/finally -- so the entry in progress WAS restored and byte-verified before
    // this surfaced. Real failure, worth stopping for, but not the "the tree may be
    // mutated" emergency exit 3 means -- a distinct code so the two are never conflated.
    console.error('\nERROR (mid-run):', e?.message ?? e);
    console.error('The file being mutated when this happened was restored and verified before this error surfaced.');
    process.exitCode = 4;
    return;
  }

  const killed = results.filter((r) => r.status === STATUS.KILLED).length;
  const survives = results.filter((r) => r.status === STATUS.SURVIVES).length;
  const failedToApply = results.filter((r) => r.status === STATUS.FAILED_TO_APPLY).length;
  const baselineRed = results.filter((r) => r.status === STATUS.BASELINE_RED).length;
  const errors = results.filter((r) => r.status === STATUS.ERROR).length;
  const mismatches = results.filter((r) => !r.matches).length;

  console.log(
    `\n${results.length}/${entries.length} mutation(s) ran: ${killed} killed, ${survives} survives, ` +
    `${failedToApply} failed-to-apply, ${baselineRed} baseline-red, ${errors} error -- ` +
    `${mismatches} mismatch(es) vs. declared outcome`,
  );

  const wasInterrupted = results.some((r) => r.status === STATUS.INTERRUPTED);
  if (wasInterrupted) {
    const remaining = entries.length - results.length;
    console.error(`stopped early after Ctrl+C: ${remaining} entr${remaining === 1 ? 'y' : 'ies'} not run`);
    process.exitCode = 130;
    return;
  }

  process.exitCode = computeExitCode(results);
}

async function main() {
  try {
    await run();
  } catch (e) {
    // A bad manifest, an unreadable file, or any other setup-time failure: a distinct
    // exit code (2, matching the "refuse to start" precedent above) so this can never
    // be confused with exit 1 (ran cleanly, but a declared outcome did not match) or
    // exit 3 (ran, then a restore failed mid-flight -- a materially worse situation).
    console.error('\nERROR:', e?.message ?? e);
    process.exitCode = 2;
  }
}

// Guarded so tests can import parseArgs/formatResult/dirtyReport/runTestsReal without
// running the CLI (and without it fighting the test runner over argv/exit codes).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
