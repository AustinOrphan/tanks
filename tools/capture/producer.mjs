import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

export const PRODUCER_RESULT_SCHEMA_VERSION = 1;

const STABLE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function fail(path, message) {
  throw new Error(`invalid capture producer result at ${path}: ${message}`);
}

function plainObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(path, 'must be a plain object');
  return value;
}

function exactKeys(value, path, required, optional = []) {
  const object = plainObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not an allowed field');
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail(`${path}.${key}`, 'is required');
  }
  return object;
}

function assertJson(value, path) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must not contain non-finite numbers');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`));
    return;
  }
  const object = plainObject(value, path);
  for (const [key, entry] of Object.entries(object)) assertJson(entry, `${path}.${key}`);
}

function validateIdentity(result, recipe) {
  const producer = exactKeys(result.producer, 'producer', ['kind', 'scenarioId']);
  if (producer.kind !== recipe.producer.kind || producer.scenarioId !== recipe.producer.scenarioId) {
    fail(
      'producer',
      `reported ${producer.kind}:${producer.scenarioId}; expected ${recipe.producer.kind}:${recipe.producer.scenarioId}`,
    );
  }
}

function validateCapture(result, recipe) {
  const capture = exactKeys(result.capture, 'capture', ['viewport', 'frameSchedule']);
  const viewport = exactKeys(
    capture.viewport,
    'capture.viewport',
    ['width', 'height', 'devicePixelRatio'],
  );
  for (const key of ['width', 'height', 'devicePixelRatio']) {
    if (viewport[key] !== recipe.viewport[key]) {
      fail(`capture.viewport.${key}`, `reported ${viewport[key]}; expected ${recipe.viewport[key]}`);
    }
  }

  const schedule = plainObject(capture.frameSchedule, 'capture.frameSchedule');
  if (schedule.kind === 'still') {
    exactKeys(schedule, 'capture.frameSchedule', ['kind', 'frameCount']);
    if (recipe.schedule.kind !== 'still') fail('capture.frameSchedule.kind', "must be 'frames'");
    if (schedule.frameCount !== 1) fail('capture.frameSchedule.frameCount', 'must be 1 for a still');
  } else if (schedule.kind === 'frames') {
    exactKeys(schedule, 'capture.frameSchedule', ['kind', 'frameCount']);
    if (recipe.schedule.kind === 'still') fail('capture.frameSchedule.kind', "must be 'still'");
    if (!Number.isInteger(schedule.frameCount) || schedule.frameCount < 1) {
      fail('capture.frameSchedule.frameCount', 'must be a positive whole number');
    }
    if (recipe.schedule.kind === 'frames' && schedule.frameCount !== recipe.schedule.frameCount) {
      fail(
        'capture.frameSchedule.frameCount',
        `reported ${schedule.frameCount}; recipe requests ${recipe.schedule.frameCount}`,
      );
    }
  } else fail('capture.frameSchedule.kind', "must be 'still' or 'frames'");
}

function validateAssertions(result) {
  if (!Array.isArray(result.assertions)) fail('assertions', 'must be an array');
  for (const [index, raw] of result.assertions.entries()) {
    const path = `assertions[${index}]`;
    const assertion = exactKeys(raw, path, ['kind', 'passed', 'diagnostic', 'details']);
    if (typeof assertion.kind !== 'string' || !STABLE_ID.test(assertion.kind)) {
      fail(`${path}.kind`, 'must be a stable lowercase ID');
    }
    if (typeof assertion.passed !== 'boolean') fail(`${path}.passed`, 'must be a boolean');
    if (assertion.diagnostic !== null && typeof assertion.diagnostic !== 'string') {
      fail(`${path}.diagnostic`, 'must be null or a string');
    }
    assertJson(assertion.details, `${path}.details`);
  }
}

function validateOptionalFields(result) {
  if (result.metadata !== null) assertJson(result.metadata, 'metadata');
  const versions = plainObject(result.toolVersions, 'toolVersions');
  for (const [name, version] of Object.entries(versions)) {
    if (!STABLE_ID.test(name) || typeof version !== 'string' || version.length === 0) {
      fail(`toolVersions.${name}`, 'must map a stable tool ID to non-empty version text');
    }
  }
  if (!Array.isArray(result.diagnostics) || result.diagnostics.some((item) => typeof item !== 'string')) {
    fail('diagnostics', 'must be an array of strings');
  }
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function validateRawFrames(result, outputDirectory) {
  if (!Array.isArray(result.rawFrames) || result.rawFrames.length === 0) {
    fail('rawFrames', 'must be a non-empty array');
  }
  if (result.rawFrames.length !== result.capture.frameSchedule.frameCount) {
    fail(
      'rawFrames',
      `contains ${result.rawFrames.length} paths; frame schedule reports ${result.capture.frameSchedule.frameCount}`,
    );
  }
  const realOutput = await realpath(outputDirectory);
  const seen = new Set();
  for (const [index, frame] of result.rawFrames.entries()) {
    const path = `rawFrames[${index}]`;
    if (typeof frame !== 'string' || !isAbsolute(frame)) fail(path, 'must be an absolute file path');
    const linkInfo = await lstat(frame).catch((error) => {
      fail(path, `is not readable: ${error.message}`);
    });
    if (linkInfo.isSymbolicLink()) fail(path, 'must not be a symbolic link');
    const [realFrame, info] = await Promise.all([realpath(frame), stat(frame)]);
    if (!inside(realOutput, realFrame)) fail(path, 'escapes the producer output directory');
    if (!info.isFile()) fail(path, 'must be a regular file');
    if (seen.has(realFrame)) fail(path, 'duplicates another raw frame');
    seen.add(realFrame);
  }
}

/**
 * Validate the producer boundary shared by moment, screen, flow, and replay adapters.
 * Core consumes only raw frames, generic capture facts, generic assertion results, optional
 * structured metadata, and optional tool versions. Producer-specific fields never become
 * required runner or encoder inputs.
 */
export async function validateProducerResult(value, { recipe, outputDirectory }) {
  const result = exactKeys(
    value,
    'result',
    [
      'schemaVersion',
      'producer',
      'rawFrames',
      'capture',
      'assertions',
      'metadata',
      'toolVersions',
      'diagnostics',
    ],
  );
  if (result.schemaVersion !== PRODUCER_RESULT_SCHEMA_VERSION) {
    fail('schemaVersion', `must be ${PRODUCER_RESULT_SCHEMA_VERSION}`);
  }
  validateIdentity(result, recipe);
  validateCapture(result, recipe);
  validateAssertions(result);
  validateOptionalFields(result);
  await validateRawFrames(result, outputDirectory);

  const failures = result.assertions.filter((assertion) => !assertion.passed);
  if (failures.length > 0) {
    throw new Error(
      `capture assertions failed: ${failures.map((failure) =>
        failure.diagnostic ?? `${failure.kind} failed`).join('; ')}`,
    );
  }
  return result;
}
