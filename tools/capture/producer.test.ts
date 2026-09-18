import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { PRODUCER_RESULT_SCHEMA_VERSION, validateProducerResult } from './producer.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES } from './registry.mjs';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'capture-producer-'));
  cleanup.push(outputDirectory);
  const frame = join(outputDirectory, 'anything.png');
  await writeFile(frame, 'png');
  return { outputDirectory, frame };
}

function result(frame: string) {
  return {
    schemaVersion: PRODUCER_RESULT_SCHEMA_VERSION,
    producer: { kind: 'moment', scenarioId: 'fire' },
    rawFrames: [frame],
    capture: {
      viewport: { width: 640, height: 480, devicePixelRatio: 1 },
      frameSchedule: { kind: 'still', frameCount: 1 },
    },
    assertions: [{ kind: 'producer-ready', passed: true, diagnostic: null, details: {} }],
    metadata: null,
    toolVersions: {},
    diagnostics: [],
  };
}

describe('normalized capture producer result', () => {
  it('accepts the generic contract without moment-specific report fields', async () => {
    const { outputDirectory, frame } = await fixture();
    const value = result(frame);
    await expect(validateProducerResult(value, {
      recipe: CAPTURE_RECIPES[0].recipe,
      outputDirectory,
    })).resolves.toBe(value);
    expect(value).not.toHaveProperty('report');
    expect(value).not.toHaveProperty('previewFile');
  });

  it('rejects old producer-owned preview assembly and failed generic assertions', async () => {
    const { outputDirectory, frame } = await fixture();
    const preview = { ...result(frame), previewFile: join(outputDirectory, 'gallery.gif') };
    await expect(validateProducerResult(preview, {
      recipe: CAPTURE_RECIPES[0].recipe,
      outputDirectory,
    })).rejects.toThrow(/previewFile.*not an allowed field/);

    const failed = result(frame);
    failed.assertions[0] = {
      kind: 'producer-ready', passed: false, diagnostic: 'fake producer was not ready', details: {},
    };
    await expect(validateProducerResult(failed, {
      recipe: CAPTURE_RECIPES[0].recipe,
      outputDirectory,
    })).rejects.toThrow(/capture assertions failed.*fake producer was not ready/);
  });

  it.skipIf(process.platform === 'win32')('rejects raw-frame symlinks and output escape', async () => {
    const { outputDirectory } = await fixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'capture-producer-outside-'));
    cleanup.push(outsideDirectory);
    const outside = join(outsideDirectory, 'outside.png');
    const linked = join(outputDirectory, 'linked.png');
    await writeFile(outside, 'outside');
    await symlink(outside, linked);

    await expect(validateProducerResult(result(linked), {
      recipe: CAPTURE_RECIPES[0].recipe,
      outputDirectory,
    })).rejects.toThrow(/must not be a symbolic link/);
    await expect(validateProducerResult(result(outside), {
      recipe: CAPTURE_RECIPES[0].recipe,
      outputDirectory,
    })).rejects.toThrow(/escapes the producer output directory/);
  });
});

describe('a realtime window fixes the frame count (issue #815)', () => {
  it('rejects a frames result whose count is not the window times the rate, naming both', async () => {
    const { outputDirectory, frame } = await fixture();
    const flow = CAPTURE_RECIPES.find((entry: any) => entry.recipe.id === 'flow.campaign-round.pp1roles-off').recipe;
    const short = {
      ...result(frame),
      producer: { kind: 'flow', scenarioId: 'campaign-round' },
      capture: { viewport: flow.viewport, frameSchedule: { kind: 'frames', frameCount: 599 } },
    };
    await expect(validateProducerResult(short, { recipe: flow, outputDirectory }))
      .rejects.toThrow(/reported 599; a 20 s window at 30 fps is 600/);
    // The negative control: the same short count under a plain `frames` recipe of 599 is accepted
    // at this check (it fails later, on the raw-frame count, which is not this rule).
    const frames = structuredClone(flow);
    frames.schedule = { kind: 'frames', frameCount: 599 };
    await expect(validateProducerResult(short, { recipe: frames, outputDirectory }))
      .rejects.not.toThrow(/a 20 s window/);
  });
});
