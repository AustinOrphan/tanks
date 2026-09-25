/**
 * The AI sweep's on-disk edits, as pure functions (issues #359, #908).
 *
 * ITS OWN MODULE for the reason `tools/visual/static-server.mjs` gives about its own split:
 * `run.mjs` calls `main()` at the top level, so a test that imported it would run a sweep.
 * These were exported from there and therefore untestable; nothing here touches the disk or
 * spawns anything, so a unit test can import it.
 *
 * WHY TEXT AND NOT `JSON.parse`/`stringify`. The sweep rewrites a file that is in the working
 * tree and restores it afterwards, so the restored bytes must be the original bytes -- a
 * reformat would leave a diff behind and, worse, would make the restore look like an edit.
 * Replacing the number in place is what keeps the file byte-identical everywhere else.
 */

/**
 * Set `field` on EVERY profile.
 *
 * The count is returned so the caller can assert the patch actually landed everywhere. A
 * regex that silently matched nothing would leave the shipped value in place and the run
 * would report it under a different label, which is the dead-knob failure in its most
 * convincing form.
 *
 * @param {string} text
 * @param {string} field
 * @param {number} value
 * @returns {{patched: string, count: number}}
 */
export function patchField(text, field, value) {
  const re = new RegExp(`("${field}"\\s*:\\s*)(-?[0-9.]+)`, 'g');
  let count = 0;
  const patched = text.replace(re, (_m, head) => {
    count += 1;
    return `${head}${value}`;
  });
  return { patched, count };
}

/**
 * Set `field` on ONE named profile, leaving every other profile alone (issue #908).
 *
 * WHY THIS EXISTS. `patchField` moves all eight profiles together, which answers "what does
 * this tunable do" and cannot answer "what would it do if these two tanks differed" -- the
 * question #908 is about. Sweeping one profile against seven held values is what shows a
 * personality difference rather than a global rebalance.
 *
 * SCOPED BY THE PROFILE'S OWN BLOCK, not by counting fields. The file is an object keyed by
 * profile id, each value a flat object, so the block runs from the key to its closing brace.
 * Finding that brace by scanning for the first `}` would stop at a nested object; this tracks
 * depth, so a profile that later gains one still patches correctly.
 *
 * Returns `count: 0` when the profile or the field is absent, and the caller must treat that
 * as a refusal -- a sweep that patched nothing would report the shipped value under a label
 * that says otherwise.
 *
 * @param {string} text
 * @param {string} profile
 * @param {string} field
 * @param {number} value
 * @returns {{patched: string, count: number}}
 */
export function patchProfileField(text, profile, field, value) {
  const span = profileBlock(text, profile);
  if (span === null) return { patched: text, count: 0 };
  const { open, close } = span;

  const block = text.slice(open, close + 1);
  const { patched: newBlock, count } = patchField(block, field, value);
  if (count === 0) return { patched: text, count: 0 };
  return { patched: text.slice(0, open) + newBlock + text.slice(close + 1), count };
}

/**
 * The `{ … }` span of one named profile: `open` at its `{`, `close` at its matching `}`.
 *
 * Extracted so `patchProfileField` and `readProfileField` cannot disagree about where a
 * profile ends -- two copies of a brace scan is exactly how a reader and a writer drift apart
 * and start reporting one profile's value while editing another's.
 *
 * @param {string} text
 * @param {string} profile
 * @returns {{open: number, close: number} | null} null when the profile or its brace is absent.
 */
function profileBlock(text, profile) {
  const keyRe = new RegExp(`"${profile}"\\s*:\\s*\\{`);
  const key = keyRe.exec(text);
  if (key === null) return null;

  const open = key.index + key[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  return { open, close };
}

/**
 * Read `field` from ONE named profile, without editing anything (issue #908).
 *
 * WHY A READER EXISTS AT ALL. The sweep's read-back check has to know what every profile it
 * did NOT patch should still say. Before this, the runner could only prove a patch landed
 * when all eight profiles moved together, and a `--profile` run had no read-back: its own
 * comment said the count plus the verdict were standing in for one. Reading the shipped
 * values out of the original text is what lets the parent assert the whole map -- the named
 * profile moved, the others did not.
 *
 * Returns `null` rather than 0 when the profile or the field is absent, because 0 is a legal
 * `targetCommitmentTime` -- `validate.ts` accepts non-negative and this sweep sweeps it -- and
 * "absent" must not read as "retarget immediately".
 *
 * THE PROFILE'S OWN FIELD, at depth 1 inside its block, never a nested object's copy of the
 * same name. This is deliberately STRICTER than `patchField`, which rewrites every match in
 * the block including a nested one (`patch.test.ts` pins that at count 2). The two are not in
 * conflict: `configFor` resolves the profile's own field, so that is the one a read-back has
 * to compare, and the nested copy the patcher also moves is not read by anything. A reader
 * that took the first match would report a nested 9 as the profile's value and then "verify"
 * an untouched profile against a number that was never its own.
 *
 * @param {string} text
 * @param {string} profile
 * @param {string} field
 * @returns {number | null}
 */
export function readProfileField(text, profile, field) {
  const span = profileBlock(text, profile);
  if (span === null) return null;
  const block = text.slice(span.open, span.close + 1);
  const re = new RegExp(`"${field}"\\s*:\\s*(-?[0-9.]+)|[{}]`, 'g');
  let depth = 0;
  for (let m = re.exec(block); m !== null; m = re.exec(block)) {
    if (m[0] === '{') depth += 1;
    else if (m[0] === '}') depth -= 1;
    else if (depth === 1) return Number(m[1]);
  }
  return null;
}

/** Every profile id in the file, in file order, for `--profile` to be checked against. */
export function profileIds(text) {
  return [...text.matchAll(/^ {2}"([A-Z0-9_]+)"\s*:\s*\{/gm)].map((m) => m[1]);
}
