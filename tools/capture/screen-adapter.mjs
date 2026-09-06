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

/**
 * Screens are DOM, not simulation, so most of the moment profile's vocabulary does not
 * apply. Refused rather than ignored: a recipe asking for something this producer cannot
 * honour must fail loudly instead of quietly capturing something else.
 */
function assertScreenProfile(recipe) {
  const { profile } = recipe;
  if (profile.capability !== 'headless-desktop') {
    throw new Error(`screen producer does not support capability profile '${profile.capability}'`);
  }
  if (recipe.schedule.kind !== 'still') {
    throw new Error('screen captures are stills; a moving application surface is issue #326');
  }
  // `reducedMotion` is not a knob here and saying so is the honest form. The runner always
  // emulates reduced motion, because a crossfade caught mid-flight is the difference
  // between a capture that reproduces and one that does not.
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
function pageErrorAssertion(pageErrors) {
  return {
    kind: 'page-errors',
    passed: pageErrors.length === 0,
    diagnostic: pageErrors.length === 0
      ? 'no uncaught page errors'
      : `uncaught page error(s): ${pageErrors.join(' | ')}`,
    details: { errors: pageErrors },
  };
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
      pageErrorAssertion(report.producer.pageErrors ?? []),
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
