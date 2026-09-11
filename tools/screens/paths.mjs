import { dirname, join, resolve } from 'node:path';

/**
 * Where a screen capture's two artifacts go (issue #637).
 *
 * THE BUG THIS EXISTS TO REMOVE. Both paths used to be bare basenames defaulted inside
 * `run.mjs` and handed straight to `resolve()`, which resolves against the CURRENT WORKING
 * DIRECTORY -- the repository root for every `npm run` script. So a run that omitted either
 * flag dropped `screen.png` or `producer.json` into the root, where neither is ignored
 * (`.gitignore` anchors its scratch entries at `/tmp/` and `/scratchpad/`), and the next
 * `git add -A` committed a build artifact alongside real work. That happened twice.
 *
 * The sibling producer already had this right: `tools/gallery/run.mjs` treats `--report` as
 * an optional BASENAME and writes it to `${outDir}/${report}`, so it cannot escape the
 * output directory by construction. This restores the same rule here, and the divergence
 * is worth naming -- two producers feeding one capture framework disagreed about where
 * their output lives, and only one of them was reviewed against the framework's own
 * `resolveOutputPath` discipline (tools/capture/paths.mjs).
 *
 * The fix is deliberately NOT a `.gitignore` entry. Ignoring the artifact hides the symptom
 * and leaves the next root-level artifact equally invisible; giving it a home means a file
 * appearing in the root stays the loud signal it should be.
 */

/**
 * The frame's default destination: under the root-anchored `/tmp/` scratch directory that
 * `.gitignore` already covers, never the repository root. Every documented invocation
 * passes `--out` explicitly (see this tool's README and `run.mjs`'s own header), so nothing
 * depends on the old value -- it was a fallback that only a hand-run reached, which is
 * exactly who it hurt.
 */
export const DEFAULT_OUT = 'tmp/screen.png';

/** The report's basename. It is never anywhere but beside the frame it describes. */
export const REPORT_BASENAME = 'producer.json';

/**
 * Resolve `--out` and `--report` to absolute paths.
 *
 * An omitted `--report` lands BESIDE the resolved frame rather than in the working
 * directory. That relationship is the point: the report describes that frame, and a capture
 * written to `out/records.png` whose report went to the repository root was never useful
 * there -- it was just far enough away to be missed. `tools/capture/screen-adapter.mjs`
 * already passes both paths explicitly into its own output directory, so the framework path
 * is unchanged by this and the default now agrees with what the framework always did.
 *
 * Pure, and exported for that reason: `run.mjs` shells out to Playwright the moment it is
 * imported, so path defaulting is the one part of it a test can reach.
 */
export function screenCapturePaths({ out, report } = {}) {
  const outPath = resolve(out ?? DEFAULT_OUT);
  return {
    out: outPath,
    report: report == null ? join(dirname(outPath), REPORT_BASENAME) : resolve(report),
  };
}
