/**
 * Running one capture inside one isolated source tree.
 *
 * Goes through `npm run capture`, the repository's supported entry point, rather than
 * importing the capture modules directly. That matters more than the process overhead: the
 * base side must be captured by BASE's capture tooling, not by head's. Importing would load
 * head's modules into this process and run them against base's source, which would attribute
 * any change in the capture pipeline itself to the code under review.
 *
 * `--retain-frames` is always on. The compare pipeline needs the raw PNGs, and the encoded
 * artifacts are explicitly not the thing it measures.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from '../capture/process.mjs';

/** Where a side's capture lands inside its own worktree. */
export const CAPTURE_OUT = 'artifacts/capture/compare-side';

export async function runCaptureAtRef({ worktree, recipeId, timeoutMs = 600_000 }, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  try {
    await run(
      'npm',
      ['run', 'capture', '--', '--recipe', recipeId, '--out', CAPTURE_OUT, '--retain-frames'],
      { cwd: worktree, timeoutMs, signal: deps.signal },
    );
  } catch (error) {
    throw new Error(`capture failed in ${worktree}: ${error.message}`, { cause: error });
  }
  const manifestPath = resolve(worktree, CAPTURE_OUT, 'capture.json');
  let manifest;
  try {
    manifest = JSON.parse(await (deps.readFile ?? readFile)(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`capture produced no readable manifest at ${manifestPath}: ${error.message}`, { cause: error });
  }
  // capture removes a partial publication on failure, so a manifest that exists and says
  // anything other than success means the contract was broken rather than merely unmet.
  if (manifest.status !== 'success') {
    throw new Error(`capture in ${worktree} reported status '${manifest.status}'`);
  }
  return { manifest, directory: resolve(worktree, CAPTURE_OUT) };
}
