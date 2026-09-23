/**
 * `node tools/devtools-pages/run.mjs [dist]` -- issue #947's check, as a command.
 *
 * ITS OWN FILE, and not a guarded block at the foot of `check.mjs`, because that shape
 * DEADLOCKS here. `journey.mjs` imports `check.mjs`; a `await import('./journey.mjs')`
 * inside `check.mjs` therefore waits on a module that is waiting for `check.mjs` to finish
 * evaluating. Node does not report a cycle -- the process drains its event loop and exits
 * **13** with "Detected unsettled top-level await" and nothing about the cause. The same
 * split is why `tools/gl/run.mjs` and `tools/screens/run.mjs` are separate from the modules
 * they drive, though those were split to keep Playwright out of a unit test.
 */
import { runPagesJourney } from './journey.mjs';

const dist = process.argv[2] ?? 'dist';
const failures = await runPagesJourney(dist).catch((error) => [
  `the journey threw rather than reporting: ${error?.message ?? error}`,
]);

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
