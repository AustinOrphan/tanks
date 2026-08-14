/**
 * Drives one mutation, and a whole manifest, through baseline -> apply -> test ->
 * restore.
 *
 * All IO is injected through `deps`, the same shape this repo already uses for
 * `game/loop.ts` and `game/driver.ts`: real fs/git/vitest in `run.mjs`, fakes in
 * `orchestrate.test.ts`. That split is what lets the meta-tests prove FAILED-TO-APPLY,
 * the exit-code contract and crash-safety in milliseconds, without spawning a real
 * vitest subprocess per case.
 *
 * deps:
 *   readFile(file)              -> string
 *   gitPorcelain(file)          -> string ('' when clean)
 *   applyToDisk(file, content)  -> void   (write the mutated bytes)
 *   restoreToDisk(file, content)-> void   (write the original bytes back)
 *   runTests(testFiles)         -> { failed, total, failedSuites }
 *                                  failedSuites is vitest's own numFailedTestSuites --
 *                                  NOT purely "files that failed to collect" (a suite
 *                                  containing an ordinary failing test is also
 *                                  "failed"), but the one shape that IS unambiguous is
 *                                  failed === 0 with failedSuites > 0: every collected
 *                                  test passed, yet a suite still failed, which only
 *                                  happens when a whole file failed to collect and
 *                                  contributed 0 to `failed`/`total`. See isRed and
 *                                  suiteNote below.
 *   onResult(result, index, count, entry) -> void  (called once per entry, for streaming)
 *
 * There is deliberately NO `shouldStop()`-style poll checked between entries. An
 * earlier draft had one, on the theory that a signal handler could flip a flag the
 * loop would notice between iterations. Measured false: `runManifest` (and everything
 * it calls) is fully synchronous end to end, and Node cannot dispatch a signal
 * handler's JS callback until the current synchronous stack unwinds -- which, for a
 * multi-entry run, means "not until the whole run has already finished". A live
 * SIGINT test confirmed the handler's own log line printed in 0 of 10 trials. The
 * ONLY interruption signal that is real is the child subprocess's own exit info
 * (`res.signal`, or vitest's own SIGINT handling exiting status 130): `deps.runTests`
 * must set `.interrupted = true` on the Error it throws when THAT is why it failed,
 * and runOne checks the error, not a flag. See run.mjs's classifySubprocessFailure.
 */

/**
 * @typedef {import('./lib.mjs').ManifestEntry} ManifestEntry
 * @typedef {import('./lib.mjs').ApplyResult} ApplyResult
 * @typedef {(content: string, find: string, replace: string, occurrence?: number) => ApplyResult} ApplyAt
 * @typedef {{ failed: number, total: number, failedSuites?: number }} TestRunResult
 * @typedef {{ id: string, status: string, matches: boolean, detail?: string, failed?: number, total?: number }} MutationResult
 * @typedef {{
 *   readFile: (file: string) => string,
 *   gitPorcelain: (file: string) => string,
 *   applyToDisk: (file: string, content: string) => void,
 *   restoreToDisk: (file: string, content: string) => void,
 *   runTests: (testFiles: string[]) => TestRunResult,
 *   onResult: (result: MutationResult, index: number, count: number, entry: ManifestEntry) => void,
 * }} Deps
 */

export const STATUS = {
  KILLED: 'KILLED',
  SURVIVES: 'SURVIVES',
  FAILED_TO_APPLY: 'FAILED-TO-APPLY',
  BASELINE_RED: 'BASELINE-RED',
  INTERRUPTED: 'INTERRUPTED',
  ERROR: 'ERROR',
};

/** Statuses that never carry a declared outcome to compare against -- the mutation
 *  never produced a real killed/survives measurement, so there is nothing to match. */
export const NO_VERDICT_STATUSES = new Set([
  STATUS.FAILED_TO_APPLY,
  STATUS.BASELINE_RED,
  STATUS.INTERRUPTED,
  STATUS.ERROR,
]);

/** Thrown only when the post-restore byte-compare fails: the working tree is left
 *  mutated and the caller (runManifest) must stop rather than continue to the next
 *  entry. Every OTHER exception runOne can encounter (an interrupted test run, an
 *  unexpected crash) is handled without leaving the tree in an unknown state -- see
 *  runOne's own comment on `deps.runTests`. */
export class RestoreFailedError extends Error {}

/** Only ever called with the `ok: false` branch of ApplyResult -- see runOne's `if (!applied.ok)`.
 * @param {Extract<ApplyResult, { ok: false }>} applied @param {string} file */
function reasonText(applied, file) {
  if (applied.reason === 'not-found') return `find string not present in ${file}`;
  if (applied.reason === 'ambiguous') {
    return `find string occurs ${applied.count} times in ${file}; manifest entry needs an "occurrence"`;
  }
  return `"occurrence" out of range (${file} has ${applied.count} match(es))`;
}

/** A test-run result counts as "red" -- something is wrong -- when either number is
 *  nonzero: a collected test failed, OR a suite failed for some other reason (which,
 *  per `suiteNote` below, is only distinguishable from "a normal failure's own suite"
 *  when `failed` is exactly 0 -- but for the yes/no question `isRed` answers, that
 *  distinction does not matter: either way, something did not pass clean). Checked
 *  directly rather than trusting vitest's own `success` boolean as a THIRD,
 *  separately-fakeable signal -- these two numbers are what `success` is itself
 *  derived from. Used both for the pre-mutation baseline (must NOT be red) and the
 *  post-mutation outcome (red = killed) -- the same signal, two different questions.
 * @param {TestRunResult} result */
function isRed(result) {
  return result.failed > 0 || (result.failedSuites ?? 0) > 0;
}

/**
 * `failedSuites` is NOT purely a collection-failure count -- measured directly (see
 * orchestrate.test.ts's real end-to-end cases): a file with three describe blocks and
 * one failing test inside one of them reports failedSuites: 1 too, because vitest's
 * JSON reporter counts a "suite" as roughly (file + describe blocks), and a suite
 * containing a real failure is itself "failed". So `failed > 0` and `failedSuites > 0`
 * are NOT independent signals in the common case -- a real failing test moves both.
 *
 * The one combination that is NOT ambiguous is `failed === 0` with `failedSuites > 0`:
 * every test that WAS collected passed, yet a suite still failed -- the only way that
 * happens is a suite (file) that failed to collect at all, contributing 0 to both
 * `failed` and `total` while still counting itself as one failed suite. That is
 * exactly the reviewer's proof case (a multi-file scope where one file's mutation
 * breaks its own syntax/imports): {failed: 0, total: 22, failedSuites: 1}. Only THAT
 * asymmetric shape is called out by name below; a normal failure (`failed > 0`) is not
 * given a misleading "failed to collect" gloss just because its suite total moved too.
 * @param {TestRunResult} result
 */
function suiteNote(result) {
  return result.failed === 0 && (result.failedSuites ?? 0) > 0
    ? `, ${result.failedSuites} suite(s) failed to collect (0 collected failures but a suite still failed -- almost certainly a broken import or syntax error)`
    : '';
}

/** @param {TestRunResult} baseline */
function baselineDetail(baseline) {
  return `baseline is red before any mutation: ${baseline.failed} of ${baseline.total} failing${suiteNote(baseline)}`;
}

/** @param {TestRunResult} result */
function resultDetail(result) {
  return `${result.failed} of ${result.total} test(s) failed${suiteNote(result)}`;
}

/**
 * Runs exactly one manifest entry. Returns a result object for every ordinary outcome
 * -- killed, survives, failed-to-apply, a red baseline, or a caught interruption -- and
 * throws ONLY a RestoreFailedError, only when the post-restore byte-compare fails.
 * @param {ManifestEntry} entry
 * @param {Deps} deps
 * @param {ApplyAt} applyAt
 * @returns {MutationResult}
 */
export function runOne(entry, deps, applyAt) {
  const dirty = deps.gitPorcelain(entry.file).trim();
  if (dirty) {
    return {
      id: entry.id,
      status: STATUS.ERROR,
      matches: false,
      detail: `refusing to mutate ${entry.file}: already dirty in git\n${dirty}`,
    };
  }

  const original = deps.readFile(entry.file);
  const applied = applyAt(original, entry.find, entry.replace, entry.occurrence);
  if (!applied.ok) {
    return {
      id: entry.id,
      status: STATUS.FAILED_TO_APPLY,
      matches: false,
      detail: reasonText(applied, entry.file),
    };
  }
  // applyAt already guarantees a byte difference on `ok: true` -- this is a second,
  // independent check on the actual returned bytes rather than a re-trust of that
  // guarantee, cheap enough to keep as a belt-and-braces assertion.
  if (applied.content === original) {
    return {
      id: entry.id,
      status: STATUS.FAILED_TO_APPLY,
      matches: false,
      detail: `no byte difference in ${entry.file} after apply`,
    };
  }

  // Baseline: the scoped tests must be green on the UNMUTATED file, or a post-mutation
  // failure is unattributable -- is it the mutation, or a test that was already red for
  // an unrelated reason? Nothing is written to disk yet, so no restore is needed here.
  let baseline;
  try {
    baseline = deps.runTests(entry.tests);
  } catch (/** @type {any} */ e) {
    // `.interrupted` is a duck-typed flag run.mjs's classifySubprocessFailure attaches
    // to a thrown Error (see this file's header comment) -- there is no narrower real
    // type for a caught exception's shape here, so `any` is the honest annotation.
    if (e?.interrupted) {
      return { id: entry.id, status: STATUS.INTERRUPTED, matches: false, detail: 'interrupted during the baseline check; nothing was mutated' };
    }
    throw e;
  }
  // isRed BEFORE the total === 0 check: a single-file scope where that one file fails
  // to COLLECT contributes 0 to both `failed` and `total`, which would otherwise read
  // as "no tests ran" (a manifest/path problem) rather than "red" (a real, if unusual,
  // baseline problem) -- collection failures must win the ordering, not lose to it.
  if (isRed(baseline)) {
    return {
      id: entry.id,
      status: STATUS.BASELINE_RED,
      matches: false,
      failed: baseline.failed,
      total: baseline.total,
      detail: baselineDetail(baseline),
    };
  }
  if (baseline.total === 0) {
    return {
      id: entry.id,
      status: STATUS.ERROR,
      matches: false,
      detail: `0 tests ran for baseline (${entry.tests.join(', ')}) -- check the path(s)`,
    };
  }

  deps.applyToDisk(entry.file, applied.content);
  try {
    let result;
    try {
      result = deps.runTests(entry.tests);
    } catch (/** @type {any} */ e) {
      // A thrown runTests (vitest killed mid-run) is ONLY non-fatal when we already
      // know why: the error itself says it was an interruption. Anything else is a
      // real, unexplained failure and must still abort the run -- the outer `finally`
      // below restores the file either way, so this branch does not risk leaving the
      // tree mutated.
      if (e?.interrupted) {
        return { id: entry.id, status: STATUS.INTERRUPTED, matches: false, detail: 'interrupted mid-mutation; the file was restored' };
      }
      throw e;
    }
    // Same ordering as the baseline check above, and for the same reason: a single
    // scoped file that fails to collect under the mutation is exactly what "killed"
    // is supposed to mean, even though it contributes 0 to `total` -- checking isRed
    // first is what makes that case KILLED instead of a misleading ERROR.
    if (!isRed(result) && result.total === 0) {
      return {
        id: entry.id,
        status: STATUS.ERROR,
        matches: false,
        detail: `0 tests ran for ${entry.tests.join(', ')} -- check the path(s)`,
      };
    }
    const actual = isRed(result) ? 'killed' : 'survives';
    // The outcome (killed/survives) matching is necessary but not sufficient: "fails 4
    // of 12" quietly becoming "fails 5 of 13" when a test is added is still `killed`
    // both times, and outcome-only matching would call that a match. When the manifest
    // pins expectFailures, a count drift is a mismatch too -- this is what makes a
    // stale count in a manifest entry (or a PR body copied from one) fail the tool
    // instead of being believed.
    const countOk = entry.expectFailures === undefined || result.failed === entry.expectFailures;
    return {
      id: entry.id,
      status: actual === 'killed' ? STATUS.KILLED : STATUS.SURVIVES,
      matches: actual === entry.expect && countOk,
      failed: result.failed,
      total: result.total,
      detail: resultDetail(result),
    };
  } finally {
    // Restore from the bytes we actually read, not `git checkout` -- this repo's
    // own history has git-checkout/stash operations destroy uncommitted work, and
    // restoring from memory needs neither git nor a clean index to be trustworthy.
    deps.restoreToDisk(entry.file, original);
    const restored = deps.readFile(entry.file);
    if (restored !== original) {
      throw new RestoreFailedError(
        `RESTORE FAILED for ${entry.file} -- the working tree is left mutated. ` +
        'Do not run another mutation; inspect and restore this file by hand.',
      );
    }
  }
}

/**
 * Runs every entry in order, streaming each result through deps.onResult as it
 * completes. Stops immediately if runOne throws -- which by construction is only ever
 * a RestoreFailedError, since every other failure mode (an interrupted test run) is
 * caught inside runOne and returned as an ordinary INTERRUPTED result instead.
 * @param {ManifestEntry[]} entries
 * @param {Deps} deps
 * @param {ApplyAt} applyAt
 * @returns {MutationResult[]}
 */
export function runManifest(entries, deps, applyAt) {
  const results = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let result;
    try {
      result = runOne(entry, deps, applyAt);
    } catch (/** @type {any} */ e) {
      deps.onResult(
        { id: entry.id, status: 'FATAL', matches: false, detail: String(e?.message ?? e) },
        i + 1,
        entries.length,
        entry,
      );
      throw e;
    }
    deps.onResult(result, i + 1, entries.length, entry);
    results.push(result);
    // An INTERRUPTED result is the one reliable interruption signal (see the deps
    // doc comment above) -- stop here rather than starting a further, riskier entry.
    if (result.status === STATUS.INTERRUPTED) break;
  }
  return results;
}

/** Non-zero when any entry's actual outcome did not match what the manifest declared.
 * Narrower than `MutationResult[]` on purpose: `.matches` is the only field this reads.
 * @param {{ matches: boolean }[]} results */
export function computeExitCode(results) {
  return results.some((r) => !r.matches) ? 1 : 0;
}
