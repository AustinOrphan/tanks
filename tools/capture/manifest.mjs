import { MANIFEST_SCHEMA_VERSION } from './schema.mjs';

function playback(recipe, artifacts, frameSchedule) {
  if (frameSchedule.kind === 'still') {
    const still = artifacts.find((artifact) => artifact.format === 'png') ?? artifacts[0];
    return {
      rate: recipe.playback.rate,
      intendedFps: null,
      intendedDurationSeconds: null,
      sourceOfTruth: still.filename,
      effective: null,
    };
  }

  const intendedFps = recipe.playback.intendedFps;
  const intendedDurationSeconds = frameSchedule.frameCount / intendedFps;
  const mp4 = artifacts.find((artifact) => artifact.format === 'mp4') ?? null;
  const gif = artifacts.find((artifact) => artifact.format === 'gif') ?? null;
  const effective = {};
  if (mp4) {
    effective.mp4 = {
      averageFrameRate: mp4.averageFrameRate,
      durationSeconds: mp4.durationSeconds,
      playbackRate: mp4.averageFrameRate === null
        ? null
        : recipe.playback.rate * (mp4.averageFrameRate / intendedFps),
      faststart: mp4.container?.faststart ?? null,
    };
  }
  if (gif) {
    const displayedDurationSeconds = gif.container?.displayedDurationSeconds ?? null;
    const displayedAverageFrameRate = displayedDurationSeconds
      ? gif.container.frameCount / displayedDurationSeconds
      : null;
    effective.gif = {
      displayedAverageFrameRate,
      durationSeconds: displayedDurationSeconds,
      displayedPlaybackRate: displayedAverageFrameRate === null
        ? null
        : recipe.playback.rate * (displayedAverageFrameRate / intendedFps),
      loopCount: gif.container?.loopCount ?? null,
      looping: gif.container?.looping ?? null,
      timingNote: 'GIF delays are measured in centiseconds; this preview is not exact 60 fps evidence.',
    };
  }
  return {
    rate: recipe.playback.rate,
    intendedFps,
    intendedDurationSeconds,
    sourceOfTruth: mp4?.filename ?? artifacts[0].filename,
    effective,
  };
}

export function buildManifest(input) {
  const {
    entry,
    source,
    producerResult,
    prerequisites,
    artifacts,
    rawFrames,
    startedAt,
    completedAt,
  } = input;
  const { recipe } = entry;
  const frameSchedule = producerResult.capture.frameSchedule;
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
      requestedInputs: {
        fixture: recipe.fixture,
        variant: recipe.variant,
      },
      metadata: producerResult.metadata,
    },
    capture: {
      viewport: producerResult.capture.viewport,
      profile: recipe.profile,
      requestedSchedule: recipe.schedule,
      frameSchedule,
    },
    playback: playback(recipe, artifacts, frameSchedule),
    assertions: producerResult.assertions,
    tools: {
      node: process.version,
      playwright: prerequisites.playwright?.version ?? null,
      producer: producerResult.toolVersions,
      ffmpeg: prerequisites.ffmpeg,
      ffprobe: prerequisites.ffprobe,
    },
    outputs: {
      files: artifacts,
      rawFrames: rawFrames ?? {
        retained: false,
        directory: null,
        pattern: null,
        frameCount: frameSchedule.frameCount,
        byteSize: null,
        sha256: null,
      },
      totalByteSize: totalBytes,
      budgetBytes: recipe.outputBudgetBytes,
      withinBudget: totalBytes <= recipe.outputBudgetBytes,
    },
    determinism: {
      scenarioInputs: 'fixed by the recipe and recorded producer inputs/metadata',
      scheduleAndDimensions: 'fixed by the recipe and recorded effective frame schedule/viewport',
      rawFrameEquality: 'may be compared only within a pinned supported environment',
      encodedByteEqualityAcrossEnvironments: false,
    },
    timing: { startedAt, completedAt },
    diagnostics: producerResult.diagnostics,
  };
}
