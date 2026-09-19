/**
 * The ONE action that rewrites a screen baseline (issues #326, #840, #846).
 *
 * Its own file, not a flag on `check.mjs`, and that separation is the mechanism rather than
 * tidiness. #326 requires that "a successful test run is not automatic approval of a changed
 * design"; a `--update` on the checking command is one habit away from a run that approves
 * its own change, and CI invokes the checking command.
 *
 * WHAT IT WRITES is the measurements array as JSON, pretty-printed. Committing the array
 * rather than a hash of it is what makes the review possible at all: the pull-request diff
 * shows which box moved and which property changed, in the numbers themselves. A hash would
 * give a reviewer two opaque strings and no way to tell a font bump from a broken layout.
 *
 * It refuses to accept a capture that raised a page error. A screen that throws is not a
 * design to be approved, and blessing one would commit the broken state as the expectation.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SCREEN_STATES } from './states.mjs';
import { captureState, launchBrowser, serve } from './capture.mjs';
import { BASELINE_DIR, subsetStates, baselineFileName, serialiseBaseline } from './baseline.mjs';
import { recipeFor } from './check.mjs';

/**
 * Which states an invocation may rewrite.
 *
 * `--state <id>` names one. `--all` is deliberately spelled out rather than being the default:
 * accepting everything is the move that turns a review into a rubber stamp, so it has to be
 * asked for.
 */
export function statesToAccept({ only, all }, states = subsetStates(SCREEN_STATES)) {
  if (only !== null && only !== undefined) {
    const found = states.filter((s) => s.id === only);
    if (found.length === 0) throw new Error(`--state '${only}' is not in the checked subset`);
    return found;
  }
  if (all) return states;
  throw new Error('name a state with --state <id>, or pass --all to rewrite every baseline');
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const dist = resolve(arg('dist', 'dist'));
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`no index.html under ${dist}`);
  const states = statesToAccept({ only: arg('state', null), all: process.argv.includes('--all') });
  const baselineDir = fileURLToPath(BASELINE_DIR);
  await mkdir(baselineDir, { recursive: true });

  const browser = await launchBrowser();
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  let written = 0;
  try {
    for (const state of states) {
      const recipe = recipeFor(state.id);
      const v = recipe?.viewport ?? { width: 1280, height: 800, devicePixelRatio: 2 };
      const { report } = await captureState(browser, base, state, {
        width: v.width, height: v.height, dpr: v.devicePixelRatio, timeout: 20000,
      });
      const errors = report.producer.pageErrors ?? [];
      if (errors.length > 0) {
        console.log(`REFUSED ${state.id}: the page raised an error, so there is no design to approve`);
        for (const e of errors) console.log(`  ${e}`);
        process.exitCode = 1;
        continue;
      }
      await writeFile(
        join(baselineDir, baselineFileName(state.id)),
        serialiseBaseline(state.id, report.producer.measurements),
      );
      written += 1;
      console.log(`accepted ${state.id} (${report.producer.measurements.length} measured selector(s))`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${written} baseline(s) written. Read the diff before committing it.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message ?? err); process.exitCode = 1; });
}
