/**
 * `npm run showcase:check` (issue #1062): hold the showcase manifest, the tracked files under
 * `docs/media/showcase/` and the GIF references in README.md and docs/showcase.md to the
 * publication rules in `validate.mjs`. Gathers the inputs, prints every broken rule and the
 * population it checked, and exits non-zero on any failure. Needs git, but no FFmpeg, Playwright
 * or network. `tools/showcase/check.test.ts` runs it over the repository in `npm run test:unit`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRecipe } from '../capture/registry.mjs';
import { gifFacts } from './facts.mjs';
import {
  PLACEMENT_DOCUMENTS,
  SHOWCASE_DIR,
  showcasePopulation,
  validateShowcase,
} from './validate.mjs';

export const MANIFEST_PATH = 'tools/showcase/manifest.json';

/** The artifact formats the capture registry declares for a recipe, or null when it has none. */
function recipeArtifacts(id) {
  const entry = findRecipe(id);
  return entry === null ? null : entry.recipe.artifacts.map((artifact) => artifact.format);
}

function trackedFiles(root) {
  // `-z` because a path may contain anything; the separator is the one byte it may not.
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return listed.split('\0').filter((file) => file !== '');
}

function readText(root, file, io) {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    io.error(`${file}: ${error.message}`);
    return null;
  }
}

export function run(root = process.cwd(), io = console) {
  const manifestText = readText(root, MANIFEST_PATH, io);
  if (manifestText === null) return 1;
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    io.error(`${MANIFEST_PATH}: ${error.message}`);
    return 1;
  }
  const documents = {};
  for (const document of Object.values(PLACEMENT_DOCUMENTS)) {
    documents[document] = readText(root, document, io);
    if (documents[document] === null) return 1;
  }

  const tracked = trackedFiles(root);
  const trackedSet = new Set(tracked);
  // Only a tracked output is read, so a manifest path can never reach outside the checkout.
  const media = {};
  for (const clip of Array.isArray(manifest?.clips) ? manifest.clips : []) {
    const output = clip?.output;
    if (typeof output !== 'string' || !trackedSet.has(output) || Object.hasOwn(media, output)) continue;
    try {
      media[output] = gifFacts(readFileSync(path.join(root, output)));
    } catch (error) {
      media[output] = { error: error.message };
    }
  }

  const inputs = { manifest, recipeArtifacts, tracked, media, documents };
  const messages = validateShowcase(inputs);
  for (const message of messages) io.error(message);
  const population = showcasePopulation(inputs);
  const verdict = messages.length === 0 ? 'passed' : `${messages.length} problem(s)`;
  io.log(
    `showcase:check ${verdict} over ${population.clips} clip(s), ${population.trackedFiles} `
      + `tracked file(s) under ${SHOWCASE_DIR} and ${population.bytes} byte(s).`,
  );
  return messages.length === 0 ? 0 : 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = run();
