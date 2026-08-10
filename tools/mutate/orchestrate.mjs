/**
 * Drives one mutation, and a whole manifest, through apply -> test -> restore.
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
 *   runTests(testFiles)         -> { failed: number, total: number }
 *   onResult(result, index, count, entry) -> void  (called once per entry, for streaming)
 *   shouldStop()                -> boolean, optional (checked BETWEEN entries only --
 *                                  runOne's own try/finally is what protects the file
 *                                  mid-mutation; this just stops a NEW one starting)
 */

export const STATUS = {
  KILLED: 'KILLED',
  SURVIVES: 'SURVIVES',
  FAILED_TO_APPLY: 'FAILED-TO-APPLY',
  ERROR: 'ERROR',
};

function reasonText(applied, file) {
  if (applied.reason === 'not-found') return `find string not present in ${file}`;
  if (applied.reason === 'ambiguous') {
    return `find string occurs ${applied.count} times in ${file}; manifest entry needs an "occurrence"`;
  }
  return `"occurrence" out of range (${file} has ${applied.count} match(es))`;
}

/**
 * Runs exactly one manifest entry. Returns a result object; never throws for an
 * ordinary outcome (killed/survives/failed-to-apply) -- it throws only when the
 * post-restore byte-compare fails, because that means the working tree is left
 * mutated and the caller must stop rather than continue to the next entry.
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
  // Independent of applyAt's own success flag: a real byte compare, not a
  // restatement of the same logic that just decided "ok".
  if (applied.content === original) {
    return {
      id: entry.id,
      status: STATUS.FAILED_TO_APPLY,
      matches: false,
      detail: `no byte difference in ${entry.file} after apply`,
    };
  }

  deps.applyToDisk(entry.file, applied.content);
  try {
    const { failed, total } = deps.runTests(entry.tests);
    if (total === 0) {
      return {
        id: entry.id,
        status: STATUS.ERROR,
        matches: false,
        detail: `0 tests ran for ${entry.tests.join(', ')} -- check the path(s)`,
      };
    }
    const actual = failed > 0 ? 'killed' : 'survives';
    // The outcome (killed/survives) matching is necessary but not sufficient: "fails 4
    // of 12" quietly becoming "fails 5 of 13" when a test is added is still `killed`
    // both times, and outcome-only matching would call that a match. When the manifest
    // pins expectFailures, a count drift is a mismatch too -- this is what makes a
    // stale count in a manifest entry (or a PR body copied from one) fail the tool
    // instead of being believed.
    const countOk = entry.expectFailures === undefined || failed === entry.expectFailures;
    return {
      id: entry.id,
      status: actual === 'killed' ? STATUS.KILLED : STATUS.SURVIVES,
      matches: actual === entry.expect && countOk,
      failed,
      total,
      detail: `${failed} of ${total} test(s) failed`,
    };
  } finally {
    // Restore from the bytes we actually read, not `git checkout` -- this repo's
    // own history has git-checkout/stash operations destroy uncommitted work, and
    // restoring from memory needs neither git nor a clean index to be trustworthy.
    deps.restoreToDisk(entry.file, original);
    const restored = deps.readFile(entry.file);
    if (restored !== original) {
      throw new Error(
        `RESTORE FAILED for ${entry.file} -- the working tree is left mutated. ` +
        'Do not run another mutation; inspect and restore this file by hand.',
      );
    }
  }
}

/**
 * Runs every entry in order, streaming each result through deps.onResult as it
 * completes. Stops immediately if runOne throws (a failed restore) -- continuing
 * would apply further mutations on top of an already-inconsistent tree.
 */
export function runManifest(entries, deps, applyAt) {
  const results = [];
  for (let i = 0; i < entries.length; i++) {
    if (deps.shouldStop && deps.shouldStop()) break;
    const entry = entries[i];
    let result;
    try {
      result = runOne(entry, deps, applyAt);
    } catch (e) {
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
  }
  return results;
}

/** Non-zero when any entry's actual outcome did not match what the manifest declared. */
export function computeExitCode(results) {
  return results.some((r) => !r.matches) ? 1 : 0;
}
