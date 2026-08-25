#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CAPTURE_USAGE, parseCaptureArgs } from './args.mjs';
import { CaptureCancelledError, findCancellation } from './cancellation.mjs';
import { forceTerminateActiveProcesses } from './process.mjs';
import { CAPTURE_RECIPES, findRecipe } from './registry.mjs';
import { captureRecipe } from './runner.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function listRecipes(entries, log) {
  log('Capture recipes:');
  for (const { recipe, hash } of entries) {
    const kind = recipe.schedule.kind === 'still' ? 'still' : `${recipe.playback.intendedFps} fps clip`;
    log(`  ${recipe.id.padEnd(36)} ${kind.padEnd(12)} ${recipe.title}`);
    log(`    producer=${recipe.producer.kind}:${recipe.producer.scenarioId} v${recipe.recipeVersion} sha256=${hash.slice(0, 12)}…`);
  }
}

/** Run the command with injectable registry/capture seams used by end-to-end lifecycle tests. */
export async function runCaptureCli(configuration = {}) {
  const {
    argv = process.argv.slice(2),
    root = ROOT,
    env = process.env,
    entries = CAPTURE_RECIPES,
    lookupRecipe = findRecipe,
    capture = captureRecipe,
    captureDeps = {},
    log = console.log,
    error = console.error,
    processObject = process,
  } = configuration;
  const controller = new AbortController();
  let firstSignal = null;
  let hardExitTimer = null;

  const handleSignal = (signalName) => {
    if (firstSignal === null) {
      firstSignal = signalName;
      error(`capture received ${signalName}; cancelling and cleaning up`);
      controller.abort(new CaptureCancelledError(signalName));
      return;
    }
    error(`capture received ${signalName} again; forcing subprocess termination`);
    forceTerminateActiveProcesses();
    if (hardExitTimer === null) {
      hardExitTimer = setTimeout(() => processObject.exit(128 + (signalName === 'SIGINT' ? 2 : 15)), 2_000);
    }
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  processObject.on('SIGINT', onSigint);
  processObject.on('SIGTERM', onSigterm);

  try {
    let options;
    try {
      options = parseCaptureArgs(argv);
    } catch (parseError) {
      error(parseError.message);
      error('');
      error(CAPTURE_USAGE);
      return 2;
    }
    if (options.help) {
      log(CAPTURE_USAGE);
      return 0;
    }
    if (options.list) {
      listRecipes(entries, log);
      return 0;
    }

    const entry = lookupRecipe(options.recipe);
    if (!entry) {
      throw new Error(`unknown capture recipe '${options.recipe}'; run npm run capture -- --list`);
    }
    const out = options.out ?? `artifacts/capture/${entry.recipe.id}`;
    const result = await capture(entry, {
      root,
      out,
      retainFrames: options.retainFrames,
      sourceRef: options.sourceRef,
      env,
      signal: controller.signal,
    }, captureDeps);
    log(`capture succeeded: ${result.output.relative}`);
    for (const artifact of result.manifest.outputs.files) {
      log(
        `  ${artifact.filename}: ${artifact.width}x${artifact.height}, ${artifact.frameCount} frame(s), ${artifact.byteSize} bytes, sha256 ${artifact.sha256}`,
      );
    }
    log('  capture.json');
    return firstSignal === null ? 0 : new CaptureCancelledError(firstSignal).exitCode;
  } catch (caught) {
    const cancelled = findCancellation(caught)
      ?? (firstSignal === null ? null : new CaptureCancelledError(firstSignal));
    if (cancelled) {
      error(`${cancelled.message}; cleanup complete`);
      return cancelled.exitCode;
    }
    error(`capture failed: ${caught.message ?? caught}`);
    return 1;
  } finally {
    processObject.removeListener('SIGINT', onSigint);
    processObject.removeListener('SIGTERM', onSigterm);
    if (hardExitTimer !== null) clearTimeout(hardExitTimer);
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) process.exitCode = await runCaptureCli();
