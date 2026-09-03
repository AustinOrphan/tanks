/**
 * Pure text-surgery and manifest validation for the mutation harness. No fs, no
 * child_process, no git -- everything here is a function of its arguments, which is
 * what makes it cheap to test with fixture strings instead of real files.
 */

/**
 * @typedef {{
 *   id: string, file: string, find: string, replace: string, why: string,
 *   expect: 'killed' | 'survives', tests: string[],
 *   occurrence?: number, expectFailures?: number, killedBy?: string[], reads?: string[], equivalent?: boolean,
 * }} ManifestEntry
 */

/**
 * @typedef {{ ok: true, content: string, count: number } | { ok: false, reason: 'not-found' | 'ambiguous' | 'bad-occurrence', count: number }} ApplyResult
 */

/** Every non-overlapping start index of `find` inside `content`.
 * @param {string} content
 * @param {string} find
 * @returns {number[]} */
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
 * @param {string} content
 * @param {string} find
 * @param {string} replace
 * @param {number} [occurrence]
 * @returns {ApplyResult}
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
 * `entry` is untrusted, arbitrary JSON at this point (that is the whole point of a
 * validator), so it is typed `any` deliberately rather than as `ManifestEntry` --
 * every field access below is itself a check that the shape is what it claims.
 * @param {any} entry
 * @param {number} index
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
  if (!Array.isArray(entry.tests) || entry.tests.length === 0 || !entry.tests.every((/** @type {any} */ t) => typeof t === 'string' && t.length > 0)) {
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
  // `killedBy` (issue #504): the vitest full names of the tests that must fail under the
  // mutation. Named tests are stable when unrelated tests are added to the scoped file,
  // which an exact count is not; an entry pins one or the other, never both, so a reader
  // knows which contract it is looking at. `survives` has no killer to name.
  if (entry.killedBy !== undefined) {
    if (!Array.isArray(entry.killedBy) || entry.killedBy.length === 0 || !entry.killedBy.every((/** @type {any} */ t) => typeof t === 'string' && t.length > 0)) {
      throw new Error(`manifest ${label}: "killedBy" must be a non-empty array of vitest full test names when present`);
    }
    if (entry.expect === 'survives') {
      throw new Error(`manifest ${label}: "expect": "survives" cannot name a "killedBy" test`);
    }
    if (entry.expectFailures !== undefined) {
      throw new Error(`manifest ${label}: "killedBy" and "expectFailures" are alternatives -- pin the named tests or the exact count, not both`);
    }
  }
  // An entry with neither is outcome-only (killed or survives, nothing more). The harness
  // allows it -- fixtures and one-off probes use it -- and the shipped manifest's own
  // test (orchestrate.test.ts) is what requires every real killed entry to pin one.
  // `reads` (issue #506): files a scoped test reads through `fs` rather than imports,
  // which the module graph cannot see; the pull-request selection treats a change to one
  // of them as a change to the entry's inputs.
  if (entry.reads !== undefined) {
    if (!Array.isArray(entry.reads) || entry.reads.length === 0 || !entry.reads.every((/** @type {any} */ r) => typeof r === 'string' && r.length > 0)) {
      throw new Error(`manifest ${label}: "reads" must be a non-empty array of file paths when present`);
    }
  }
}

/** Validates the whole manifest: every entry, plus id uniqueness across the set.
 * @param {any[]} entries untrusted, arbitrary parsed JSON -- see validateEntry. */
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
 * says are related to `file` (real implementation: a separate per-source query against
 * one shared Vitest graph, in run.mjs/reachability.mjs). This function is pure given
 * that collaborator, so it is testable with a fake graph instead of a real Vitest
 * context per case.
 *
 * Only the three fields this function actually reads are required in the param type --
 * deliberately narrower than the full `ManifestEntry`, so a caller holding some other
 * (structurally compatible) entry shape does not have to conform to fields this
 * function never touches.
 * @param {{ id: string, file: string, tests: string[] }[]} entries
 * @param {(file: string) => Set<string>} relatedFilesFor
 * @returns {{ id: string, file: string, tests: string[], related: string[] }[]}
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

/**
 * Concatenate the entries of several manifest files (issue #505) in the order given --
 * the loader passes them sorted by filename, so the order is stable and reviewable --
 * refusing an id that appears in two files with BOTH paths named. Within one file a
 * duplicate is `validateManifest`'s to catch; across files nothing else looks.
 * @param {{ path: string, entries: any[] }[]} files
 * @returns {any[]}
 */
export function mergeManifestFiles(files) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  const out = [];
  for (const file of files) {
    if (!Array.isArray(file.entries)) {
      throw new Error(`manifest ${file.path}: must be a JSON array of entries`);
    }
    for (const entry of file.entries) {
      const id = entry?.id;
      if (typeof id === 'string' && seen.has(id) && seen.get(id) !== file.path) {
        throw new Error(`manifest id "${id}" appears in both ${seen.get(id)} and ${file.path}`);
      }
      if (typeof id === 'string') seen.set(id, file.path);
      out.push(entry);
    }
  }
  return out;
}
