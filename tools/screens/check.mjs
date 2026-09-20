/**
 * The screen gate: capture the subset, compare each state against its committed baseline,
 * and report every difference (issues #326, #840, #846).
 *
 * THIS COMMAND NEVER WRITES A BASELINE. That is the whole of #326's "it must not regenerate
 * or commit baselines automatically", and it is why the accept path lives in its own file
 * rather than behind a flag here: a `--update` on the checking command is one habit away from
 * a run that approves its own change.
 *
 * WHAT IT ASSERTS is the measurements block, per #840's decision -- see README.md, "The
 * required gate, decided". PNGs are written beside a failure as human evidence and are never
 * compared.
 *
 * AND PAGE ERRORS, which the measurement hash cannot see. `sweep.mjs` hashes
 * `report.producer.measurements` alone, so a state that started throwing would keep its hash
 * and pass. An uncaught error on a screen is a defect whatever the layout did, so it fails
 * here on its own.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SCREEN_STATES } from './states.mjs';
import { captureState, launchBrowser, serve } from './capture.mjs';
import { BASELINE_DIR, subsetStates, readBaseline, diffMeasurements, formatFailure, judgePageErrors, pageErrorRefusalReason } from './baseline.mjs';
import { CAPTURE_RECIPES } from '../capture/registry.mjs';
import { inspectSourceState } from '../capture/provenance.mjs';

/** The recipe that owns a state, which is what a failure names first. */
export function recipeFor(stateId, recipes = CAPTURE_RECIPES) {
  const found = recipes.find((entry) => (entry.recipe ?? entry).producer?.scenarioId === stateId);
  return found ? (found.recipe ?? found) : null;
}

/**
 * The verdict for one state, given its baseline and what the browser produced.
 *
 * Pure, so every outcome is unit-testable without a browser: a missing baseline, a clean
 * match, a field that moved, and a page error each have a case of their own.
 */
export function judgeState({ stateId, state, recipe, baseline, report }) {
  const pageErrors = report.pageErrors ?? [];
  // A state may DECLARE the error it exists to demonstrate; see `judgePageErrors`. Expected
  // errors fall through to the ordinary comparison, so the failure card's layout is still
  // diffed rather than the state being waved past on the strength of having thrown.
  const errorVerdict = judgePageErrors(state, pageErrors);
  if (!errorVerdict.ok) {
    return { stateId, status: 'page-error', pageErrors, errorVerdict, changes: [] };
  }
  if (baseline === null) {
    return { stateId, status: 'no-baseline', pageErrors, changes: [] };
  }
  const changes = diffMeasurements(baseline.measurements, report.measurements);
  return {
    stateId,
    status: changes.length === 0 ? 'match' : 'differs',
    pageErrors,
    changes,
    recipeId: recipe?.id ?? stateId,
    viewport: recipe?.viewport ?? null,
    profile: recipe?.profile ?? null,
  };
}

/** The process exit code for a whole run: zero only when every state matched. */
export function checkExitCode(verdicts) {
  if (verdicts.length === 0) return 1;
  return verdicts.every((v) => v.status === 'match') ? 0 : 1;
}

/**
 * What a failure leaves on disk for a person to read.
 *
 * `expected.json`, `actual.json` and `diff.txt` are the three #326 asks for, in the channel
 * #840 chose. `capture.png` sits beside them because a reader looking at a moved box wants to
 * see the screen -- it is evidence, not an expectation, and there is deliberately no
 * `expected.png` to compare it against.
 *
 * `source.json` carries the commit and dirty flag from `provenance.mjs`, the same block the
 * capture manifests record. `buildManifest` itself is not reused: it hard-codes
 * `status: 'success'` with no failure branch, so calling it here would stamp a failure as a
 * success rather than describe one.
 */
export async function writeFailureArtifacts(dir, { verdict, baseline, report, png, source }) {
  await mkdir(dir, { recursive: true });
  const expected = baseline === null ? { state: verdict.stateId, measurements: [] } : baseline;
  await writeFile(join(dir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  await writeFile(join(dir, 'actual.json'), `${JSON.stringify({ state: verdict.stateId, measurements: report.measurements }, null, 2)}\n`);
  await writeFile(join(dir, 'diff.txt'), `${formatVerdict(verdict)}\n`);
  await writeFile(join(dir, 'source.json'), `${JSON.stringify(source, null, 2)}\n`);
  if (png) await writeFile(join(dir, 'capture.png'), png);
}

/** One verdict as the text a reader sees, in the terminal and in `diff.txt`. */
export function formatVerdict(verdict) {
  if (verdict.status === 'match') return `PASS ${verdict.recipeId ?? verdict.stateId}`;
  if (verdict.status === 'page-error') {
    // A state that DECLARED its error gets the declaration's own wording, because the two
    // ways it breaks need different fixes: an unexpected error is a regression in the page,
    // a missing one means the state stopped reaching the failure it was written to show.
    // Only a DECLARATION failure gets the declaration's wording. An ordinary unexpected error
    // keeps this command's own sentence: `accept` refuses because there is no design to
    // approve, `check` fails because the screen cannot be trusted, and the 44 states that
    // declare nothing should not start reading like the other command.
    const declarationFailed = verdict.errorVerdict && verdict.errorVerdict.reason !== 'unexpected';
    const reason = declarationFailed
      ? pageErrorRefusalReason(verdict.errorVerdict)
      : 'the page raised an error, so the screen is not trustworthy';
    // The colon introduces the list below it, so it is only earned when there IS a list. The
    // `missing` refusal has none by definition -- the complaint is that nothing was raised.
    const lines = verdict.pageErrors.map((e) => `    ${e}`);
    return [`FAIL ${verdict.stateId}`, `  ${reason}${lines.length > 0 ? ':' : ''}`, ...lines].join('\n');
  }
  if (verdict.status === 'capture-failed') {
    return [`FAIL ${verdict.stateId}`, `  the capture itself failed: ${verdict.pageErrors[0]}`].join('\n');
  }
  if (verdict.status === 'no-baseline') {
    return [`FAIL ${verdict.stateId}`,
      '  no committed baseline. Run:',
      `    npm run screens:accept -- --state ${verdict.stateId}`,
      '  ...and read the diff before committing it.'].join('\n');
  }
  return formatFailure({
    recipeId: verdict.recipeId ?? verdict.stateId,
    stateId: verdict.stateId,
    viewport: verdict.viewport ?? { width: 0, height: 0, devicePixelRatio: 0 },
    profile: verdict.profile ?? { visual: '?', capability: '?', motion: '?' },
    changes: verdict.changes,
  });
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const dist = resolve(arg('dist', 'dist'));
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`no index.html under ${dist}`);
  const outDir = resolve(arg('out', 'screens-check-out'));
  const only = arg('state', null);
  const baselineDir = fileURLToPath(BASELINE_DIR);

  let states = subsetStates(SCREEN_STATES);
  if (only !== null) {
    states = states.filter((s) => s.id === only);
    if (states.length === 0) throw new Error(`--state '${only}' is not in the checked subset`);
  }

  const source = await inspectSourceState(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), null);
  const browser = await launchBrowser();
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const verdicts = [];
  const started = Date.now();
  try {
    for (const state of states) {
      const recipe = recipeFor(state.id);
      const viewport = recipe?.viewport ?? { width: 1280, height: 800, devicePixelRatio: 2 };
      let png = null; let report = null; let failure = null;
      try {
        const out = await captureState(browser, base, state, {
          width: viewport.width, height: viewport.height, dpr: viewport.devicePixelRatio, timeout: 20000,
        });
        png = out.png; report = out.report.producer;
      } catch (err) {
        failure = err instanceof Error ? err.message.split('\n')[0] : String(err);
      }
      if (failure !== null) {
        const verdict = { stateId: state.id, status: 'capture-failed', pageErrors: [failure], changes: [] };
        verdicts.push(verdict);
        console.log(formatVerdict(verdict));
        // EVIDENCE FOR THIS TOO. An earlier draft returned here before writing anything, so a
        // run where the captures timed out left 37 failures and an empty directory -- the one
        // failure mode where a reader has least to go on gave them nothing at all. There is no
        // capture to show, so the actual side records what went wrong instead.
        await writeFailureArtifacts(join(outDir, state.id), {
          verdict, baseline: readBaseline(baselineDir, state.id), report: { measurements: [] }, png: null, source,
        });
        continue;
      }
      const verdict = judgeState({ stateId: state.id, state, recipe, baseline: readBaseline(baselineDir, state.id), report });
      verdicts.push(verdict);
      console.log(formatVerdict(verdict));
      if (verdict.status !== 'match') {
        await writeFailureArtifacts(join(outDir, state.id), {
          verdict, baseline: readBaseline(baselineDir, state.id), report, png, source,
        });
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  const failed = verdicts.filter((v) => v.status !== 'match');
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${verdicts.length} state(s) checked in ${seconds}s, ${failed.length} failing`);
  if (failed.length > 0) console.log(`evidence written under ${outDir}`);
  process.exitCode = checkExitCode(verdicts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
