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

/** Where a state's expectation lives. One file per state and viewport arm. */
export const BASELINE_DIR = new URL('./baseline/', import.meta.url);

/**
 * The extra viewports a few states are checked at (issue #633).
 *
 * The gate photographs everything at one desktop size, which is the size at which none of
 * #633's findings reproduce: a pane that cannot scroll is merely roomy at 1280x800, and a row
 * that cannot wrap has nothing to wrap. That issue's own "Evidence this needs" section asks for
 * these two arms by name, and without them every item in it is argued rather than measured.
 *
 * `narrow` is the 320 CSS px phone the issue names. `zoomed` is 200% browser zoom, which is not
 * a separate mechanism: doubling the zoom halves the CSS viewport, so a 1280x800 window at 200%
 * lays out as 640x400. Expressing it as a viewport rather than a zoom setting is what makes it
 * reproducible -- Playwright has no zoom knob, and a `deviceScaleFactor` change is device pixel
 * ratio, which is a different thing entirely.
 */
export const VIEWPORT_ARMS = Object.freeze([
  Object.freeze({ id: 'narrow', width: 320, height: 568, devicePixelRatio: 2 }),
  Object.freeze({ id: 'zoomed', width: 640, height: 400, devicePixelRatio: 2 }),
]);

/**
 * Which states carry the extra arms, and why these.
 *
 * A LIST, deliberately, where `subsetStates` is a rule. The rule there answers "is this state
 * cheap enough to check", which every state can be asked. This answers "is this state's layout
 * worth two more captures", which is a judgement about that state's markup, and inventing a
 * rule for it would mean inventing a property of a state that does not exist.
 *
 * NOT every state, because this is a required check. Each arm is a full capture, and 45 states
 * times three viewports is a gate three times its current length for evidence about panes whose
 * layout nothing in #633 questions. Six states, two arms: twelve extra captures.
 *
 * Three of the six carry an open #633 finding, and each one's `measure` list already names the
 * element the finding is about, so the arm produces a number rather than a picture to squint at:
 *
 *  - `screen.levels`      -- `.hud-levels` is a non-wrapping flex row inside `.hud-levelselect`,
 *                            which has no `overflow`. Both halves of that pairing are measured.
 *  - `screen.controllers` -- `.hud-controller-rows` inside the other pane with no `overflow`.
 *  - `screen.customize`   -- `.hud-preview` is a fixed 260x190 box in a pane with no padding.
 *
 * The other three are CONTROLS, and they are the half that makes a failure readable. They are
 * panes that already scroll (`.hud-panel`, `.hud-settings`, `.hud-about`), so a narrow capture
 * that broke all six would be telling us about the arm, not about the three findings.
 */
export const ARMED_STATE_IDS = Object.freeze([
  'screen.main-menu',
  'screen.levels',
  'screen.controllers',
  'screen.customize',
  'screen.settings',
  'screen.about',
]);

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

/**
 * Every (state, viewport) the gate checks, in the order it checks them.
 *
 * `arm: null` is the state's own recipe viewport -- the capture that existed before #633 and
 * whose baseline keeps its plain `<id>.json` name, so this change does not rewrite 45 files to
 * add 12. An armed state is checked at its recipe viewport FIRST and then at each arm, so a
 * failure reads down the log in the order a person would ask about it: does it work at all,
 * then does it work small.
 */
export function viewportPlan(states) {
  const plan = [];
  for (const state of states) {
    plan.push({ state, arm: null });
    if (!ARMED_STATE_IDS.includes(state.id)) continue;
    for (const arm of VIEWPORT_ARMS) plan.push({ state, arm });
  }
  return plan;
}

/** How a (state, arm) pair is named in a log line and an evidence directory. */
export function planLabel(stateId, armId) {
  return armId === null ? stateId : `${stateId} @ ${armId}`;
}

/** The file name a state's baseline takes. Ids are already `screen.`-prefixed and unique. */
export function baselineFileName(stateId, armId = null) {
  if (!/^[a-z0-9.-]+$/.test(stateId)) throw new Error(`unsafe state id '${stateId}'`);
  if (armId === null) return `${stateId}.json`;
  // `@` separates them because a state id cannot contain one -- the check above admits only
  // lowercase, digits, dots and hyphens. A hyphen would have been ambiguous against the ids
  // that already contain them, and the whole point of validating the name is that a baseline
  // path cannot be made to mean two things.
  if (!/^[a-z0-9-]+$/.test(armId)) throw new Error(`unsafe viewport arm '${armId}'`);
  return `${stateId}@${armId}.json`;
}

/** Read a state's committed expectation, or null when it has none yet. */
export function readBaseline(dir, stateId, armId = null) {
  const file = join(dir, baselineFileName(stateId, armId));
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
/**
 * Whether a capture's page errors are the ones its state exists to demonstrate.
 *
 * Both consumers refused ANY page error, on the reasonable ground that a page which threw has
 * no design to approve and nothing worth diffing. That is right for every state but the ones
 * whose whole subject is a page that failed: `screen.startup.entry-unparseable` serves an
 * entry bundle that cannot be parsed, so a `SyntaxError` is not noise on the way to the
 * picture, it IS the picture. Without a way to say so that state could never be accepted and
 * could never pass, which is a gate quietly not covering one of its own states.
 *
 * A state declares the error by substring rather than in full, because the text around it is
 * not ours to pin -- engines word these differently and a bundler can move what precedes the
 * offending token.
 *
 * The declaration is bidirectional on purpose. An expected error that does NOT appear fails
 * too: the state exists to prove the failure card is reached, so a capture that boots cleanly
 * has stopped demonstrating the thing, even though every measured selector may still match.
 */
export function judgePageErrors(state, pageErrors) {
  const errors = pageErrors ?? [];
  const expected = state?.pageError ?? null;
  if (expected === null) {
    return errors.length === 0 ? { ok: true, errors } : { ok: false, reason: 'unexpected', errors };
  }
  if (errors.length === 0) return { ok: false, reason: 'missing', errors, expected };
  const stray = errors.filter((e) => !String(e).includes(expected));
  if (stray.length > 0) return { ok: false, reason: 'mismatch', errors: stray, expected };
  return { ok: true, errors, expected };
}

/**
 * Why a `judgePageErrors` refusal refused, without naming the state.
 *
 * Separate from the state id because the two callers frame it differently: `accept` prints a
 * single `REFUSED <id>: <reason>` line, while `check` has already printed `FAIL <id>` above
 * and would otherwise say the id twice.
 */
export function pageErrorRefusalReason(verdict) {
  if (verdict.reason === 'missing') {
    return `expected a page error containing '${verdict.expected}', and the page raised none`;
  }
  if (verdict.reason === 'mismatch') {
    return `page error does not match the declared '${verdict.expected}'`;
  }
  return 'the page raised an error, so there is no design to approve';
}

/** The reason as one line naming the state, which is the form `accept` prints. */
export function formatPageErrorRefusal(verdict, stateId) {
  return `${stateId}: ${pageErrorRefusalReason(verdict)}`;
}

/**
 * How far a box may move between platforms before it counts as a change.
 *
 * Text-sized boxes are not exactly reproducible across operating systems, and bundling the
 * typeface (#864) does not make them so. It fixed WHICH face is used; the RASTERISER is still
 * the host's. `--font-render-hinting=none` (see `launchBrowser`) takes out the largest part of
 * what is left -- it cut this gate's cross-platform disagreement from 161 values to 33, and
 * every difference above 2px with it. What remains is the last fraction of a pixel landing on
 * either side of a rounding boundary, mostly through `line-height: normal`, which resolves
 * from font metrics the host reports and is not even a constant ratio across sizes.
 *
 * TWO pixels, and the number is argued rather than picked: the residue measured exactly 1px
 * (70 values) and 2px (36) across two full cross-platform runs, and nothing between 3px and
 * 54px survived the hinting flag. A real layout regression in this codebase is a control that
 * moved, a panel that reflowed or a line that wrapped -- tens of pixels, not two.
 *
 * It applies to BOX GEOMETRY ONLY. `present`, `visible`, `text` and every watched style
 * property stay exact, because none of them is a rasteriser artefact: a control that vanished,
 * a label that changed wording or a colour that moved is a real difference at any magnitude.
 */
export const BOX_TOLERANCE_PX = 2;

/** Whether two box values agree to within the tolerance; exact for anything non-numeric. */
export function boxWithinTolerance(expected, actual, tolerance = BOX_TOLERANCE_PX) {
  if (typeof expected !== 'number' || typeof actual !== 'number') return expected === actual;
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return expected === actual;
  return Math.abs(expected - actual) <= tolerance;
}

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
      if (!boxWithinTolerance(ev, av)) {
        changes.push({ selector, field: `box.${axis}`, expected: ev, actual: av });
      }
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
