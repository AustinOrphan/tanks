#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { CAPTURE_USAGE, parseCaptureArgs } from './args.mjs';
import { CAPTURE_RECIPES, findRecipe } from './registry.mjs';
import { captureRecipe } from './runner.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function listRecipes() {
  console.log('Capture recipes:');
  for (const { recipe, hash } of CAPTURE_RECIPES) {
    const kind = recipe.schedule.kind === 'still' ? 'still' : `${recipe.playback.intendedFps} fps clip`;
    console.log(`  ${recipe.id.padEnd(36)} ${kind.padEnd(12)} ${recipe.title}`);
    console.log(`    producer=${recipe.producer.kind}:${recipe.producer.scenarioId} v${recipe.recipeVersion} sha256=${hash.slice(0, 12)}…`);
  }
}

async function main() {
  let options;
  try {
    options = parseCaptureArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(CAPTURE_USAGE);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(CAPTURE_USAGE);
    return;
  }
  if (options.list) {
    listRecipes();
    return;
  }

  const entry = findRecipe(options.recipe);
  if (!entry) {
    throw new Error(`unknown capture recipe '${options.recipe}'; run npm run capture -- --list`);
  }
  const out = options.out ?? `artifacts/capture/${entry.recipe.id}`;
  const result = await captureRecipe(entry, {
    root: ROOT,
    out,
    retainFrames: options.retainFrames,
    sourceRef: options.sourceRef,
    env: process.env,
  });
  console.log(`capture succeeded: ${result.output.relative}`);
  for (const artifact of result.manifest.outputs.files) {
    console.log(
      `  ${artifact.filename}: ${artifact.width}x${artifact.height}, ${artifact.frameCount} frame(s), ${artifact.byteSize} bytes, sha256 ${artifact.sha256}`,
    );
  }
  console.log('  capture.json');
}

main().catch((error) => {
  console.error(`capture failed: ${error.message ?? error}`);
  process.exitCode = 1;
});
