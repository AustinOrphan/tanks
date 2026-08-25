import { createHash } from 'node:crypto';
import {
  GALLERY_VIEW_IDS,
  MOMENT_IDS,
  SKIN_IDS,
  SPAWN_ANIM_IDS,
} from '../gallery/args.mjs';

export const RECIPE_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;
export const PRODUCER_KINDS = Object.freeze(['moment', 'screen', 'flow', 'replay']);

const STABLE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const EVENT_ID = /^[a-z][a-z0-9-]*$/;
const HEX = /^#[0-9a-f]{6}$/i;
const ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const FORMAT_EXTENSIONS = Object.freeze({ png: '.png', mp4: '.mp4', gif: '.gif' });

function fail(path, message) {
  throw new Error(`invalid capture recipe at ${path}: ${message}`);
}

function objectAt(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(path, 'must be a plain object');
  return value;
}

function exactKeys(value, path, required, optional = []) {
  const object = objectAt(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not an allowed field');
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail(`${path}.${key}`, 'is required');
  }
  return object;
}

function integerAt(value, path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(path, `must be a whole number in [${min}, ${max}]`);
  }
  return value;
}

function numberAt(value, path, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(path, `must be a finite number in [${min}, ${max}]`);
  }
  return value;
}

function stringAt(value, path, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(path, `must be a string ${min}-${max} characters long`);
  }
  if (/\p{Cc}/u.test(value)) fail(path, 'must not contain control characters');
  return value;
}

function stableIdAt(value, path) {
  stringAt(value, path, { max: 120 });
  if (!STABLE_ID.test(value)) {
    fail(path, 'must be a lowercase stable ID using only letters, digits, dots, and hyphens');
  }
  return value;
}

function validateProducer(recipe) {
  const producer = exactKeys(recipe.producer, 'producer', ['kind', 'scenarioId']);
  if (!PRODUCER_KINDS.includes(producer.kind)) {
    fail('producer.kind', `must be one of ${PRODUCER_KINDS.join(', ')}`);
  }
  stableIdAt(producer.scenarioId, 'producer.scenarioId');
  if (producer.kind === 'moment' && !MOMENT_IDS.includes(producer.scenarioId)) {
    fail('producer.scenarioId', `is not an existing gallery moment (${MOMENT_IDS.join(', ')})`);
  }
}

function validateFixture(recipe) {
  const fixture = exactKeys(recipe.fixture, 'fixture', ['id', 'seed']);
  stableIdAt(fixture.id, 'fixture.id');
  integerAt(fixture.seed, 'fixture.seed', { min: 0, max: 0xffff_ffff });
}

function validateVariant(recipe) {
  if (recipe.producer.kind !== 'moment') {
    exactKeys(recipe.variant, 'variant', []);
    return;
  }
  const variant = exactKeys(
    recipe.variant,
    'variant',
    ['view', 'skin', 'hull', 'accent', 'spawnAnimation'],
  );
  if (!GALLERY_VIEW_IDS.includes(variant.view)) {
    fail('variant.view', `must be one of ${GALLERY_VIEW_IDS.join(', ')}`);
  }
  if (!SKIN_IDS.includes(variant.skin)) {
    fail('variant.skin', `must be one of ${SKIN_IDS.join(', ')}`);
  }
  if (!SPAWN_ANIM_IDS.includes(variant.spawnAnimation)) {
    fail('variant.spawnAnimation', `must be one of ${SPAWN_ANIM_IDS.join(', ')}`);
  }
  for (const key of ['hull', 'accent']) {
    if (variant[key] !== null && (typeof variant[key] !== 'string' || !HEX.test(variant[key]))) {
      fail(`variant.${key}`, 'must be null or a #rrggbb hex colour');
    }
  }
}

function validateViewport(recipe) {
  const viewport = exactKeys(recipe.viewport, 'viewport', ['width', 'height', 'devicePixelRatio']);
  integerAt(viewport.width, 'viewport.width', { min: 1, max: 4096 });
  integerAt(viewport.height, 'viewport.height', { min: 1, max: 4096 });
  numberAt(viewport.devicePixelRatio, 'viewport.devicePixelRatio', { min: 0.25, max: 4 });
}

function validateProfile(recipe) {
  const profile = exactKeys(
    recipe.profile,
    'profile',
    ['visual', 'motion', 'capability', 'reducedMotion'],
  );
  stableIdAt(profile.visual, 'profile.visual');
  stableIdAt(profile.motion, 'profile.motion');
  stableIdAt(profile.capability, 'profile.capability');
  if (typeof profile.reducedMotion !== 'boolean') fail('profile.reducedMotion', 'must be a boolean');
}

function validateSchedule(recipe) {
  const schedule = objectAt(recipe.schedule, 'schedule');
  if (schedule.kind === 'still') {
    exactKeys(schedule, 'schedule', ['kind', 'tick', 'alpha']);
    integerAt(schedule.tick, 'schedule.tick', { min: 0, max: 1_000_000 });
    numberAt(schedule.alpha, 'schedule.alpha', { min: 0, max: 0.999_999 });
    return;
  }
  if (schedule.kind !== 'ticks') fail('schedule.kind', "must be 'still' or 'ticks'");
  exactKeys(
    schedule,
    'schedule',
    ['kind', 'startTick', 'endTick', 'step', 'subdivisions', 'tickRate'],
  );
  integerAt(schedule.startTick, 'schedule.startTick', { min: 0, max: 1_000_000 });
  if (schedule.endTick !== 'scenario') {
    integerAt(schedule.endTick, 'schedule.endTick', { min: schedule.startTick + 1, max: 1_000_000 });
  }
  integerAt(schedule.step, 'schedule.step', { min: 1, max: 10_000 });
  integerAt(schedule.subdivisions, 'schedule.subdivisions', { min: 1, max: 16 });
  integerAt(schedule.tickRate, 'schedule.tickRate', { min: 1, max: 240 });
}

function validatePlayback(recipe) {
  const playback = exactKeys(recipe.playback, 'playback', ['rate', 'intendedFps']);
  numberAt(playback.rate, 'playback.rate', { min: 0.01, max: 16 });
  if (recipe.schedule.kind === 'still') {
    if (playback.intendedFps !== null) fail('playback.intendedFps', 'must be null for a still recipe');
    return;
  }
  numberAt(playback.intendedFps, 'playback.intendedFps', { min: 1, max: 240 });
  const derived = (recipe.schedule.tickRate * recipe.schedule.subdivisions * playback.rate)
    / recipe.schedule.step;
  if (Math.abs(playback.intendedFps - derived) > 1e-9) {
    fail('playback.intendedFps', `must equal the fixed schedule rate (${derived})`);
  }
}

function validateArtifacts(recipe) {
  if (!Array.isArray(recipe.artifacts) || recipe.artifacts.length === 0) {
    fail('artifacts', 'must be a non-empty array');
  }
  const seenFormats = new Set();
  const seenNames = new Set();
  for (const [index, raw] of recipe.artifacts.entries()) {
    const path = `artifacts[${index}]`;
    const artifact = exactKeys(raw, path, ['format', 'filename']);
    if (!Object.hasOwn(FORMAT_EXTENSIONS, artifact.format)) {
      fail(`${path}.format`, `must be one of ${Object.keys(FORMAT_EXTENSIONS).join(', ')}`);
    }
    stringAt(artifact.filename, `${path}.filename`, { max: 80 });
    if (!ARTIFACT_NAME.test(artifact.filename) || artifact.filename.includes('..')) {
      fail(`${path}.filename`, 'must be a safe basename with no path traversal');
    }
    if (!artifact.filename.endsWith(FORMAT_EXTENSIONS[artifact.format])) {
      fail(`${path}.filename`, `must end with ${FORMAT_EXTENSIONS[artifact.format]}`);
    }
    if (artifact.filename === 'capture.json') fail(`${path}.filename`, 'is reserved for the manifest');
    if (seenFormats.has(artifact.format)) fail(`${path}.format`, 'duplicates another requested format');
    if (seenNames.has(artifact.filename)) fail(`${path}.filename`, 'duplicates another artifact name');
    seenFormats.add(artifact.format);
    seenNames.add(artifact.filename);
  }

  const expected = recipe.schedule.kind === 'still'
    ? new Map([['png', 'capture.png']])
    : new Map([['mp4', 'capture.mp4'], ['gif', 'preview.gif']]);
  if (seenFormats.size !== expected.size) {
    fail('artifacts', `must request exactly ${[...expected.keys()].join(' and ')} for this schedule`);
  }
  for (const [format, filename] of expected) {
    const found = recipe.artifacts.find((artifact) => artifact.format === format);
    if (!found || found.filename !== filename) {
      fail('artifacts', `${format} must use the canonical filename ${filename}`);
    }
  }
}

function validateExpectations(recipe) {
  const expectations = exactKeys(
    recipe.expectations,
    'expectations',
    ['events', 'allowUnexpectedEvents'],
  );
  if (!Array.isArray(expectations.events)) fail('expectations.events', 'must be an array');
  if (typeof expectations.allowUnexpectedEvents !== 'boolean') {
    fail('expectations.allowUnexpectedEvents', 'must be a boolean');
  }
  const seen = new Set();
  for (const [index, raw] of expectations.events.entries()) {
    const path = `expectations.events[${index}]`;
    const event = exactKeys(raw, path, ['type', 'tick', 'count']);
    stringAt(event.type, `${path}.type`, { max: 80 });
    if (!EVENT_ID.test(event.type)) fail(`${path}.type`, 'must be a stable event type');
    integerAt(event.tick, `${path}.tick`, { min: 0, max: 1_000_000 });
    integerAt(event.count, `${path}.count`, { min: 1, max: 10_000 });
    const key = `${event.type}@${event.tick}`;
    if (seen.has(key)) fail(path, `duplicates ${key}`);
    seen.add(key);
  }
}

export function validateRecipe(value) {
  const recipe = exactKeys(value, 'recipe', [
    'schemaVersion',
    'recipeVersion',
    'id',
    'producer',
    'fixture',
    'variant',
    'viewport',
    'profile',
    'schedule',
    'playback',
    'artifacts',
    'expectations',
    'title',
    'description',
    'altText',
    'timeoutMs',
    'outputBudgetBytes',
  ]);
  if (recipe.schemaVersion !== RECIPE_SCHEMA_VERSION) {
    fail('schemaVersion', `must be ${RECIPE_SCHEMA_VERSION}`);
  }
  integerAt(recipe.recipeVersion, 'recipeVersion', { min: 1, max: 1_000_000 });
  stableIdAt(recipe.id, 'id');
  validateProducer(recipe);
  validateFixture(recipe);
  validateVariant(recipe);
  validateViewport(recipe);
  validateProfile(recipe);
  validateSchedule(recipe);
  validatePlayback(recipe);
  validateArtifacts(recipe);
  validateExpectations(recipe);
  stringAt(recipe.title, 'title', { max: 120 });
  stringAt(recipe.description, 'description', { max: 1_000 });
  stringAt(recipe.altText, 'altText', { max: 500 });
  integerAt(recipe.timeoutMs, 'timeoutMs', { min: 1_000, max: 10 * 60_000 });
  integerAt(recipe.outputBudgetBytes, 'outputBudgetBytes', { min: 1, max: 1_000_000_000 });
  return recipe;
}

/** RFC-8259-shaped serialization with every object key sorted recursively. */
export function canonicalStringify(value, path = '$') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalStringify(entry, `${path}[${index}]`)).join(',')}]`;
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${path} is not a JSON value`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} is not a plain object`);
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify(value[key], `${path}.${key}`)}`).join(',')}}`;
}

export function recipeHash(recipe) {
  validateRecipe(recipe);
  return createHash('sha256').update(canonicalStringify(recipe)).digest('hex');
}
