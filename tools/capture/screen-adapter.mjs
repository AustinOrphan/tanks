/**
 * The `screen` capture producer (issue #561).
 *
 * `PRODUCER_KINDS` has listed `'screen'` since the framework was written, and
 * `producerForKind` carried a dedicated "recognized but not implemented" error for it.
 * This is that seam filled in, deliberately as a SIBLING of the gallery adapter rather
 * than a fifth standalone capture tool: it shells out to a CLI that writes one frame and
 * one report, then validates the report back. Everything else -- the recipe registry, the
 * hashing, the manifest, the provenance, the prerequisites check -- is inherited rather
 * than rebuilt, which is the whole reason for putting it here.
 *
 * A screen recipe names a state in `tools/screens/states.mjs` through
 * `producer.scenarioId` and carries an EMPTY variant. The state owns its seeded storage,
 * its capability override and the steps that reach it, because those are properties of
 * the screen and not of one capture of it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRODUCER_RESULT_SCHEMA_VERSION } from './producer.mjs';
import { runProcess } from './process.mjs';
// The catalogue, to check a recipe's capability against the state it names. Reading it is
// enough; the runner is still spawned as a child process, so nothing about the execution
// boundary changes.
import { findScreenState } from '../screens/states.mjs';

/**
 * Screens are DOM, not simulation, so most of the moment profile's vocabulary does not
 * apply. Refused rather than ignored: a recipe asking for something this producer cannot
 * honour must fail loudly instead of quietly capturing something else.
 */
function assertScreenProfile(recipe) {
  const { profile } = recipe;
  // Two capabilities, and everything else still refused by name (issue #844). The refusal is
  // the load-bearing half: a capability this producer cannot honour must fail loudly rather
  // than quietly capturing a desktop frame, because a desktop frame looks like a perfectly
  // good screenshot of whatever was asked for.
  if (profile.capability !== 'headless-desktop' && profile.capability !== 'headless-touch') {
    throw new Error(`screen producer does not support capability profile '${profile.capability}'`);
  }
  // The touchscreen lives on the STATE, because the layout sweep reads the catalogue and
  // never sees a recipe. So the two can disagree, and a disagreement is silent in exactly
  // the way that matters: a `headless-touch` recipe naming a non-touch state captures the
  // desktop pane and files it as touch evidence. Refuse both directions.
  const state = findScreenState(recipe.producer.scenarioId);
  if (state !== null) {
    const wantsTouch = profile.capability === 'headless-touch';
    if (wantsTouch !== (state.touch === true)) {
      throw new Error(
        `capability '${profile.capability}' disagrees with state '${state.id}' (touch: ${state.touch === true})`,
      );
    }
  }
  if (recipe.schedule.kind !== 'still') {
    throw new Error('screen captures are stills; a moving application surface is the flow producer (issue #815)');
  }
  // `reducedMotion` is not a knob here and saying so is the honest form. The runner always
  // emulates reduced motion, because a crossfade caught mid-flight is the difference
  // between a capture that reproduces and one that does not.
  //
  // Measured rather than assumed, when issue #843 asked whether a full-motion variant could
  // land: `screen.launch` measures `.hud-splash-hint`, which runs `hud-splash-pulse 2s
  // ease-in-out infinite` between opacity 0.55 and 1 and has NO rest state to settle to --
  // `.hud--reduced-motion .hud-splash-hint` is the only rule that gives it one. `WATCHED` in
  // the runner records `opacity`. So a full-motion still of that state, 1 of the 44
  // `screen.*` states and the only one measuring that element, could not reproduce: by
  // construction, not by bad luck.
  //
  // Scoped to THIS producer. Full motion is captured elsewhere in the framework -- the flow
  // producer sets `reducedMotion: 'no-preference'` and records video, where there is no
  // settle point to converge on.
  if (!profile.reducedMotion) {
    throw new Error('screen captures are taken under reduced motion; set profile.reducedMotion');
  }
}

export function buildScreenArguments(recipe, outputRelative) {
  if (recipe.producer.kind !== 'screen') {
    throw new Error(`screen adapter cannot capture producer '${recipe.producer.kind}'`);
  }
  assertScreenProfile(recipe);
  // Same containment rule the gallery adapter applies to its output path, and for the same
  // reason: this string reaches a child process's argv.
  if (!/^tmp\/[A-Za-z0-9._/-]+$/.test(outputRelative) || outputRelative.includes('..')) {
    throw new Error('screen adapter output must be an isolated relative tmp/ path');
  }
  // `outputRelative` is the producer DIRECTORY, not a file (see `runner.mjs`), and the
  // runner is spawned with cwd at the repository root -- so both artifacts are named
  // inside it explicitly. `frame.png` is the name `validateRawFrames` and the shared
  // pipeline expect; `producer.json` is the report this adapter reads back.
  return [
    '--state', recipe.producer.scenarioId,
    '--dist', 'dist',
    '--out', `${outputRelative}/frame.png`,
    '--report', `${outputRelative}/producer.json`,
    '--w', String(recipe.viewport.width),
    '--h', String(recipe.viewport.height),
    '--dpr', String(recipe.viewport.devicePixelRatio),
    '--timeout', String(recipe.timeoutMs),
  ];
}

/**
 * A page error is an ASSERTION, not a note.
 *
 * Every state here is meant to be a screen a player can sit on, including the branded
 * failure ones -- those report a failure, they do not suffer one. An uncaught exception
 * means the capture photographed a page that was still falling over, and the framework's
 * assertion channel is what turns that into a failed capture instead of a saved picture of
 * a broken screen.
 */
export function pageErrorAssertion(pageErrors, entry) {
  // ONE EXEMPTION, and it is declared rather than inferred (issue #781). A state with
  // `entry: 'unparseable'` photographs the card the page draws when the entry bundle cannot
  // parse -- so the uncaught error is the SUBJECT of the capture, not a symptom of a broken
  // one. Everything else keeps the rule exactly: an uncaught error means the picture is of a
  // page that was still falling over.
  //
  // Keyed on the entry mode rather than a free-form "expect errors" flag, so the exemption
  // cannot spread: it is available only to the one state kind whose whole point is the error,
  // and a state that started failing for an unrelated reason would still fail this.
  const expected = entry === 'unparseable';
  const passed = expected ? true : pageErrors.length === 0;
  let diagnostic;
  if (pageErrors.length === 0) diagnostic = 'no uncaught page errors';
  else if (expected) diagnostic = `expected page error(s) for an unparseable entry: ${pageErrors.join(' | ')}`;
  else diagnostic = `uncaught page error(s): ${pageErrors.join(' | ')}`;
  return { kind: 'page-errors', passed, diagnostic, details: { errors: pageErrors, expected } };
}

/**
 * Every element the state names must have been FOUND.
 *
 * Not "must be visible": several states exist precisely to show that a control is absent --
 * a fresh save hides Continue, the no-script card is hidden by the `<noscript>` style. A
 * measurement that reports `present: false` is a different thing: the selector no longer
 * matches anything, so the state is measuring nothing and the picture is unlabelled.
 */
function measuredElementsAssertion(measurements) {
  const missing = measurements.filter((m) => !m.present).map((m) => m.selector);
  return {
    kind: 'measured-elements-present',
    passed: missing.length === 0,
    diagnostic: missing.length === 0
      ? `measured ${measurements.length} element(s)`
      : `selector(s) matched nothing: ${missing.join(', ')}`,
    details: { measured: measurements.length, missing },
  };
}

export async function runScreenState(context, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const args = buildScreenArguments(context.recipe, context.outputRelative);
  try {
    await run(process.execPath, [join(context.root, 'tools/screens/run.mjs'), ...args], {
      cwd: context.root,
      env: {
        ...process.env,
        ...context.env,
        PLAYWRIGHT_MODULE: context.prerequisites.playwright.moduleSpecifier,
      },
      timeoutMs: context.recipe.timeoutMs,
      signal: context.signal,
    });
  } catch (error) {
    throw new Error(`screen capture failed: ${error.message}`, { cause: error });
  }

  const reportFile = join(context.outputDirectory, 'producer.json');
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, 'utf8'));
  } catch (error) {
    throw new Error(`screen capture did not produce a readable producer report: ${error.message}`, {
      cause: error,
    });
  }
  if (report?.producer?.stateId !== context.recipe.producer.scenarioId) {
    throw new Error(
      `screen capture reported state '${report?.producer?.stateId}' for recipe `
        + `'${context.recipe.producer.scenarioId}'`,
    );
  }

  const measurements = report.producer.measurements ?? [];
  return {
    schemaVersion: PRODUCER_RESULT_SCHEMA_VERSION,
    producer: { kind: 'screen', scenarioId: context.recipe.producer.scenarioId },
    rawFrames: [join(context.outputDirectory, 'frame.png')],
    capture: {
      viewport: report.capture.viewport,
      frameSchedule: { kind: 'still', frameCount: 1 },
    },
    assertions: [
      pageErrorAssertion(report.producer.pageErrors ?? [], report.producer.entry),
      measuredElementsAssertion(measurements),
    ],
    metadata: {
      screen: {
        stateId: report.producer.stateId,
        title: report.producer.title,
        webgl: report.producer.webgl,
        javascript: report.producer.javascript,
        measurements,
      },
    },
    toolVersions: {},
    diagnostics: [],
  };
}
