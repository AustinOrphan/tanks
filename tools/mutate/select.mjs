/**
 * Which manifest entries a change can affect (issue #506). Pure: the CLI gathers the
 * changed files, the base manifest and the module graph's answer, and this decides.
 *
 * An entry's outcome is a function of exactly three inputs -- its mutated `file`, its
 * scoped `tests`, and everything those tests import -- plus the entry text itself. A
 * change that touches none of them cannot move the outcome, so leaving that entry out
 * of a pull request's run loses nothing; `main` and the nightly lane still run every
 * entry. The one input the module graph cannot see is a test that reads a file through
 * `fs`, which an entry declares as `reads` so the rule stays explicit.
 */

/**
 * Paths whose change means the harness, the test runner or the dependency set moved:
 * every entry runs, because the question "which entries can this affect" has no
 * answer narrower than "all of them".
 */
export const ALWAYS_RUN_PATTERNS = [
  // The harness's CODE, which decides how every entry is judged. Deliberately not all of
  // `tools/mutate/`: its README cannot change an outcome (found by replaying this rule
  // against PR #508, which selected everything on a docs-only line), `manifests/*.json`
  // are per-entry through rule 2, and `scope-costs.json` only balances the pool.
  /^tools\/mutate\/[^/]*\.mjs$/,
  /^tools\/mutate\/package\.json$/,
  /^vite\.config\./,
  /^vitest\.config\./,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^\.github\/workflows\//,
];

/**
 * @typedef {{ id: string, file: string, tests: string[], reads?: string[] }} SelectableEntry
 */

/** A textual identity for rule 2: the entry as JSON with keys sorted, so key order in a file is not a change.
 * @param {any} entry @returns {string} */
export function entryText(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

/**
 * @template {SelectableEntry} T
 * @param {{
 *   entries: readonly T[],
 *   baseById: ReadonlyMap<string, unknown>,
 *   changed: readonly string[],
 *   relatedTests: ReadonlySet<string>,
 *   alwaysRun?: readonly RegExp[],
 * }} input
 * @returns {{ all: true, reason: string } | { all: false, selected: { entry: T, reasons: string[] }[] }}
 */
export function selectAffected(input) {
  const alwaysRun = input.alwaysRun ?? ALWAYS_RUN_PATTERNS;
  const changed = new Set(input.changed);
  for (const path of changed) {
    const hit = alwaysRun.find((re) => re.test(path));
    if (hit) return { all: true, reason: `${path} changed (${hit.source}), which can affect every entry` };
  }
  /** @type {{ entry: T, reasons: string[] }[]} */
  const selected = [];
  for (const entry of input.entries) {
    /** @type {string[]} */
    const reasons = [];
    if (changed.has(entry.file)) reasons.push(`mutated file ${entry.file} changed`);
    for (const t of entry.tests) {
      if (changed.has(t)) reasons.push(`scoped test ${t} changed`);
      else if (input.relatedTests.has(t)) reasons.push(`scoped test ${t} imports a changed module`);
    }
    const base = input.baseById.get(entry.id);
    if (base === undefined) reasons.push('entry is new');
    else if (entryText(base) !== entryText(entry)) reasons.push('entry text changed');
    for (const read of entry.reads ?? []) {
      if (changed.has(read)) reasons.push(`declared read ${read} changed`);
    }
    if (reasons.length > 0) selected.push({ entry, reasons });
  }
  return { all: false, selected };
}
