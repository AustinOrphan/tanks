/**
 * Pure text-surgery and manifest validation for the mutation harness. No fs, no
 * child_process, no git -- everything here is a function of its arguments, which is
 * what makes it cheap to test with fixture strings instead of real files.
 */

/** Every non-overlapping start index of `find` inside `content`. */
export function findOccurrences(content, find) {
  if (typeof find !== 'string' || find.length === 0) {
    throw new Error('find must be a non-empty string');
  }
  const indices = [];
  let from = 0;
  for (;;) {
    const i = content.indexOf(find, from);
    if (i === -1) break;
    indices.push(i);
    from = i + find.length;
  }
  return indices;
}

/**
 * Replace exactly one occurrence of `find` with `replace`, chosen by the 1-based
 * `occurrence`. Returns a discriminated result rather than throwing, because the
 * caller (runOne) needs to turn a bad match into a FAILED-TO-APPLY report, not an
 * uncaught exception that aborts the whole run.
 *
 * Ambiguity is refused, not resolved by picking the first match: this repo has a
 * documented case (`sounds[key] = null` at two lines) where an unscoped find edited
 * the wrong occurrence and nobody noticed until review. `occurrence` is required
 * the moment `find` is not unique.
 */
export function applyAt(content, find, replace, occurrence) {
  const occurrences = findOccurrences(content, find);
  if (occurrences.length === 0) {
    return { ok: false, reason: 'not-found', count: 0 };
  }
  if (occurrences.length > 1 && occurrence == null) {
    return { ok: false, reason: 'ambiguous', count: occurrences.length };
  }
  const pick = occurrence == null ? 1 : occurrence;
  if (!Number.isInteger(pick) || pick < 1 || pick > occurrences.length) {
    return { ok: false, reason: 'bad-occurrence', count: occurrences.length };
  }
  const start = occurrences[pick - 1];
  const end = start + find.length;
  const content2 = content.slice(0, start) + replace + content.slice(end);
  return { ok: true, content: content2, count: occurrences.length };
}

const REQUIRED_STRINGS = ['id', 'file', 'find', 'replace', 'why'];

/**
 * Throws with the offending entry's id (or index, if the id itself is missing) and
 * the exact field at fault -- a bad manifest edit should fail loudly and specifically,
 * the same standard `config/validate.ts` holds JSON data to elsewhere in this repo.
 */
export function validateEntry(entry, index) {
  const label = typeof entry?.id === 'string' && entry.id ? entry.id : `entry #${index}`;
  if (entry == null || typeof entry !== 'object') {
    throw new Error(`manifest ${label}: must be an object`);
  }
  for (const field of REQUIRED_STRINGS) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new Error(`manifest ${label}: "${field}" must be a non-empty string`);
    }
  }
  if (entry.expect !== 'killed' && entry.expect !== 'survives') {
    throw new Error(`manifest ${label}: "expect" must be "killed" or "survives", got ${JSON.stringify(entry.expect)}`);
  }
  if (!Array.isArray(entry.tests) || entry.tests.length === 0 || !entry.tests.every((t) => typeof t === 'string' && t.length > 0)) {
    throw new Error(`manifest ${label}: "tests" must be a non-empty array of file-path strings`);
  }
  if (entry.occurrence !== undefined && (!Number.isInteger(entry.occurrence) || entry.occurrence < 1)) {
    throw new Error(`manifest ${label}: "occurrence" must be a positive integer when present`);
  }
  if (entry.equivalent !== undefined && typeof entry.equivalent !== 'boolean') {
    throw new Error(`manifest ${label}: "equivalent" must be a boolean when present`);
  }
  if (entry.find === entry.replace) {
    throw new Error(`manifest ${label}: "find" and "replace" are identical -- this mutation changes nothing`);
  }
  if (entry.expectFailures !== undefined) {
    if (!Number.isInteger(entry.expectFailures) || entry.expectFailures < 0) {
      throw new Error(`manifest ${label}: "expectFailures" must be a non-negative integer when present`);
    }
    // Catches a manifest authoring mistake, not a real outcome: "survives" already
    // means 0 failures and "killed" already means at least 1, by definition (see
    // runOne). A value that contradicts "expect" can never be matched by any real
    // test run, which is a stale/wrong manifest entry, not a live coverage question.
    if (entry.expect === 'survives' && entry.expectFailures !== 0) {
      throw new Error(`manifest ${label}: "expect": "survives" requires "expectFailures": 0, got ${entry.expectFailures}`);
    }
    if (entry.expect === 'killed' && entry.expectFailures === 0) {
      throw new Error(`manifest ${label}: "expect": "killed" requires "expectFailures" > 0, got 0`);
    }
  }
}

/** Validates the whole manifest: every entry, plus id uniqueness across the set. */
export function validateManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('manifest must be a non-empty array');
  }
  const seen = new Set();
  entries.forEach((entry, i) => {
    validateEntry(entry, i + 1);
    if (seen.has(entry.id)) throw new Error(`manifest: duplicate id "${entry.id}"`);
    seen.add(entry.id);
  });
}

/**
 * Finds manifest entries whose declared `tests` cannot possibly exercise their
 * `file` -- a scope that never runs the mutated code cannot tell "not caught" from
 * "not measured", and a mutation like that reports SURVIVES no matter what it does.
 *
 * `relatedFilesFor(file)` returns the Set of test files vitest's own dependency graph
 * says are related to `file` (real implementation: `vitest related`, in run.mjs). This
 * function is pure given that collaborator, so it is testable with a fake graph
 * instead of a real vitest subprocess per case.
 */
export function findUnreachableEntries(entries, relatedFilesFor) {
  const problems = [];
  for (const entry of entries) {
    const related = relatedFilesFor(entry.file);
    const reachable = entry.tests.some((t) => related.has(t));
    if (!reachable) {
      problems.push({ id: entry.id, file: entry.file, tests: entry.tests, related: [...related] });
    }
  }
  return problems;
}
