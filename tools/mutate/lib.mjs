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
