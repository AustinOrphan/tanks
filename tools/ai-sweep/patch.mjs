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
  const keyRe = new RegExp(`"${profile}"\\s*:\\s*\\{`);
  const key = keyRe.exec(text);
  if (key === null) return { patched: text, count: 0 };

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
  if (close < 0) return { patched: text, count: 0 };

  const block = text.slice(open, close + 1);
  const { patched: newBlock, count } = patchField(block, field, value);
  if (count === 0) return { patched: text, count: 0 };
  return { patched: text.slice(0, open) + newBlock + text.slice(close + 1), count };
}

/** Every profile id in the file, in file order, for `--profile` to be checked against. */
export function profileIds(text) {
  return [...text.matchAll(/^ {2}"([A-Z0-9_]+)"\s*:\s*\{/gm)].map((m) => m[1]);
}
