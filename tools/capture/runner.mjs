import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { throwIfAborted } from './cancellation.mjs';
import { buildManifest } from './manifest.mjs';
import {
  describeArtifact,
  describeRawFrames,
  encodeGif,
  encodeMp4,
  validateArtifact,
} from './media.mjs';
import {
  createTemporaryWorkspace,
  relativeInside,
  resolveOutputPath,
} from './paths.mjs';
import { inspectPrerequisites } from './prerequisites.mjs';
import { validateProducerResult } from './producer.mjs';
import { producerForKind } from './producers.mjs';
import { inspectSourceState } from './provenance.mjs';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function stageRawFrames(rawFrames, workspace, signal) {
  const directory = join(workspace, 'frames');
  await mkdir(directory);
  const staged = [];
  for (let index = 0; index < rawFrames.length; index++) {
    throwIfAborted(signal);
    const target = join(directory, `frame-${String(index).padStart(4, '0')}.png`);
    await copyFile(rawFrames[index], target);
    staged.push(target);
  }
  return staged;
}

function constructionFor(format) {
  if (format === 'png') return { method: 'captured-frame-copy' };
  if (format === 'mp4') {
    return {
      method: 'ffmpeg',
      codecRequested: 'libx264',
      pixelFormatRequested: 'yuv420p',
      faststartRequested: true,
    };
  }
  return {
    method: 'ffmpeg',
    infiniteLoopRequested: true,
    delayPrecision: 'centiseconds',
    paletteMode: 'generated-per-capture',
  };
}

async function assembleRequestedArtifacts(recipe, frames, publishDirectory, options, deps) {
  const inputPattern = join(dirname(frames[0]), 'frame-%04d.png');
  const artifactFiles = [];
  for (const requested of recipe.artifacts) {
    throwIfAborted(options.signal);
    const target = join(publishDirectory, requested.filename);
    if (requested.format === 'png') {
      if (frames.length !== 1) throw new Error('PNG capture requires exactly one raw frame');
      await copyFile(frames[0], target);
    } else {
      const encoder = requested.format === 'mp4'
        ? (deps.encodeMp4 ?? encodeMp4)
        : (deps.encodeGif ?? encodeGif);
      await encoder({
        fps: recipe.playback.intendedFps,
        inputPattern,
        frameCount: frames.length,
        output: target,
        cwd: options.root,
        env: options.env,
        timeoutMs: recipe.timeoutMs,
        signal: options.signal,
      });
    }
    artifactFiles.push({
      format: requested.format,
      filename: requested.filename,
      path: target,
      construction: constructionFor(requested.format),
    });
  }
  return artifactFiles;
}

async function retainRawFrames(frames, publishDirectory, signal) {
  const directory = join(publishDirectory, 'frames');
  await mkdir(directory);
  const files = [];
  for (let index = 0; index < frames.length; index++) {
    throwIfAborted(signal);
    const target = join(directory, `frame-${String(index).padStart(4, '0')}.png`);
    await copyFile(frames[index], target);
    files.push(target);
  }
  const summary = await describeRawFrames(files);
  return {
    retained: true,
    directory: 'frames',
    pattern: 'frames/frame-%04d.png',
    ...summary,
  };
}

/** Cleanup may be requested more than once by overlapping cancellation paths. */
export function cleanupCaptureResources(state) {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanupPromise = (async () => {
    const errors = [];
    if (state.lock) {
      await state.lock.close().catch((error) => errors.push(error));
      state.lock = null;
    }
    if (state.lockPath) {
      await unlink(state.lockPath).catch((error) => {
        if (error.code !== 'ENOENT') errors.push(error);
      });
    }
    for (const path of [state.publishDirectory, state.workspace]) {
      if (!path) continue;
      await rm(path, { recursive: true, force: true }).catch((error) => errors.push(error));
    }
    state.publishDirectory = null;
    state.workspace = null;
    if (errors.length > 0) throw new AggregateError(errors, 'capture cleanup failed');
  })();
  return state.cleanupPromise;
}

export async function captureRecipe(entry, options, deps = {}) {
  const { recipe } = entry;
  const producer = deps.runProducer
    ?? producerForKind(recipe.producer.kind, deps.producerRegistry);
  const output = resolveOutputPath(options.root, options.out);
  if (await exists(output.absolute)) {
    throw new Error(`output directory already exists: ${output.relative}; choose a new --out path`);
  }
  throwIfAborted(options.signal);

  const inspectSource = deps.inspectSourceState ?? inspectSourceState;
  const inspectTools = deps.inspectPrerequisites ?? inspectPrerequisites;
  const source = await inspectSource(
    options.root,
    options.sourceRef ?? null,
    { signal: options.signal },
  );
  throwIfAborted(options.signal);
  const prerequisites = await inspectTools(
    options.env ?? process.env,
    { signal: options.signal },
  );
  throwIfAborted(options.signal);
  const startedAt = new Date().toISOString();

  await mkdir(dirname(output.absolute), { recursive: true });
  // Re-run the symlink-containment check after creating missing parents.
  resolveOutputPath(options.root, output.relative);
  const state = {
    lockPath: `${output.absolute}.capture.lock`,
    lock: null,
    workspace: null,
    publishDirectory: null,
    cleanupPromise: null,
  };
  try {
    state.lock = await open(state.lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`another capture is already targeting ${output.relative}`);
    }
    throw error;
  }

  let failure = null;
  try {
    throwIfAborted(options.signal);
    if (await exists(output.absolute)) {
      throw new Error(`output directory already exists: ${output.relative}; refusing to overwrite it`);
    }
    const createWorkspace = deps.createTemporaryWorkspace ?? createTemporaryWorkspace;
    state.workspace = await createWorkspace(options.root);
    const producerDirectory = join(state.workspace, 'producer');
    await mkdir(producerDirectory);
    state.publishDirectory = join(state.workspace, 'publish');
    await mkdir(state.publishDirectory);

    const rawResult = await producer({
      recipe,
      root: options.root,
      outputDirectory: producerDirectory,
      outputRelative: relativeInside(options.root, producerDirectory),
      prerequisites,
      env: options.env ?? process.env,
      signal: options.signal,
    }, deps);
    throwIfAborted(options.signal);
    const validateResult = deps.validateProducerResult ?? validateProducerResult;
    const producerResult = await validateResult(rawResult, { recipe, outputDirectory: producerDirectory });
    const frames = await stageRawFrames(producerResult.rawFrames, state.workspace, options.signal);

    const artifactFiles = await assembleRequestedArtifacts(
      recipe,
      frames,
      state.publishDirectory,
      {
        root: options.root,
        env: options.env ?? process.env,
        signal: options.signal,
      },
      deps,
    );

    const describe = deps.describeArtifact ?? describeArtifact;
    const validateMedia = deps.validateArtifact ?? validateArtifact;
    const artifacts = [];
    for (const artifact of artifactFiles) {
      throwIfAborted(options.signal);
      const description = await describe(
        artifact.path,
        artifact.format,
        { signal: options.signal },
      );
      const row = {
        filename: artifact.filename,
        ...description,
        format: artifact.format,
        construction: artifact.construction,
      };
      row.verification = validateMedia(recipe, row, frames.length);
      artifacts.push(row);
    }
    const rawFrames = options.retainFrames
      ? await retainRawFrames(frames, state.publishDirectory, options.signal)
      : null;
    const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0)
      + (rawFrames?.byteSize ?? 0);
    if (totalBytes > recipe.outputBudgetBytes) {
      throw new Error(
        `capture output is ${totalBytes} bytes, over recipe budget ${recipe.outputBudgetBytes} bytes`,
      );
    }

    const manifest = buildManifest({
      entry,
      source,
      producerResult,
      prerequisites,
      artifacts,
      rawFrames,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    const manifestTmp = join(state.publishDirectory, 'capture.json.partial');
    const manifestFile = join(state.publishDirectory, 'capture.json');
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(manifestTmp, manifestFile);

    throwIfAborted(options.signal);
    if (await exists(output.absolute)) {
      throw new Error(`output directory appeared during capture: ${output.relative}; refusing to overwrite it`);
    }
    await rename(state.publishDirectory, output.absolute);
    state.publishDirectory = null;
    return { output, manifest };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await cleanupCaptureResources(state);
    } catch (cleanupError) {
      if (failure) {
        failure.message = `${failure.message}; cleanup also failed: ${cleanupError.message}`;
        failure.cleanupError = cleanupError;
      } else throw cleanupError;
    }
  }
}
