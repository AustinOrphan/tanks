import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from './process.mjs';

export function adapterForKind(kind) {
  if (kind === 'moment') return runGalleryMoment;
  if (['screen', 'flow', 'replay'].includes(kind)) {
    throw new Error(`capture producer '${kind}' is recognized but not implemented; only 'moment' is available`);
  }
  throw new Error(`unknown capture producer '${kind}'`);
}

function assertMomentProfile(recipe) {
  const { profile } = recipe;
  if (profile.visual !== 'software-gl') {
    throw new Error(`moment producer does not support visual profile '${profile.visual}'`);
  }
  if (profile.motion !== 'full') {
    throw new Error(`moment producer does not support motion profile '${profile.motion}'`);
  }
  if (profile.capability !== 'headless-desktop') {
    throw new Error(`moment producer does not support capability profile '${profile.capability}'`);
  }
  if (profile.reducedMotion) {
    throw new Error('moment producer does not yet support reduced-motion emulation');
  }
}

export function buildGalleryArguments(recipe, outputRelative) {
  if (recipe.producer.kind !== 'moment') adapterForKind(recipe.producer.kind);
  assertMomentProfile(recipe);
  if (!/^tmp\/[A-Za-z0-9._/-]+$/.test(outputRelative) || outputRelative.includes('..')) {
    throw new Error('gallery adapter output must be an isolated relative tmp/ path');
  }
  const args = [
    '--scene', recipe.producer.scenarioId,
    '--view', recipe.variant.view,
    '--skin', recipe.variant.skin,
    '--spawn-anim', recipe.variant.spawnAnimation,
    '--w', String(recipe.viewport.width),
    '--h', String(recipe.viewport.height),
    '--dpr', String(recipe.viewport.devicePixelRatio),
    '--out', outputRelative,
    '--report', 'producer.json',
  ];
  if (recipe.variant.hull !== null) args.push('--hull', recipe.variant.hull);
  if (recipe.variant.accent !== null) args.push('--accent', recipe.variant.accent);

  if (recipe.schedule.kind === 'still') {
    if (recipe.schedule.alpha !== 0) {
      throw new Error('gallery moment stills currently require schedule.alpha = 0');
    }
    args.push('--age', String(recipe.schedule.tick));
  } else {
    if (
      recipe.schedule.startTick !== 0
      || recipe.schedule.endTick !== 'scenario'
      || recipe.schedule.step !== 1
    ) {
      throw new Error('gallery moment clips require startTick 0, endTick scenario, and step 1');
    }
    args.push(
      '--anim',
      '--subdiv', String(recipe.schedule.subdivisions),
      '--fps', String(recipe.playback.intendedFps),
    );
  }
  return args;
}

function validateReport(report, recipe, rawFrameCount) {
  if (report?.schemaVersion !== 1) throw new Error('gallery producer report has an unsupported schema');
  if (report.producer?.schemaVersion !== 1) throw new Error('moment producer report has an unsupported schema');
  if (report.producer.producer?.kind !== 'moment') throw new Error('gallery producer report is not a moment');
  if (report.producer.producer.scenarioId !== recipe.producer.scenarioId) {
    throw new Error(
      `gallery producer reported scenario '${report.producer.producer.scenarioId}', expected '${recipe.producer.scenarioId}'`,
    );
  }
  if (report.producer.fixture?.seed !== recipe.fixture.seed) {
    throw new Error(
      `gallery producer resolved seed ${report.producer.fixture?.seed}, expected ${recipe.fixture.seed}`,
    );
  }
  if (report.capture?.frameCount !== rawFrameCount) {
    throw new Error(
      `gallery producer reported ${report.capture?.frameCount} frames, found ${rawFrameCount}`,
    );
  }
  const expectedDpr = recipe.viewport.devicePixelRatio;
  if (report.capture.viewport?.devicePixelRatio !== expectedDpr) {
    throw new Error(
      `gallery producer used DPR ${report.capture.viewport?.devicePixelRatio}, expected ${expectedDpr}`,
    );
  }
  if ((report.capture.pageErrors ?? []).length > 0) {
    throw new Error(`gallery page raised ${report.capture.pageErrors.length} error(s)`);
  }
  const failedFixtureAssertions = (report.producer.fixtureAssertions ?? [])
    .filter((assertion) => !assertion.passed);
  if (failedFixtureAssertions.length > 0) {
    throw new Error(`gallery moment failed ${failedFixtureAssertions.length} fixture assertion(s)`);
  }
}

export async function runGalleryMoment(context, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const args = buildGalleryArguments(context.recipe, context.outputRelative);
  const command = process.execPath;
  const commandArgs = [join(context.root, 'tools/gallery/run.mjs'), ...args];
  const env = {
    ...process.env,
    ...context.env,
    PLAYWRIGHT_MODULE: context.prerequisites.playwright.moduleSpecifier,
  };
  try {
    await run(command, commandArgs, {
      cwd: context.root,
      env,
      timeoutMs: context.recipe.timeoutMs,
    });
  } catch (error) {
    throw new Error(`gallery moment capture failed: ${error.message}`, { cause: error });
  }

  const reportFile = join(context.outputDirectory, 'producer.json');
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, 'utf8'));
  } catch (error) {
    throw new Error(`gallery moment did not produce a readable producer report: ${error.message}`, {
      cause: error,
    });
  }

  const names = await readdir(context.outputDirectory);
  let rawFrames;
  let previewFile = null;
  if (context.recipe.schedule.kind === 'still') {
    rawFrames = names.includes('frame.png') ? [join(context.outputDirectory, 'frame.png')] : [];
    if (rawFrames.length !== 1) throw new Error('gallery moment still did not produce frame.png');
  } else {
    const frameNames = names.filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
    for (let index = 0; index < frameNames.length; index++) {
      const expected = `frame-${String(index).padStart(4, '0')}.png`;
      if (frameNames[index] !== expected) {
        throw new Error(`gallery moment frames are not contiguous: expected ${expected}`);
      }
    }
    rawFrames = frameNames.map((name) => join(context.outputDirectory, name));
    previewFile = join(context.outputDirectory, 'gallery.gif');
    if (!existsSync(previewFile)) throw new Error('gallery moment clip did not produce gallery.gif');
  }

  validateReport(report, context.recipe, rawFrames.length);
  return {
    rawFrames,
    previewFile,
    report,
    chromiumVersion: report.browser.chromiumVersion,
  };
}
