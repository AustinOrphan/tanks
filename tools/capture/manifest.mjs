import { MANIFEST_SCHEMA_VERSION } from './schema.mjs';

function resolvedSchedule(recipe, producerResult) {
  if (recipe.schedule.kind === 'still') {
    return {
      kind: 'still',
      tick: recipe.schedule.tick,
      alpha: recipe.schedule.alpha,
      frameCount: 1,
    };
  }
  const endTickExclusive = recipe.schedule.endTick === 'scenario'
    ? producerResult.report.producer.tickCount
    : recipe.schedule.endTick;
  return {
    kind: 'ticks',
    startTick: recipe.schedule.startTick,
    endTickExclusive,
    step: recipe.schedule.step,
    subdivisions: recipe.schedule.subdivisions,
    tickRate: recipe.schedule.tickRate,
    frameCount: producerResult.rawFrames.length,
  };
}

function playback(recipe, artifacts, schedule) {
  if (recipe.schedule.kind === 'still') {
    return {
      rate: recipe.playback.rate,
      intendedFps: null,
      intendedDurationSeconds: null,
      sourceOfTruth: 'capture.png',
      effective: null,
    };
  }
  const mp4 = artifacts.find((artifact) => artifact.format === 'mp4');
  const gif = artifacts.find((artifact) => artifact.format === 'gif');
  const framesPerTick = recipe.schedule.subdivisions / recipe.schedule.step;
  const baseFrameRate = recipe.schedule.tickRate * framesPerTick;
  return {
    rate: recipe.playback.rate,
    intendedFps: recipe.playback.intendedFps,
    intendedDurationSeconds: schedule.frameCount / recipe.playback.intendedFps,
    sourceOfTruth: mp4.filename,
    effective: {
      mp4: {
        averageFrameRate: mp4.averageFrameRate,
        durationSeconds: mp4.durationSeconds,
        playbackRate: mp4.averageFrameRate === null
          ? null
          : mp4.averageFrameRate / baseFrameRate,
      },
      gif: {
        displayedAverageFrameRate: gif.durationSeconds
          ? gif.frameCount / gif.durationSeconds
          : gif.averageFrameRate,
        durationSeconds: gif.durationSeconds,
        displayedPlaybackRate: gif.durationSeconds
          ? (gif.frameCount / gif.durationSeconds) / baseFrameRate
          : null,
        timingNote: 'GIF delays are quantized by the format; this preview is not exact 60 fps evidence.',
      },
    },
  };
}

export function buildManifest(input) {
  const {
    entry,
    source,
    producerResult,
    prerequisites,
    assertions,
    artifacts,
    rawFrames,
    startedAt,
    completedAt,
  } = input;
  const { recipe } = entry;
  const schedule = resolvedSchedule(recipe, producerResult);
  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0)
    + (rawFrames?.byteSize ?? 0);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    status: 'success',
    recipe: {
      id: recipe.id,
      version: recipe.recipeVersion,
      contentHash: entry.hash,
      title: recipe.title,
      description: recipe.description,
      altText: recipe.altText,
    },
    source: {
      requestedRef: source.requestedRef,
      commitSha: source.commitSha,
      dirty: source.dirty,
    },
    producer: {
      kind: recipe.producer.kind,
      scenarioId: recipe.producer.scenarioId,
      fixture: {
        id: recipe.fixture.id,
        seed: producerResult.report.producer.fixture.seed,
      },
      variant: recipe.variant,
      observedEvents: producerResult.report.producer.observedEvents,
      fixtureAssertions: producerResult.report.producer.fixtureAssertions,
    },
    capture: {
      viewport: recipe.viewport,
      profile: recipe.profile,
      schedule,
    },
    playback: playback(recipe, artifacts, schedule),
    assertions,
    tools: {
      node: process.version,
      playwright: prerequisites.playwright.version,
      chromium: producerResult.chromiumVersion,
      ffmpeg: prerequisites.ffmpeg,
      ffprobe: prerequisites.ffprobe,
    },
    outputs: {
      files: artifacts,
      rawFrames: rawFrames ?? {
        retained: false,
        directory: null,
        pattern: null,
        frameCount: producerResult.rawFrames.length,
        byteSize: null,
        sha256: null,
      },
      totalByteSize: totalBytes,
      budgetBytes: recipe.outputBudgetBytes,
      withinBudget: totalBytes <= recipe.outputBudgetBytes,
    },
    determinism: {
      scenarioInputs: 'fixed by recipe, source, and producer fixture',
      scheduleAndDimensions: 'fixed by recipe and recorded effective values',
      rawFrameEquality: 'may be compared only within a pinned supported environment',
      encodedByteEqualityAcrossEnvironments: false,
    },
    timing: { startedAt, completedAt },
    diagnostics: [],
  };
}
