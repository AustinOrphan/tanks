/**
 * The committed expectation the screen gate compares against, and the diff it reports
 * (issues #326, #840, #846).
 *
 * WHAT IS COMMITTED IS THE MEASUREMENTS JSON, not a hash of it and not the PNG. #840 decided
 * the gate asserts the measurement half and never pixels, for two reasons written out in
 * `README.md`: the watched properties already carry colour, type size and opacity beside the
 * box, and a 3D board renders through SwiftShader where pixels are least trustworthy.
 *
 * Committing the JSON rather than its hash is what makes the accept step reviewable. A hash
 * baseline gives a binary verdict and no way to see what moved; the array below diffs in a
 * pull request as the numbers themselves, which is the whole mechanism #840 chose:
 *
 *     "box": {
 *   -   "w": 114,
 *   +   "w": 132,
 *
 * PURE ON PURPOSE. Nothing here opens a browser or touches the network, so the comparison,
 * the diff rendering and the path rules are all unit-testable; `check.mjs` supplies the
 * captured side and `accept.mjs` is the only writer.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where a state's expectation lives. One file per state, named by its id. */
export const BASELINE_DIR = new URL('./baseline/', import.meta.url);

/**
 * The states the required subset covers: every screen state EXCEPT the played endings.
 *
 * Derived, never a list. #840's decision is a RULE -- "every state except the two played
 * endings" -- and the prose beside it quoted a count that the catalogue outgrew within a day
 * of being written. A rule survives new states; a count is a number waiting to be wrong.
 *
 * A played ending costs 22.9 s of software-GL play against 5.9 s for the pushed-outcome twin
 * that asserts the same panel, and the panel is the only thing a measurement can see. Same
 * argument `hit-sweep.mjs` already uses to keep them out of the menu sweep.
 */
export function subsetStates(states) {
  return states.filter((state) => !state.id.endsWith('.played'));
}

/** The file name a state's baseline takes. Ids are already `screen.`-prefixed and unique. */
export function baselineFileName(stateId) {
  if (!/^[a-z0-9.-]+$/.test(stateId)) throw new Error(`unsafe state id '${stateId}'`);
  return `${stateId}.json`;
}

/** Read a state's committed expectation, or null when it has none yet. */
export function readBaseline(dir, stateId) {
  const file = join(dir, baselineFileName(stateId));
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * The exact bytes a baseline file carries.
 *
 * Two-space indent and a trailing newline, the same shape every other committed JSON in this
 * repository takes, so `accept` writes a file that diffs cleanly rather than one that
 * reformats the whole array the first time anything else touches it.
 */
export function serialiseBaseline(stateId, measurements) {
  return `${JSON.stringify({ state: stateId, measurements }, null, 2)}\n`;
}

/**
 * Every field-level difference between an expectation and a capture, in reading order.
 *
 * SELECTOR-KEYED, not index-keyed. A state that gains or loses a measured selector should
 * report that selector by name rather than reporting every later entry as changed, which is
 * what a positional walk does and what makes a diff unreadable exactly when it matters.
 */
export function diffMeasurements(expected, actual) {
  const changes = [];
  const byName = (list) => new Map(list.map((m) => [m.selector, m]));
  const want = byName(expected);
  const got = byName(actual);

  for (const [selector, e] of want) {
    const a = got.get(selector);
    if (a === undefined) {
      changes.push({ selector, field: '(whole entry)', expected: 'measured', actual: 'no longer measured' });
      continue;
    }
    for (const field of ['present', 'visible', 'text']) {
      if (JSON.stringify(e[field]) !== JSON.stringify(a[field])) {
        changes.push({ selector, field, expected: e[field], actual: a[field] });
      }
    }
    for (const axis of ['x', 'y', 'w', 'h']) {
      const ev = e.box?.[axis];
      const av = a.box?.[axis];
      if (ev !== av) changes.push({ selector, field: `box.${axis}`, expected: ev, actual: av });
    }
    const styles = new Set([...Object.keys(e.style ?? {}), ...Object.keys(a.style ?? {})]);
    for (const prop of [...styles].sort()) {
      const ev = e.style?.[prop];
      const av = a.style?.[prop];
      if (ev !== av) changes.push({ selector, field: `style.${prop}`, expected: ev, actual: av });
    }
  }
  for (const selector of got.keys()) {
    if (!want.has(selector)) {
      changes.push({ selector, field: '(whole entry)', expected: 'not measured', actual: 'newly measured' });
    }
  }
  return changes;
}

/**
 * One failure, in the shape #326 asks for: "Failure output names the recipe, route/state,
 * viewport/profile."
 *
 * All four, every time, because a diff without them is a set of numbers a reader cannot place
 * -- and the subset runs one viewport today, which is exactly the condition under which a
 * report quietly stops naming it and nobody notices until a second one exists.
 */
/**
 * One value, short enough to read in a terminal.
 *
 * A panel's `text` runs to hundreds of characters of markup whitespace, and printing two of
 * them whole turns the one line that says what changed into a screenful that hides it. The
 * FULL values are in `actual.json` and in the committed baseline beside it; this is the
 * summary a person scans, so it collapses runs of whitespace and stops at a readable length.
 */
export function brief(value, limit = 72) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length <= limit ? JSON.stringify(text).replace(/^"(.*)"$/, typeof value === 'string' ? '"$1"' : '$1')
    : `${JSON.stringify(`${text.slice(0, limit)}…`)} (${text.length} chars)`;
}

export function formatFailure({ recipeId, stateId, viewport, profile, changes }) {
  const where = `${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}`;
  const how = `${profile.visual}/${profile.capability}/motion=${profile.motion}`;
  const lines = [`FAIL ${recipeId}`, `  state    ${stateId}`, `  viewport ${where}`, `  profile  ${how}`];
  for (const c of changes) {
    lines.push(`  ${c.selector} ${c.field}: expected ${brief(c.expected)}, got ${brief(c.actual)}`);
  }
  return lines.join('\n');
}
