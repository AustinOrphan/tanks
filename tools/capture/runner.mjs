import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { evaluateExpectations } from './assertions.mjs';
import { adapterForKind } from './gallery-adapter.mjs';
import { buildManifest } from './manifest.mjs';
import { describeArtifact, describeRawFrames, encodeMp4 } from './media.mjs';
import { relativeInside, resolveOutputPath } from './paths.mjs';
import { inspectPrerequisites } from './prerequisites.mjs';
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

function validateCapturedSchedule(recipe, producerResult) {
  const tickCount = producerResult.report.producer.tickCount;
  if (!Number.isInteger(tickCount) || tickCount < 1) {
    throw new Error(`moment producer reported invalid tick count ${tickCount}`);
  }
  if (recipe.schedule.kind === 'still') {
    if (recipe.schedule.tick >= tickCount) {
      throw new Error(`still tick ${recipe.schedule.tick} is outside the ${tickCount}-tick moment`);
    }
    if (producerResult.rawFrames.length !== 1) throw new Error('still producer must return one raw frame');
    return;
  }
  const expectedFrames = Math.ceil((tickCount - recipe.schedule.startTick) / recipe.schedule.step)
    * recipe.schedule.subdivisions;
  if (producerResult.rawFrames.length !== expectedFrames) {
    throw new Error(
      `fixed schedule resolves to ${expectedFrames} frames, producer returned ${producerResult.rawFrames.length}`,
    );
  }
}

function validateArtifact(recipe, artifact, expectedFrameCount) {
  const expectedWidth = Math.round(recipe.viewport.width * recipe.viewport.devicePixelRatio);
  const expectedHeight = Math.round(recipe.viewport.height * recipe.viewport.devicePixelRatio);
  if (artifact.width !== expectedWidth || artifact.height !== expectedHeight) {
    throw new Error(
      `${artifact.filename} is ${artifact.width}x${artifact.height}; expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  if (artifact.frameCount !== expectedFrameCount) {
    throw new Error(
      `${artifact.filename} has ${artifact.frameCount} frames; expected ${expectedFrameCount}`,
    );
  }
  if (artifact.format === 'png' && artifact.codec !== 'png') {
    throw new Error(`${artifact.filename} codec is ${artifact.codec}; expected png`);
  }
  if (artifact.format === 'mp4') {
    if (artifact.codec !== 'h264') throw new Error(`${artifact.filename} codec is ${artifact.codec}; expected h264`);
    if (artifact.pixelFormat !== 'yuv420p') {
      throw new Error(`${artifact.filename} pixel format is ${artifact.pixelFormat}; expected yuv420p`);
    }
    if (!(artifact.durationSeconds > 0)) throw new Error(`${artifact.filename} has no positive duration`);
  }
  if (artifact.format === 'gif') {
    if (artifact.codec !== 'gif') throw new Error(`${artifact.filename} codec is ${artifact.codec}; expected gif`);
    if (artifact.looping !== true) throw new Error(`${artifact.filename} is not configured to loop`);
    if (!(artifact.durationSeconds > 0)) throw new Error(`${artifact.filename} has no positive duration`);
  }
}

async function retainRawFrames(producerResult, publishDirectory) {
  const directory = join(publishDirectory, 'frames');
  await mkdir(directory);
  const files = [];
  for (let index = 0; index < producerResult.rawFrames.length; index++) {
    const target = join(directory, `frame-${String(index).padStart(4, '0')}.png`);
    await copyFile(producerResult.rawFrames[index], target);
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

export async function captureRecipe(entry, options, deps = {}) {
  const { recipe } = entry;
  const producer = deps.runProducer ?? adapterForKind(recipe.producer.kind);
  const output = resolveOutputPath(options.root, options.out);
  if (await exists(output.absolute)) {
    throw new Error(`output directory already exists: ${output.relative}; choose a new --out path`);
  }

  const inspectSource = deps.inspectSourceState ?? inspectSourceState;
  const inspectTools = deps.inspectPrerequisites ?? inspectPrerequisites;
  const source = await inspectSource(options.root, options.sourceRef ?? null);
  const prerequisites = await inspectTools(options.env ?? process.env);
  const startedAt = new Date().toISOString();

  await mkdir(dirname(output.absolute), { recursive: true });
  // Re-run the symlink-containment check after creating missing parents.
  resolveOutputPath(options.root, output.relative);
  const lockPath = `${output.absolute}.capture.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`another capture is already targeting ${output.relative}`);
    }
    throw error;
  }

  let workspace = null;
  let publishDirectory = null;
  try {
    if (await exists(output.absolute)) {
      throw new Error(`output directory already exists: ${output.relative}; refusing to overwrite it`);
    }
    const tempParent = join(options.root, 'tmp');
    await mkdir(tempParent, { recursive: true });
    workspace = await mkdtemp(join(tempParent, 'capture-'));
    const producerDirectory = join(workspace, 'gallery');
    await mkdir(producerDirectory);
    publishDirectory = join(workspace, 'publish');
    await mkdir(publishDirectory);

    const producerResult = await producer({
      recipe,
      root: options.root,
      outputDirectory: producerDirectory,
      outputRelative: relativeInside(options.root, producerDirectory),
      prerequisites,
      env: options.env ?? process.env,
    }, deps);
    validateCapturedSchedule(recipe, producerResult);
    const assertions = evaluateExpectations(recipe, producerResult.report.producer);

    const artifactFiles = [];
    if (recipe.schedule.kind === 'still') {
      const target = join(publishDirectory, 'capture.png');
      await copyFile(producerResult.rawFrames[0], target);
      artifactFiles.push({ format: 'png', filename: 'capture.png', path: target });
    } else {
      const mp4 = join(publishDirectory, 'capture.mp4');
      const encode = deps.encodeMp4 ?? encodeMp4;
      await encode({
        fps: recipe.playback.intendedFps,
        inputPattern: join(producerDirectory, 'frame-%04d.png'),
        frameCount: producerResult.rawFrames.length,
        output: mp4,
        cwd: options.root,
        env: options.env ?? process.env,
        timeoutMs: recipe.timeoutMs,
      });
      const gif = join(publishDirectory, 'preview.gif');
      await copyFile(producerResult.previewFile, gif);
      artifactFiles.push(
        { format: 'mp4', filename: 'capture.mp4', path: mp4 },
        { format: 'gif', filename: 'preview.gif', path: gif },
      );
    }

    const describe = deps.describeArtifact ?? describeArtifact;
    const artifacts = [];
    for (const artifact of artifactFiles) {
      const description = await describe(artifact.path, artifact.format);
      const row = { filename: artifact.filename, ...description, format: artifact.format };
      validateArtifact(recipe, row, producerResult.rawFrames.length);
      artifacts.push(row);
    }
    const rawFrames = options.retainFrames
      ? await retainRawFrames(producerResult, publishDirectory)
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
      assertions,
      artifacts,
      rawFrames,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    const manifestTmp = join(publishDirectory, 'capture.json.partial');
    const manifestFile = join(publishDirectory, 'capture.json');
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(manifestTmp, manifestFile);

    if (await exists(output.absolute)) {
      throw new Error(`output directory appeared during capture: ${output.relative}; refusing to overwrite it`);
    }
    await rename(publishDirectory, output.absolute);
    publishDirectory = null;
    return { output, manifest };
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (publishDirectory) await rm(publishDirectory, { recursive: true, force: true });
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
