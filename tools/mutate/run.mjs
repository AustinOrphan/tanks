#!/usr/bin/env node
/**
 * Hand-picked mutation testing: apply a hand-picked edit to a source file, run a scoped
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
 *     mutation "KILLED" regardless of what it does, at exit 0. Entries with the exact
 *     same ordered scope reuse that baseline within one manifest invocation, only
 *     after every earlier mutation has been restored and byte-verified
 *   - the manifest's declared `tests` must actually be able to REACH the mutated file
 *     (checked per file from one shared Vitest dependency graph, before anything is
 *     mutated) --
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
 *   npm run mutate -- --manifest tools/mutate/manifests        # a directory: every *.json in it, by name
 *   npm run mutate -- --changed origin/main [--list]           # only the entries the diff since that ref can affect
 *   npm run mutate -- --changed origin/main --shard 2/4        # the second of four cost-balanced shards of that selection
 *   npm run mutate -- --only skins-min-accent-delta-200
 *   npm run mutate -- --only a-first-id --only a-second-id      # repeatable, and `--only a,b` is the same thing
 *   npm run mutate -- --root /path/to/checkout
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
import { readFileSync, writeFileSync, existsSync, rmSync, realpathSync, mkdtempSync, symlinkSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { tmpdir, availableParallelism } from 'node:os';
import { join, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAt, validateManifest, findUnreachableEntries, mergeManifestFiles } from './lib.mjs';
import { selectAffected } from './select.mjs';
import { runManifest, computeExitCode, STATUS, NO_VERDICT_STATUSES, RestoreFailedError } from './orchestrate.mjs';

/**
 * @typedef {import('./lib.mjs').ManifestEntry} ManifestEntry
 * @typedef {{ failed: number, total: number, failedSuites?: number, failedTests?: string[] }} TestRunResult
 * @typedef {{ id: string, status: string, matches: boolean, detail?: string, failed?: number, total?: number, failedTests?: string[], missingKilledBy?: string[] }} MutationResult
 * @typedef {{ reason: 'interrupted' | 'timeout' | 'indeterminate', detail: string }} FailureVerdict
 * @typedef {{ status: number | null, signal: string | null, error?: Error }} SpawnResultLike
 * @typedef {{ id: string, file: string, tests: string[], related: string[] }} UnreachableProblem
 * @typedef {{
 *   version: 1,
 *   sourceCount: number,
 *   testSpecificationCount: number,
 *   durationMs: number,
 *   relatedByFile: Record<string, string[]>,
 * }} ReachabilityReport
 * @typedef {{
 *   readFile: (file: string) => string,
 *   gitPorcelain: (file: string) => string,
 *   applyToDisk: (file: string, content: string) => void,
 *   restoreToDisk: (file: string, content: string) => void,
 *   runTests: (testFiles: string[]) => TestRunResult,
 *   onResult: (result: MutationResult, index: number, count: number, entry: ManifestEntry) => void,
 * }} Deps
 */

// This package knows nothing about where it lives relative to the project it is
// mutating -- it is a plain npm dependency (a workspace member here, potentially an
// installed one elsewhere), not a fixed number of directories below a repo root. Every
// path this file touches is resolved against an explicit `root`, sourced from `--root`
// and defaulting to `process.cwd()`: an `npm run` script (the primary way this is
// invoked) already sets cwd to the directory holding the package.json that defines the
// script, which for the normal "mutate" script IS the target repo's root, so the
// default needs no help there. `--root` exists for every other caller -- a bin invoked
// from a subdirectory, or a script that `cd`s before running this.
//
// fileURLToPath is still imported below, but now only for the CLI entry-point guard at
// the bottom of this file, not for computing a location relative to import.meta.url the
// way the old fixed-depth ROOT did.

// A blocking subprocess (a scoped Vitest run or the reachability worker) with no
// timeout cannot be interrupted by Vitest's OWN test timeout when this harness's
// meta-tests run it inside a Vitest worker -- a hang here would hang `npm test`
// forever, not just this tool. Generous, because a full related-files probe or a large
// scoped run can legitimately take tens of seconds; short enough that a genuine hang
// still surfaces.
const SUBPROCESS_TIMEOUT_MS = 180_000;
const SUBPROCESS_KILL_SIGNAL = 'SIGKILL';
const REACHABILITY_WORKER = fileURLToPath(new URL('./reachability.mjs', import.meta.url));

/** @param {string[]} argv
 * @returns {{ manifest: string, only: string[], root: string, jobs: number, report: string | null, changed: string | null, list: boolean, shard: Shard | null }} */
export function parseArgs(argv) {
  /** @type {{ manifest: string, only: string[], root: string, jobs: number, report: string | null, changed: string | null, list: boolean, shard: Shard | null }} */
  const args = { manifest: 'tools/mutate/manifests', only: [], root: process.cwd(), jobs: 1, report: null, changed: null, list: false, shard: null };
  // Every flag EXCEPT `--list` takes a value; one at the end of the line, or followed by
  // another flag, is refused by name rather than read as `undefined` and failed later
  // somewhere that cannot say which flag was short. `--list` is a bare boolean and does
  // not go through `value`.
  const value = (/** @type {number} */ i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') args.manifest = value(i++);
    else if (argv[i] === '--only') args.only.push(...onlyIds(value(i++)));
    else if (argv[i] === '--root') args.root = value(i++);
    else if (argv[i] === '--jobs') args.jobs = parseJobs(value(i++));
    else if (argv[i] === '--report') args.report = value(i++);
    else if (argv[i] === '--changed') args.changed = value(i++);
    else if (argv[i] === '--shard') args.shard = parseShard(value(i++));
    else if (argv[i] === '--list') args.list = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  // De-duplicated across every occurrence, first-seen order kept: `--only a --only a`
  // asked for one entry, and the requested count this run reports itself against (see
  // formatRunSummary) has to be the number of DISTINCT entries asked for, or "2
  // requested, 1 ran" would read as a silently dropped entry when nothing was dropped.
  args.only = [...new Set(args.only)];
  return args;
}

/**
 * The ids one `--only` occurrence names. `--only` is repeatable AND accepts a comma
 * list, because both are shapes people actually type and neither can be told from the
 * other by intent: this flag used to be `args.only = value(i++)`, a single string, so
 * `--only a --only b --only c` silently kept only `c` and reported "1/1 mutation(s)
 * ran", indistinguishable from a clean sweep of all three (issue #529). Under-running a
 * sweep is precisely what produces a green local run and a red `verify (current)`, so
 * both spellings now accumulate and neither can drop an id quietly.
 *
 * Splitting on a comma is safe against the ids this tool addresses: all 478 ids in the
 * shipped manifests (the whole population, swept with this commit's tree) match
 * [a-z0-9.-]+ and none contains a comma, and the README documents that shape. It is not
 * ENFORCED by validateEntry, which accepts any non-empty string -- but an id that did
 * contain a comma would split into halves that match nothing, and the unmatched-id
 * refusal names them and stops the run. Loud and wrong beats quiet and wrong, which is
 * the whole point of this flag's fix.
 *
 * An occurrence that names no id at all (`--only ""`, `--only ,`) is refused rather
 * than folded away: an empty accumulated list means "no filter, run everything", so
 * swallowing it would turn a typo into a full-manifest run. Same refusal
 * tools/baseline/args.mjs gives `--browser ,`.
 * @param {string} raw @returns {string[]}
 */
function onlyIds(raw) {
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('--only needs a value (one or more manifest entry ids)');
  return ids;
}

/**
 * `--jobs N` runs the manifest over N worktrees at once (issue #502); `--jobs auto`
 * leaves one core for the parent and the vitest workers' own overhead. 1 -- the
 * default -- is the serial harness exactly as before. Pure, so a test can pin the
 * parse without the machine's core count leaking into the expectation.
 * @param {string | undefined} raw @param {number} [cores] @returns {number}
 */
export function parseJobs(raw, cores = availableParallelism()) {
  if (raw === 'auto') return Math.max(1, cores - 1);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--jobs must be a positive integer or "auto", got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Worktrees left behind by a mutate run that died before it could clean up.
 *
 * `runParallel` removes its own worktrees in a `finally` and on SIGINT/SIGTERM, which covers
 * every exit it gets to observe. It does NOT cover SIGKILL, a crashed parent, or a harness
 * that kills the process group -- and those leave a full detached worktree per worker in the
 * temp directory. `git worktree prune` will not collect them: prune removes administrative
 * files for worktrees whose DIRECTORY is gone, and these directories are still there.
 * `git status` cannot see them either, since they are not in the working tree. So they
 * accumulate silently, one set per killed run, and the only way to find them is
 * `git worktree list`.
 *
 * WHY THAT MATTERS beyond tidiness: issue #664 tracks sweeps reporting baseline-red for tests
 * that pass in isolation, and the sightings correlate with orphans being present. The
 * mechanism is not established -- an idle worktree burns no CPU -- so this function is not
 * claimed as that issue's fix. It removes a known, measurable residue that currently has to
 * be cleared by hand from outside the repository, which is reason enough.
 *
 * SAFE UNDER CONCURRENCY, which is the whole reason the PID is in the directory name rather
 * than this reaping on a name prefix or an age threshold. A second mutate run happening right
 * now owns live worktrees that look exactly like abandoned ones; removing those would delete
 * a running job's working directory mid-mutation, which is far worse than the residue. A
 * worktree is only collected when its recorded PID names no live process.
 *
 * Pure: takes `git worktree list --porcelain` output and a liveness predicate, returns the
 * directories to remove. The caller does the removing, and a test can drive every branch
 * without spawning anything.
 *
 * @param {string} porcelain Output of `git worktree list --porcelain`.
 * @param {(pid: number) => boolean} isAlive
 * @param {number} selfPid The current process, never collected however it answers.
 * @returns {string[]}
 */
export function staleWorkerWorktrees(porcelain, isAlive, selfPid) {
  /** @type {string[]} */
  const stale = [];
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length).trim();
    // Anchored on the BASENAME, so a repository checked out under a path that happens to
    // contain "mutate-worker-" is not a candidate.
    const match = /^mutate-worker-(\d+)-/.exec(basename(dir));
    if (!match) continue;
    const pid = Number(match[1]);
    // A worktree from a build before the PID was in the name has no pid to check, so it does
    // not match above and is left alone. Deliberate: guessing about those is how a live run
    // gets its directory deleted.
    if (pid === selfPid || isAlive(pid)) continue;
    stale.push(dir);
  }
  return stale;
}

/**
 * Worker worktrees this reaper will not touch, because they were created before the PID was
 * part of the directory name and so carry nothing to check a process against.
 *
 * Reported rather than collected, and that asymmetry is the point. Removing one would mean
 * guessing that no live run owns it -- on a wrong guess, a running sweep loses its working
 * directory mid-mutation. Leaving them silent is the status quo that made them invisible in
 * the first place: `git status` does not show them and `git worktree prune` does not collect
 * them, so nobody learns they exist until something goes strange and someone thinks to run
 * `git worktree list`. Naming them costs one line and turns an invisible residue into a
 * visible one with an obvious manual fix.
 *
 * @param {string} porcelain Output of `git worktree list --porcelain`.
 * @returns {string[]}
 */
export function legacyWorkerWorktrees(porcelain) {
  /** @type {string[]} */
  const legacy = [];
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length).trim();
    const name = basename(dir);
    if (name.startsWith('mutate-worker-') && !/^mutate-worker-\d+-/.test(name)) legacy.push(dir);
  }
  return legacy;
}

/** True when a signal can be delivered to `pid` -- i.e. the process exists. Signal 0 performs
 * the permission and existence checks without sending anything. EPERM means it exists and is
 * not ours, which still counts as alive.
 * @param {number} pid @returns {boolean} */
export function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'EPERM';
  }
}

/**
 * How many test workers ONE mutate worker's vitest may use.
 *
 * THE BUG THIS FIXES, measured rather than reasoned about. Each mutate worker spawns
 * `vitest run` as a subprocess, and vitest sizes its OWN pool (`forks` by default in v3)
 * from the machine it finds -- it has no idea it is one of nine siblings doing the same
 * thing. On this 10-core development machine, `--jobs auto` (9 workers) was measured at a
 * PEAK OF 66 CONCURRENT NODE PROCESSES: nine mutate workers times roughly seven forks each,
 * against ten cores. Every one of those is running a real jsdom suite.
 *
 * The consequence is not slowness, it is FAILURE. Vitest's default per-test timeout is
 * 5000ms of WALL CLOCK, and a test that takes 200ms on an idle machine has no headroom at
 * six times oversubscription. When one blows, the harness reports its whole scope as
 * BASELINE-RED -- "the tests were already failing before any mutation" -- which is literally
 * true and reads as a broken repository rather than a starved one. That is issue #664's
 * symptom, and it cost PR #671 a required check on a diff that touched only the gallery.
 *
 * The parent already provides the parallelism, ACROSS workers. So the right share is the
 * machine divided by the number of workers, floored at one: total vitest workers then lands
 * near the core count instead of multiplying by it. At `--jobs auto`, where jobs is
 * `cores - 1`, this is exactly 1.
 *
 * Serial runs (`--jobs 1`, the default) are unchanged and deliberately so: with no siblings
 * there is nothing to divide, and a multi-file scope keeps the file parallelism that makes
 * it quick.
 *
 * Pure, so a test can pin the arithmetic without a machine of any particular size.
 * @param {number} jobs @param {number} cores @returns {number}
 */
export function vitestWorkersPerJob(jobs, cores) {
  return Math.max(1, Math.floor(cores / Math.max(1, jobs)));
}

/**
 * Split entries across `jobs` workers WITHOUT splitting an exact test scope: every
 * entry of one scope goes to one worker, so each scope is still baselined exactly
 * once per run (`runManifest` caches baselines per scope inside one process). Scopes
 * are placed costliest-first onto the worker with the least cost so far (issue #507):
 * a scope's cost is its entry count times `costOf(tests)`, the seconds one run of that
 * scope takes. Balancing by count alone put the hud scope (41 entries at 12 s) on one
 * worker that ran five minutes after the others had finished. Empty slices are
 * dropped, so fewer scopes than workers means fewer workers. Pure over the entries'
 * `tests` arrays and the injected cost; order within a worker is manifest order, and
 * ties keep the sort stable so equal costs reproduce the count balance exactly.
 * @template {{ tests: string[] }} T
 * @param {readonly T[]} entries @param {number} jobs
 * @param {(tests: readonly string[]) => number} [costOf] Seconds per run of a scope; 1 when absent.
 * @returns {T[][]}
 */
export function partitionByScope(entries, jobs, costOf = () => 1) {
  return dealByScope(entries, jobs, costOf).filter((slice) => slice.length > 0);
}

/**
 * The deal both `partitionByScope` and `shardByScope` cut from: EXACTLY `slots` slices
 * (at least one), empty ones kept, so slice `i` means the same thing however many of the
 * others are empty. Deterministic for the same entries and costs -- the scope sort is
 * stable over first-seen order and the lightest slot is the first of equal cost -- which
 * is what lets separate machines each compute only their own shard.
 * @template {{ tests: string[] }} T
 * @param {readonly T[]} entries @param {number} slots
 * @param {(tests: readonly string[]) => number} costOf
 * @returns {T[][]}
 */
function dealByScope(entries, slots, costOf) {
  /** @type {Map<string, T[]>} */
  const byScope = new Map();
  for (const entry of entries) {
    const key = JSON.stringify(entry.tests);
    const group = byScope.get(key);
    if (group) group.push(entry);
    else byScope.set(key, [entry]);
  }
  const costOfGroup = (/** @type {T[]} */ group) => group.length * costOf(group[0].tests);
  const scopes = [...byScope.values()].sort((a, b) => costOfGroup(b) - costOfGroup(a) || b.length - a.length);
  /** @type {{ entries: T[], cost: number }[]} */
  const slices = Array.from({ length: Math.max(1, slots) }, () => ({ entries: [], cost: 0 }));
  for (const group of scopes) {
    let lightest = slices[0];
    for (const slice of slices) if (slice.cost < lightest.cost) lightest = slice;
    lightest.entries.push(...group);
    lightest.cost += costOfGroup(group);
  }
  const order = new Map(entries.map((e, i) => [e, i]));
  return slices.map((slice) => slice.entries.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
}

/** @typedef {{ index: number, count: number }} Shard */

/**
 * `--shard i/n`: run the `i`th of `n` shards, 1-based (issue #724). Refused unless both
 * are whole numbers with 1 <= i <= n -- a `0/4` or a `5/4` would otherwise select an
 * empty shard and pass, which in CI is an entry quietly run by nobody.
 * @param {string} raw @returns {Shard}
 */
export function parseShard(raw) {
  const match = /^(\d+)\/(\d+)$/.exec(raw.trim());
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) {
    throw new Error(`--shard must be i/n with 1 <= i <= n, got ${JSON.stringify(raw)}`);
  }
  return { index, count };
}

/**
 * The entries shard `shard.index` of `shard.count` runs: the pool's scope-atomic,
 * costliest-first deal over exactly `count` slots, so the `count` shards between them
 * run every entry exactly once. Unlike `partitionByScope` an empty slot is KEPT and
 * returned as `[]`: a CI shard with nothing to do still has to finish green, or its
 * required fan-in never gets a result.
 * @template {{ tests: string[] }} T
 * @param {readonly T[]} entries @param {Shard} shard
 * @param {(tests: readonly string[]) => number} [costOf] Seconds per run of a scope; 1 when absent.
 * @returns {T[]}
 */
export function shardByScope(entries, shard, costOf = () => 1) {
  return dealByScope(entries, shard.count, costOf)[shard.index - 1];
}

/**
 * The line each shard prints before running: how many of the selected entries it took.
 * Summed over the shards of one CI run, the first numbers equal the second, which is
 * the check that nothing was dropped between machines.
 * @param {Shard} shard @param {number} ran @param {number} selected @returns {string}
 */
export function formatShardEcho(shard, ran, selected) {
  const head = `[shard] ${shard.index}/${shard.count}: ${ran} of ${selected} selected entr${selected === 1 ? 'y' : 'ies'}`;
  return ran === 0 ? `${head} -- nothing to run, every selected scope is dealt to another shard` : head;
}

/**
 * Best-effort read of the cost file: absent, unreadable or malformed all mean "no
 * measurements" (every scope then costs 1, the count balance) with a warning, never an
 * abort -- the file only ever affects how evenly the workers finish, so it must not be
 * able to stop a run. A non-object JSON value counts as malformed too.
 * @param {string} path @param {(message: string) => void} warn
 * @returns {Record<string, number>}
 */
export function readScopeCosts(path, warn) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`[pool] ${path} is not an object of scope costs; balancing by entry count`);
      return {};
    }
    return parsed;
  } catch (/** @type {any} */ e) {
    warn(`[pool] could not read ${path} (${e?.message ?? e}); balancing by entry count`);
    return {};
  }
}

/**
 * The per-scope run cost the pool balances with: `tools/mutate/scope-costs.json`, the
 * median seconds per entry of each exact scope as measured by a previous `--report`
 * run (`scope-costs.mjs` regenerates it). A scope the file does not know gets the
 * median of the known ones, so a brand-new test file is neither ignored nor assumed
 * heavy. Balance only ever depends on this, never correctness, so a stale file costs
 * seconds of idle worker time and nothing else.
 * @param {Record<string, number>} costs keyed by `JSON.stringify(tests)`
 * @returns {(tests: readonly string[]) => number}
 */
export function scopeCostLookup(costs) {
  const known = Object.values(costs).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  return (tests) => {
    const v = costs[JSON.stringify(tests)];
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
}

/**
 * One exit code for several workers, worst first: a restore failure (3, a worktree
 * left mutated) outranks an interruption (130), which outranks a mid-run error (4), a
 * refusal to start (2) and a declared-outcome mismatch (1). Any other non-zero code is
 * reported as 4 -- a worker that died without a verdict is a mid-run error, not a pass.
 * @param {readonly (number | null)[]} codes @returns {number}
 */
export function aggregateExitCodes(codes) {
  const severity = [3, 130, 4, 2, 1];
  const seen = new Set(codes.map((c) => (c === null ? 4 : severity.includes(c) || c === 0 ? c : 4)));
  for (const code of severity) if (seen.has(code)) return code;
  return 0;
}

/** `--manifest` may be given as an absolute path (a reviewer pointing at a scratch
 *  copy outside the repo, say) -- `join(root, x)` on an absolute `x` does NOT jump to
 *  filesystem root the way `path.resolve` would; it silently concatenates, so an
 *  absolute path was being resolved as if it were repo-relative.
 * @param {string} root @param {string} manifestArg @returns {string} */
export function resolveManifestPath(root, manifestArg) {
  return isAbsolute(manifestArg) ? manifestArg : join(root, manifestArg);
}

/**
 * One manifest file's text as its entries, naming `file` when the shape is wrong.
 *
 * The shape check lives HERE, not only in `mergeManifestFiles`: every reader goes through
 * this function -- `readManifestFiles` from disk, including for `migrate-killed-by.mjs`,
 * which rewrites each file in place and never merges, and `baseManifestById` from git.
 * Without it a malformed file reaches a caller's `entries.map` as an unnamed TypeError
 * instead of naming the broken file, and a per-entry OBJECT reaches a `for...of` that
 * expected an array.
 *
 * `single` records which shape it was, so a rewriter puts an entry back as an object
 * rather than silently promoting a per-entry file to a one-element array -- which would
 * work, and would undo the layout one file at a time.
 * @param {string} text @param {string} file @returns {{ entries: any[], single: boolean }}
 */
export function parseManifestText(text, file) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return { entries: parsed, single: false };
  if (parsed !== null && typeof parsed === 'object') return { entries: [parsed], single: true };
  throw new Error(`manifest ${file}: must be a JSON entry object, or an array of them`);
}

/**
 * The manifest as a list of files: ONE ENTRY PER FILE, under `manifests/<area>/<id>.json`
 * (issue #653).
 *
 * WHY, and what it replaces. Issue #505 split the manifest into one file per AREA, which
 * stopped two PRs in different areas conflicting. It could not stop two PRs in the SAME
 * area conflicting, because every new entry appends to the same closing lines of the same
 * file -- and with `game.json` at 429 entries and 557 KB, that was most of them. Five
 * merge conflicts in a single session were all this, and none was a disagreement: both
 * sides had appended, and resolution was "take the base, add the ids the branch adds"
 * every time.
 *
 * Being mechanical is what made it dangerous rather than harmless. It is a hand edit to a
 * half-megabyte file where taking one side wholesale drops the other's entries and NOTHING
 * FAILS -- the file stays valid JSON, the ids stay unique, and the only symptom is coverage
 * that quietly went missing.
 *
 * One entry per file removes the class by construction: two branches adding entries touch
 * two different files, so there is nothing to resolve. It also makes a PR's diff read as
 * "three new files" rather than a 38-line insertion into a blob, and gives each entry its
 * own `git log`.
 *
 * SHAPES ACCEPTED. A `.json` file holds either a single entry object (the per-entry files
 * this repository ships) or an array of them -- the array form is kept so `--manifest`
 * pointed at a scratch file outside the repo still works, which is a real reviewer
 * workflow. A directory holds `.json` files and/or one level of subdirectories of them;
 * the subdirectory name is the AREA, which is what `orchestrate.test.ts`'s placement guard
 * checks against. Returned per file so a tool that rewrites entries
 * (`migrate-killed-by.mjs`) can put each back where it came from, in the shape it found it.
 * @param {string} path @returns {{ path: string, entries: any[], single: boolean }[]}
 */
export function readManifestFiles(path) {
  const parse = (/** @type {string} */ file) => ({ path: file, ...parseManifestText(readFileSync(file, 'utf8'), file) });
  if (!statSync(path).isDirectory()) return [parse(path)];
  // Sorted at every level, so the flattened order is stable and a report is reviewable.
  // ONE level of nesting only: the layout is `manifests/<area>/<id>.json`, and recursing
  // further would let a stray directory contribute entries whose area nothing states.
  const out = [];
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) {
      for (const inner of readdirSync(child).filter((n) => n.endsWith('.json')).sort()) {
        out.push(parse(join(child, inner)));
      }
    } else if (name.endsWith('.json')) {
      out.push(parse(child));
    }
  }
  if (out.length === 0) throw new Error(`manifest directory ${path} holds no *.json file`);
  return out;
}

/** Every entry of the manifest at `path` (a file or a directory of files), in file order
 * then entry order, refusing an id present in two files. @param {string} path @returns {any[]} */
export function readManifest(path) {
  return mergeManifestFiles(readManifestFiles(path));
}

/** @param {string} cmd @param {string[]} argv @param {string} cwd @returns {string} */
function sh(cmd, argv, cwd) {
  return execFileSync(cmd, argv, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUBPROCESS_TIMEOUT_MS,
    killSignal: SUBPROCESS_KILL_SIGNAL,
  }).toString();
}

/** Pure decision on top of a `git status --porcelain` string, so it is testable without
 *  shelling out to git. Kept separate from assertAllClean's process.exit -- a test can
 *  assert the message without a real git repo or a real process exit.
 * @param {string} porcelain @returns {string | null} */
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
 *  refuse-if-dirty precedent tools/gallery/run.mjs follows for its --sweep.
 * @param {string[]} files @param {string} root */
function assertAllClean(files, root) {
  const report = dirtyReport(sh('git', ['status', '--porcelain', '--', ...files], root));
  if (report) {
    console.error(report);
    process.exit(2);
  }
}

/** Pure formatting for the reachability preflight's refusal, so it is testable without
 *  a real vitest subprocess.
 * @param {UnreachableProblem[]} problems @returns {string | null} */
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
 * Classifies why a child subprocess produced no output file, from its
 * spawnSync result alone (`{ status, signal, error }` -- the shape spawnSync always
 * returns, real or faked). Pure and exported so it is testable without spawning a
 * real, deliberately-broken child per case.
 *
 * Three reasons, and they must never be conflated:
 *
 *   - 'interrupted': a real SIGINT/SIGTERM reached the child (res.signal is one of
 *     those), OR a child caught the signal ITSELF and exited its own way -- measured
 *     directly: Vitest handles SIGINT internally and exits status 130 with signal
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
 *     report written (a crash, a broken Vitest install). This is the case that was
 *     previously conflated with "found nothing" -- measured directly (see
 *     orchestrate.test.ts): a genuinely-empty-but-successful probe (a file nothing
 *     imports) DOES write a valid per-source report at exit 0. A MISSING
 *     report is therefore never a legitimate "found nothing" -- reporting one as such
 *     is the exact false claim ("nothing tests this file at all") this classifier
 *     exists to prevent when the true state is "the probe itself never completed".
 * @param {SpawnResultLike} res @returns {FailureVerdict}
 */
export function classifySubprocessFailure(res) {
  if (res.signal === SUBPROCESS_KILL_SIGNAL) {
    return { reason: 'timeout', detail: `killed after ${SUBPROCESS_TIMEOUT_MS}ms with no response` };
  }
  if (res.signal != null || res.status === 130) {
    return { reason: 'interrupted', detail: res.signal ? `signal ${res.signal}` : 'child exited 130 (its own SIGINT handling)' };
  }
  if (res.error) {
    return { reason: 'indeterminate', detail: `could not launch subprocess: ${res.error.message}` };
  }
  return { reason: 'indeterminate', detail: `subprocess exited ${res.status} without writing a report` };
}

/** Turns a classifySubprocessFailure verdict into a thrown, appropriately-flagged
 *  Error. `.interrupted` is what runOne's catch blocks check; `.timeout` and
 *  `.indeterminate` are not treated as interruptions anywhere -- they propagate as
 *  real failures, restored-but-surfaced (see run()'s runManifest catch below).
 * @param {FailureVerdict} verdict @param {string} what */
function failureError(verdict, what) {
  const err = new Error(
    verdict.reason === 'interrupted'
      ? `${what} was interrupted (${verdict.detail})`
      : `${what} failed -- ${verdict.detail}`,
  );
  // Duck-typed flag, not a real Error subtype -- see the FailureVerdict/catch-site
  // comments elsewhere in this file for why `any` is the honest annotation here.
  /** @type {any} */ (err)[verdict.reason] = true; // .interrupted, .timeout, or .indeterminate
  return err;
}

/**
 * Validate and normalize the reachability worker's untrusted JSON output. Every
 * requested source must have its OWN array: accepting a union or silently treating a
 * missing key as empty would recreate the false "unreachable" claim this preflight
 * exists to prevent.
 * @param {unknown} value @param {string[]} files
 * @returns {{ relatedByFile: Map<string, Set<string>>, report: ReachabilityReport }}
 */
export function readReachabilityReport(value, files) {
  if (value == null || typeof value !== 'object') {
    throw new Error('reachability worker report must be an object');
  }
  /** @type {any} */
  const report = value;
  const uniqueFiles = [...new Set(files)];
  if (
    report.version !== 1 ||
    report.relatedByFile == null ||
    typeof report.relatedByFile !== 'object' ||
    Array.isArray(report.relatedByFile)
  ) {
    throw new Error('reachability worker report has an unsupported or missing schema');
  }
  if (
    report.sourceCount !== uniqueFiles.length ||
    !Number.isInteger(report.testSpecificationCount) || report.testSpecificationCount < 0 ||
    !Number.isInteger(report.durationMs) || report.durationMs < 0
  ) {
    throw new Error('reachability worker report has invalid or inconsistent metadata');
  }
  const relatedByFile = new Map();
  for (const file of uniqueFiles) {
    if (!Object.prototype.hasOwnProperty.call(report.relatedByFile, file)) {
      throw new Error(`reachability worker report has no per-source result for ${file}`);
    }
    const related = report.relatedByFile[file];
    if (!Array.isArray(related) || !related.every(
      (/** @type {unknown} */ path) => typeof path === 'string' && path.length > 0,
    )) {
      throw new Error(`reachability worker report has an invalid per-source result for ${file}`);
    }
    relatedByFile.set(file, new Set(related));
  }
  return { relatedByFile, report };
}

/**
 * Run one timeout-bounded worker that retains one Vitest context while querying every
 * distinct source file. The command/leading args are injectable so the existing real
 * crash, missing-binary and signal tests still exercise this exact spawn boundary.
 *
 * @param {string[]} files
 * @param {string} [root]
 * @param {string} [workerCommand]
 * @param {string[]} [workerArgs]
 * @returns {Map<string, Set<string>>}
 */
export function relatedFilesForAll(
  files,
  root = process.cwd(),
  workerCommand = process.execPath,
  workerArgs = [REACHABILITY_WORKER],
) {
  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length === 0) {
    throw new Error('reachability preflight requires at least one source file');
  }
  const outFile = join(tmpdir(), `mutate-related-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const res = spawnSync(workerCommand, [
      ...workerArgs,
      '--root', root,
      '--output', outFile,
      '--',
      ...uniqueFiles,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: SUBPROCESS_TIMEOUT_MS,
      killSignal: SUBPROCESS_KILL_SIGNAL,
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    if (!existsSync(outFile) || res.status !== 0 || res.signal != null || res.error) {
      throw failureError(classifySubprocessFailure(res), 'shared Vitest reachability worker');
    }
    const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    return readReachabilityReport(parsed, uniqueFiles).relatedByFile;
  } finally {
    rmSync(outFile, { force: true });
  }
}

/** Runs vitest against a scoped set of test files and returns exact pass/fail counts
 *  AND collection health, read from its own JSON reporter rather than parsed off
 *  stdout text or inferred from the exit code -- an exit code says a mutation was
 *  applied and something ran, not how many assertions failed, and says nothing at all
 *  about a file that failed to collect. --outputFile keeps the JSON off stdout, which
 *  also carries vite/test console noise that would otherwise have to be stripped
 *  first. `root` defaults to `process.cwd()`, same reasoning as parseArgs.
 * @param {string[]} testFiles @param {string} [root] @returns {TestRunResult} */
export function runTestsReal(testFiles, root = process.cwd()) {
  const outFile = join(tmpdir(), `mutate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const vitestBin = join(root, 'node_modules/.bin/vitest');
    // Set by the parent for POOL WORKERS only -- see `vitestWorkersPerJob`. Absent for a
    // serial run, which keeps vitest's own sizing and the whole machine.
    const share = process.env.MUTATE_VITEST_WORKERS;
    const poolArgs = share ? [`--maxWorkers=${share}`, `--minWorkers=${share}`] : [];
    const res = spawnSync(vitestBin, ['run', ...testFiles, ...poolArgs, '--reporter=json', `--outputFile=${outFile}`], {
      cwd: root,
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
      failedTests: failedTestNames(report),
    };
  } finally {
    rmSync(outFile, { force: true });
  }
}

/**
 * The vitest full names (`describe ... it` titles joined by spaces, as the JSON
 * reporter's `fullName`) of every failed assertion in a report, in report order. Pure
 * over the reporter's shape so a test can hand in a literal; a report with no
 * `testResults` (a run that never collected) names nothing.
 * @param {{ testResults?: { assertionResults?: { fullName?: string, status?: string }[] }[] }} report
 * @returns {string[]}
 */
export function failedTestNames(report) {
  const names = [];
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (a.status === 'failed' && typeof a.fullName === 'string') names.push(a.fullName);
    }
  }
  return names;
}

/** Narrower than `ManifestEntry` for `entry` on purpose: `expect`/`expectFailures`/
 * `equivalent` are the only fields this reads.
 * @param {MutationResult} result @param {number} index @param {number} count
 * @param {{ expect: string, expectFailures?: number, killedBy?: string[], equivalent?: boolean }} entry */
export function formatResult(result, index, count, entry) {
  const head = `[${index}/${count}] ${result.id}`;
  if (NO_VERDICT_STATUSES.has(result.status)) {
    return `${head} ... ${result.status} -- ${result.detail}`;
  }
  let tag = 'matches declared outcome';
  if (!result.matches) {
    // Three distinct ways to mismatch: the outcome itself (killed vs. survives); the
    // SAME outcome with a drifted count when the manifest pins expectFailures ("fails 4
    // of 12" quietly becoming "fails 5 of 13" is `killed` both times); or a `killedBy`
    // test that did not fail, named so the reader knows which pin rotted (issue #504).
    const missing = result.missingKilledBy ?? [];
    tag = result.status.toLowerCase() !== entry.expect
      ? `MISMATCH: manifest declared "${entry.expect}"`
      : missing.length > 0
        ? `MISMATCH: killedBy test(s) did not fail: ${missing.map((/** @type {string} */ m) => JSON.stringify(m)).join(', ')}`
        : `MISMATCH: manifest declared ${entry.expectFailures} failure(s), got ${result.failed}`;
  }
  const equiv = result.status === STATUS.SURVIVES && entry.equivalent ? ' [equivalent mutant]' : '';
  return `${head} ... ${result.status}${equiv} (${result.detail}) -- ${tag}`;
}

/**
 * The closing tally. `requested` is how many distinct ids `--only` named (0 when the
 * flag was not used), and it is printed BESIDE the ran/selected pair because the number
 * a reader needs to check is "did this run everything I asked for?" -- issue #529's
 * whole complaint was a run that reported "1/1 mutation(s) ran ... 0 mismatch(es)" for
 * three requested ids, a line indistinguishable from a clean sweep. Two of three
 * entries were skipped and nothing on screen said so.
 *
 * `selected` is what survived every narrowing (`--only`, then `--changed`) and
 * `results.length` is what actually ran, so ran < selected means an interruption and
 * selected < requested means a narrowing dropped something -- both now visible in one
 * line. Pure and exported so those relationships are testable without a run.
 * @param {readonly MutationResult[]} results @param {number} selected @param {number} requested
 * @returns {string}
 */
export function formatRunSummary(results, selected, requested = 0) {
  const count = (/** @type {string} */ status) => results.filter((r) => r.status === status).length;
  const asked = requested > 0 ? ` of ${requested} requested by --only` : '';
  return (
    `${results.length}/${selected}${asked} mutation(s) ran: ${count(STATUS.KILLED)} killed, ` +
    `${count(STATUS.SURVIVES)} survives, ${count(STATUS.FAILED_TO_APPLY)} failed-to-apply, ` +
    `${count(STATUS.BASELINE_RED)} baseline-red, ${count(STATUS.ERROR)} error -- ` +
    `${results.filter((r) => !r.matches).length} mismatch(es) vs. declared outcome`
  );
}

/**
 * The pre-run `--only` echo.
 *
 * Extracted rather than inlined at its one call site so it can be asserted, which is the
 * whole reason it exists: this line is the second line of defence for issue #529, and a
 * guard nothing tests is a guard that can be deleted or garbled without anyone noticing.
 * `formatRunSummary` above is extracted for the same reason.
 *
 * Echoed BEFORE the run, not only in the closing tally: a sweep can take minutes, and the
 * mistake this surfaces -- asking for more entries than are about to run -- is worth
 * seeing at second zero rather than after the wait.
 * @param {readonly { id: string }[]} entries @param {number} total
 * @returns {string}
 */
export function formatSelectionEcho(entries, total) {
  return `[select] --only: ${entries.length} of ${total} entries: ${entries.map((e) => e.id).join(', ')}`;
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
  /** @param {NodeJS.Signals} sig */
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

/**
 * The worktree pool (issue #502). Each worker is THIS harness, serial, in its own
 * detached `git worktree` of HEAD with `node_modules` linked from the checkout -- so a
 * mutation applied by one worker is never visible to another's scoped run, and every
 * restore/dirty/reachability guarantee of the serial path holds per worker unchanged.
 * The parent only partitions, spawns, relays output with a `[wN]` prefix, aggregates
 * exit codes and removes the worktrees.
 *
 * The committed tree is what runs, since a worktree of HEAD cannot see uncommitted
 * edits: the parent refuses to start with ANY tracked file dirty, stricter than the
 * serial path's mutated-files-only check on purpose.
 *
 * A worker whose restore failed (exit 3) keeps its worktree so the file can be
 * inspected; every other worktree is removed even on failure or interruption -- they
 * are throwaways, which is what makes Ctrl+C safe here in a way it never was for the
 * serial harness mutating the checkout itself.
 * @param {ManifestEntry[]} entries @param {number} jobs @param {string} root
 * @param {string | null} reportPath Where to write the merged per-entry report, if asked.
 * @returns {Promise<number>}
 */
async function runParallel(entries, jobs, root, reportPath) {
  const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no'], root).trim();
  if (dirty) {
    console.error(`--jobs ${jobs} runs the COMMITTED tree in detached worktrees, and these tracked files are not committed:\n${dirty}\ncommit or stash them first.`);
    return 2;
  }
  // Collect any previous run's abandoned worktrees BEFORE partitioning, so a killed sweep
  // does not leave the next one sharing the machine with its own wreckage.
  const stale = staleWorkerWorktrees(
    sh('git', ['worktree', 'list', '--porcelain'], root), pidIsAlive, process.pid,
  );
  for (const dir of stale) {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.manifest.json`, { force: true });
    rmSync(`${dir}.report.json`, { force: true });
  }
  if (stale.length) {
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8' });
    console.log(`[pool] removed ${stale.length} worktree(s) abandoned by an earlier run`);
  }
  const legacy = legacyWorkerWorktrees(sh('git', ['worktree', 'list', '--porcelain'], root));
  if (legacy.length) {
    console.error(
      `[pool] ${legacy.length} worker worktree(s) from a build before this cleanup existed are `
      + `still registered, and cannot be collected automatically (no pid to check):\n`
      + legacy.map((d) => `  git worktree remove --force ${d}`).join('\n'),
    );
  }
  const costs = readScopeCosts(join(root, 'tools/mutate/scope-costs.json'), (msg) => console.error(msg));
  const costOf = scopeCostLookup(costs);
  const slices = partitionByScope(entries, jobs, costOf);
  const estimate = (/** @type {ManifestEntry[]} */ slice) => Math.round(slice.reduce((sum, e) => sum + costOf(e.tests), 0));
  const scopes = new Set(entries.map((e) => JSON.stringify(e.tests))).size;
  console.log(`[pool] ${entries.length} mutation(s), ${scopes} exact test scope(s), ${slices.length} worker(s), scope costs from ${Object.keys(costs).length} measured scope(s)`);

  const thisFile = fileURLToPath(import.meta.url);
  /** @type {{ index: number, dir: string, code: number | null, child: import('node:child_process').ChildProcess | null, report?: MutationResult[] | null }[]} */
  const workers = [];
  const cleanup = () => {
    for (const w of workers) {
      if (w.code === 3) {
        console.error(`[w${w.index}] restore failed -- worktree kept for inspection: ${w.dir}`);
        continue;
      }
      spawnSync('git', ['worktree', 'remove', '--force', w.dir], { cwd: root, encoding: 'utf8' });
      rmSync(w.dir, { recursive: true, force: true });
    }
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8' });
  };
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    for (const w of workers) w.child?.kill('SIGKILL');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (let i = 0; i < slices.length; i++) {
      // realpath, not the path mkdtemp hands back: macOS's temp dir is a symlink, and
      // vitest names modules by realpath, so a worktree addressed through the symlink
      // reports NO test file related to any source and the worker refuses to start.
      // The PID goes in the NAME so a later run can tell a dead run's leftovers from a live
      // run's working directories -- see `staleWorkerWorktrees`. Same convention the report
      // and related-files temp paths above already use.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), `mutate-worker-${process.pid}-`)));
      sh('git', ['worktree', 'add', '--detach', dir, 'HEAD'], root);
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
      const slicePath = join(dir, '..', `${basename(dir)}.manifest.json`);
      writeFileSync(slicePath, JSON.stringify(slices[i], null, 2));
      workers.push({ index: i + 1, dir, code: null, child: null });
      console.log(`[w${i + 1}] ${slices[i].length} mutation(s), est. ${estimate(slices[i])}s, in ${dir}`);
    }
    await Promise.all(workers.map((w) => new Promise((resolve) => {
      const slicePath = join(w.dir, '..', `${basename(w.dir)}.manifest.json`);
      const workerReport = join(w.dir, '..', `${basename(w.dir)}.report.json`);
      const child = spawn(process.execPath, [thisFile, '--root', w.dir, '--manifest', slicePath, '--report', workerReport], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The worker's share of the machine. Passed by ENVIRONMENT rather than as a flag
        // because the worker IS run.mjs: a flag would have to be parsed, defaulted and kept
        // in step with parseArgs, for a value only the parent is in a position to know.
        env: { ...process.env, MUTATE_VITEST_WORKERS: String(vitestWorkersPerJob(slices.length, availableParallelism())) },
      });
      w.child = child;
      /** @param {import('node:stream').Readable} stream @param {(line: string) => void} write */
      const relay = (stream, write) => {
        let buffer = '';
        stream.setEncoding('utf8');
        stream.on('data', (/** @type {string} */ chunk) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf('\n')) >= 0) {
            write(`[w${w.index}] ${buffer.slice(0, at)}`);
            buffer = buffer.slice(at + 1);
          }
        });
        stream.on('end', () => { if (buffer) write(`[w${w.index}] ${buffer}`); });
      };
      relay(child.stdout, (line) => console.log(line));
      relay(child.stderr, (line) => console.error(line));
      child.on('close', (code, signal) => {
        w.code = code === null ? (signal === 'SIGKILL' && interrupted ? 130 : null) : code;
        rmSync(slicePath, { force: true });
        if (existsSync(workerReport)) {
          try {
            w.report = JSON.parse(readFileSync(workerReport, 'utf8')).entries;
          } catch {
            w.report = null; // a truncated worker report is a missing one, reported below
          }
          rmSync(workerReport, { force: true });
        }
        resolve(undefined);
      });
    })));
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanup();
  }
  const codes = workers.map((w) => w.code);
  console.log(`\n[pool] worker exit codes: ${codes.map((c, i) => `w${i + 1}=${c ?? 'none'}`).join(' ')}`);
  if (reportPath) {
    // Merged in manifest order, so the report reads like a serial run's would.
    const byId = new Map(workers.flatMap((w) => (w.report ?? []).map((r) => [r.id, r])));
    const merged = entries.map((e) => byId.get(e.id)).filter((r) => r !== undefined);
    const missing = workers.filter((w) => w.report == null).map((w) => `w${w.index}`);
    if (missing.length) console.error(`[pool] no report from ${missing.join(', ')}; the merged report covers ${merged.length} of ${entries.length} entries`);
    writeReport(reportPath, /** @type {MutationResult[]} */ (merged));
  }
  // An interruption is one more code to fold, not an override: a worker that could not
  // restore its file (3) still outranks the Ctrl+C that killed the others (130).
  return aggregateExitCodes(interrupted ? [...codes, 130] : codes);
}

/**
 * The pull-request selection's git half (issue #506): the merge base of `ref` and HEAD,
 * and every path that differs between them -- added, modified or deleted -- as the
 * repository-relative names the manifest uses.
 * @param {string} ref @param {string} root @returns {{ base: string, changed: string[] }}
 */
export function changedFilesSince(ref, root) {
  const base = sh('git', ['merge-base', ref, 'HEAD'], root).trim();
  const changed = sh('git', ['diff', '--name-only', base, 'HEAD'], root).split('\n').map((l) => l.trim()).filter(Boolean);
  return { base, changed };
}

/**
 * The manifest as it was at `base`, by id, for rule 2 (an entry whose text changed is
 * selected). Read through git rather than a checkout, and LISTED through git too.
 *
 * Issue #689: this used to list the WORKING TREE one level deep. Under the
 * `<area>/<id>.json` layout that found no file at all, so the map was always empty, every
 * entry read as new, and every pull request ran the whole manifest. A working-tree listing
 * also cannot see an entry file the branch deleted. `git ls-tree` at `base` answers both,
 * with the same traversal as `readManifestFiles` (direct `.json` files and one level of
 * area directories) and the same shape check, `parseManifestText`.
 *
 * A manifest path that did not exist at `base`, or lies outside the repository, contributes
 * nothing, which makes every entry new: the safe direction, selecting more rather than less.
 * @param {string} base @param {string} manifestArg @param {string} root
 * @returns {Map<string, unknown>}
 */
export function baseManifestById(base, manifestArg, root) {
  const byId = new Map();
  const resolved = resolveManifestPath(root, manifestArg);
  const git = (/** @type {string[]} */ argv) => spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const top = root.replace(/\/+$/, '');
  const rel = resolved.startsWith(`${top}/`) ? resolved.slice(top.length + 1).replace(/\/+$/, '') : null;
  if (rel === null) return byId;
  let paths = [rel];
  if (statSync(resolved).isDirectory()) {
    const listing = git(['ls-tree', '-r', '--name-only', base, '--', rel]);
    if (listing.status !== 0) throw new Error(`git ls-tree ${base} -- ${rel} failed: ${listing.stderr.trim()}`);
    paths = listing.stdout.split('\n').filter((p) => p.startsWith(`${rel}/`) && p.endsWith('.json') && p.slice(rel.length + 1).split('/').length <= 2);
  }
  for (const path of paths) {
    const shown = git(['show', `${base}:./${path}`]);
    if (shown.status !== 0) continue;
    for (const entry of parseManifestText(shown.stdout, `${base}:${path}`).entries) {
      if (typeof entry?.id === 'string') byId.set(entry.id, entry);
    }
  }
  return byId;
}

/**
 * Narrow the run to the entries `--only` named. Pure, so the property that matters --
 * every requested id either selects an entry or is reported missing -- is testable
 * without a manifest on disk.
 *
 * Selection keeps MANIFEST order rather than the order the ids were typed: entries
 * sharing an exact `tests` scope sit together in a manifest file, and `runManifest`
 * reuses a completed baseline only across consecutively-run entries of the same scope,
 * so obeying the command line's order could pay for the same baseline twice.
 *
 * `missing` is every requested id that matched nothing, not just the first. A run asked
 * for four ids and given one typo should say which one, once, before spending minutes
 * on the other three -- and reporting only the first would hide a second typo until the
 * next attempt.
 * @param {ManifestEntry[]} entries @param {readonly string[]} ids
 * @returns {{ entries: ManifestEntry[], missing: string[] }}
 */
export function selectOnly(entries, ids) {
  if (ids.length === 0) return { entries, missing: [] };
  const wanted = new Set(ids);
  const present = new Set(entries.map((e) => e.id));
  return {
    entries: entries.filter((e) => wanted.has(e.id)),
    missing: ids.filter((id) => !present.has(id)),
  };
}

/**
 * The refusal for `--only` ids that match no entry. Every unmatched id is named, and
 * the message says how many of how many were asked for, because the failure this whole
 * flag's fix exists to prevent is a sweep that quietly ran fewer entries than requested
 * (issue #529): a run that cannot honour part of what it was asked for must stop, not
 * proceed with the remainder and report a clean sweep of it.
 * @param {readonly string[]} missing @param {readonly string[]} requested
 * @returns {string | null}
 */
export function missingOnlyReport(missing, requested) {
  if (missing.length === 0) return null;
  const names = missing.map((id) => `  ${id}`).join('\n');
  return (
    `refusing to start: ${missing.length} of the ${requested.length} id(s) given to --only ` +
    `match no manifest entry:\n${names}\n` +
    'nothing was run -- check the spelling (`--only` accepts repeats and comma lists) and re-run.'
  );
}

/**
 * Narrow the run to what the diff since `ref` can affect (issue #506), printing every
 * selected entry with its reasons. The module graph is asked, through the same
 * reachability worker the preflight uses, which test files import any changed source
 * that still exists; deleted files reach entries through rule 1 (their `file`) instead.
 * @param {ManifestEntry[]} entries @param {string} ref @param {string} manifestArg @param {string} root
 * @returns {ManifestEntry[]}
 */
function selectChanged(entries, ref, manifestArg, root) {
  const { base, changed } = changedFilesSince(ref, root);
  console.log(`[select] ${changed.length} file(s) changed since ${base.slice(0, 7)} (merge base with ${ref})`);
  // `.json` is in the list because this repository imports data as modules -- the
  // balance, tank, profile and arena tables under `src/sim/config/data/`, the audio
  // suites -- so a change to one reaches its tests through the graph exactly as a `.ts`
  // change does. Without it a balance-only PR would select nothing at all. The manifest
  // files are excluded because nothing imports them: they are rule 2's business.
  const sources = changed.filter((f) => existsSync(join(root, f)) && /\.(ts|tsx|js|mjs|css|json)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('tools/mutate/manifests/'));
  const relatedTests = new Set();
  if (sources.length > 0) {
    for (const tests of relatedFilesForAll(sources, root).values()) for (const t of tests) relatedTests.add(t);
  }
  const selection = selectAffected({ entries, baseById: baseManifestById(base, manifestArg, root), changed, relatedTests });
  if (selection.all) {
    console.log(`[select] every entry: ${selection.reason}`);
    return entries;
  }
  for (const { entry, reasons } of selection.selected) console.log(`[select] ${entry.id}: ${reasons.join('; ')}`);
  console.log(`[select] ${selection.selected.length} of ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} can be affected`);
  return selection.selected.map((s) => s.entry);
}

async function run() {
  installSignalHandlers();
  const args = parseArgs(process.argv.slice(2));
  const root = args.root;
  const manifestPath = resolveManifestPath(root, args.manifest);
  // Cast, not inferred: JSON.parse returns `any`, and validateManifest's own parameter
  // type is deliberately `any[]` (it is what checks the shape of untrusted JSON in the
  // first place -- see lib.mjs). This annotation is the point past which the manifest
  // is trusted to be well-formed, which is true at runtime only because the
  // validateManifest call immediately below throws first if it is not.
  /** @type {ManifestEntry[]} */
  const allEntries = readManifest(manifestPath);
  validateManifest(allEntries);

  const selection = selectOnly(allEntries, args.only);
  const missingReport = missingOnlyReport(selection.missing, args.only);
  if (missingReport) {
    console.error(missingReport);
    process.exit(2);
  }
  let entries = selection.entries;
  // Echoed BEFORE the run, not only in the closing tally: a sweep can take minutes, and
  // the mistake this line exists to surface -- asking for more entries than are about
  // to run -- is worth seeing at second zero rather than after the wait.
  if (args.only.length > 0) console.log(formatSelectionEcho(entries, allEntries.length));
  if (args.changed !== null) {
    entries = selectChanged(entries, args.changed, args.manifest, root);
    if (args.list) return;
    if (entries.length === 0) {
      console.log('[select] nothing to run: the change cannot affect any manifest entry');
      return;
    }
  }
  // Cut LAST, after every narrowing, so each shard slices the same population. An empty
  // shard is a clean exit 0 that says so: a CI shard job has to finish green either way.
  if (args.shard !== null) {
    const selected = entries.length;
    const costOf = scopeCostLookup(readScopeCosts(join(root, 'tools/mutate/scope-costs.json'), (msg) => console.error(msg)));
    entries = shardByScope(entries, args.shard, costOf);
    console.log(formatShardEcho(args.shard, entries.length, selected));
    if (entries.length === 0) return;
  }

  // Every `tests` path too, not just `file`: a dirty-but-passing test file would
  // otherwise silently fold someone's uncommitted WIP into the baseline and
  // post-mutation counts, unnoticed because it never flips killed/survives on its
  // own -- only the exact numbers would be wrong, and wrong quietly.
  const files = [...new Set(entries.flatMap((e) => [e.file, ...e.tests]))];
  assertAllClean(files, root);

  // Reachability preflight: refuse to start (nothing mutated yet) if any entry's
  // declared `tests` cannot possibly exercise its `file`. One timeout-bounded worker
  // retains one Vitest/Vite dependency graph while still returning a separate related
  // set for every distinct source. Nothing is mutated yet at this point either way, so an
  // interruption here is always safe -- report it plainly (exit 130, matching the
  // interrupted-mid-run exit code) rather than letting it surface as a confusing
  // "these entries are unreachable" refusal, which is what a failed reachability
  // probe would otherwise look like (see classifySubprocessFailure/relatedFilesForAll).
  // An INDETERMINATE probe (not interrupted, just failed -- a broken vitest install,
  // a deleted binary) is deliberately NOT distinguished from any other setup failure
  // here: it falls through to main()'s catch and reports "could not determine which
  // tests relate to ..." at exit 2, which is honest about not knowing, rather than
  // "nothing tests this file" (a confident, false, zero-coverage claim).
  let unreachable;
  try {
    const mutationFiles = [...new Set(entries.map((entry) => entry.file))];
    const relatedByFile = relatedFilesForAll(mutationFiles, root);
    unreachable = findUnreachableEntries(entries, (file) => relatedByFile.get(file) ?? new Set());
  } catch (/** @type {any} */ e) {
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

  if (args.jobs > 1) {
    process.exitCode = await runParallel(entries, args.jobs, root, args.report);
    return;
  }

  /** @type {Deps} */
  const deps = {
    readFile: (file) => readFileSync(join(root, file), 'utf8'),
    gitPorcelain: (file) => sh('git', ['status', '--porcelain', '--', file], root),
    applyToDisk: (file, content) => writeFileSync(join(root, file), content),
    restoreToDisk: (file, content) => writeFileSync(join(root, file), content),
    runTests: (testFiles) => runTestsReal(testFiles, root),
    onResult: (result, index, count, entry) => {
      // Wall time since the previous line: one entry's apply, scoped run and restore
      // (the first line of each scope also carries that scope's baseline). Printed here
      // rather than inside formatResult so the pure formatter stays timeless, and kept
      // for the report, which is where `scope-costs.mjs` reads it.
      const now = Date.now();
      const secs = (now - lastResultAt) / 1000;
      lastResultAt = now;
      secondsById.set(result.id, secs);
      console.log(`${formatResult(result, index, count, entry)} [${secs.toFixed(1)}s]`);
    },
  };
  let lastResultAt = Date.now();
  /** @type {Map<string, number>} */
  const secondsById = new Map();

  const baselineScopes = new Set(entries.map((entry) => JSON.stringify(entry.tests))).size;
  console.log(
    `[baseline] ${entries.length} mutation(s), ${baselineScopes} exact test scope(s); ` +
    'each scope is checked at most once',
  );

  let results;
  try {
    results = runManifest(entries, deps, applyAt);
  } catch (/** @type {any} */ e) {
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

  console.log(`\n${formatRunSummary(results, entries.length, args.only.length)}`);

  const wasInterrupted = results.some((r) => r.status === STATUS.INTERRUPTED);
  if (wasInterrupted) {
    const remaining = entries.length - results.length;
    console.error(`stopped early after Ctrl+C: ${remaining} entr${remaining === 1 ? 'y' : 'ies'} not run`);
    process.exitCode = 130;
    return;
  }

  if (args.report) writeReport(args.report, results, secondsById);
  process.exitCode = computeExitCode(results);
}

/**
 * The machine-readable twin of the console lines (issue #504): one record per entry
 * with the outcome, the counts and the vitest full names that failed, which is what the
 * `killedBy` migration and any future selection tooling read. Written whole at the end
 * rather than streamed, so a partial file never looks like a finished run.
 * @param {string} path @param {(MutationResult & { seconds?: number | null })[]} results
 * @param {Map<string, number>} [secondsById] Wall seconds per entry, when measured here.
 */
export function writeReport(path, results, secondsById = new Map()) {
  const entries = results.map((r) => ({
    id: r.id,
    status: r.status,
    matches: r.matches,
    failed: r.failed ?? null,
    total: r.total ?? null,
    failedTests: r.failedTests ?? [],
    missingKilledBy: r.missingKilledBy ?? [],
    seconds: secondsById.get(r.id) ?? r.seconds ?? null,
  }));
  writeFileSync(path, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
}

async function main() {
  try {
    await run();
  } catch (/** @type {any} */ e) {
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
//
// Compared by REALPATH, not `import.meta.url === \`file://${process.argv[1]}\`` alone:
// this package declares a `bin`, and npm's bin mechanism symlinks that name into
// node_modules/.bin/. When invoked through the symlink, Node resolves import.meta.url
// to the target's realpath while process.argv[1] stays the symlink path itself -- a
// plain string comparison never matches, and main() silently never runs. Running this
// file directly (`node tools/mutate/run.mjs`, what `npm run mutate` does) is unaffected:
// realpathSync on a path that is not a symlink returns that same path.
const entryArg = process.argv[1];
if (entryArg && existsSync(entryArg) && fileURLToPath(import.meta.url) === realpathSync(entryArg)) {
  main();
}
