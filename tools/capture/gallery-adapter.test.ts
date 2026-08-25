import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { buildGalleryArguments, runGalleryMoment } from './gallery-adapter.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES } from './registry.mjs';

const clone = (index: number) => structuredClone(CAPTURE_RECIPES[index].recipe);
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('gallery moment adapter arguments', () => {
  it('constructs the allowlisted still invocation without a shell or free-form arguments', () => {
    expect(buildGalleryArguments(clone(0), 'tmp/capture-test/gallery')).toEqual([
      '--scene', 'fire',
      '--view', 'game',
      '--skin', 'solid',
      '--spawn-anim', 'warp',
      '--w', '640',
      '--h', '480',
      '--dpr', '1',
      '--out', 'tmp/capture-test/gallery',
      '--report', 'producer.json',
      '--age', '10',
    ]);
  });

  it('constructs the fixed-tick normal-speed temporal invocation', () => {
    expect(buildGalleryArguments(clone(1), 'tmp/capture-test/gallery')).toEqual([
      '--scene', 'ai-tracking',
      '--view', 'game',
      '--skin', 'solid',
      '--spawn-anim', 'warp',
      '--w', '640',
      '--h', '480',
      '--dpr', '1',
      '--out', 'tmp/capture-test/gallery',
      '--report', 'producer.json',
      '--anim',
      '--subdiv', '1',
      '--fps', '60',
    ]);
  });

  it('rejects producer modes the existing gallery path cannot honor', () => {
    const alpha = clone(0);
    alpha.schedule.alpha = 0.5;
    expect(() => buildGalleryArguments(alpha, 'tmp/capture-test/gallery')).toThrow(/alpha = 0/);

    const partial = clone(1);
    partial.schedule.startTick = 1;
    expect(() => buildGalleryArguments(partial, 'tmp/capture-test/gallery')).toThrow(/startTick 0/);

    const reduced = clone(1);
    reduced.profile.reducedMotion = true;
    expect(() => buildGalleryArguments(reduced, 'tmp/capture-test/gallery')).toThrow(/reduced-motion/);

    expect(() => buildGalleryArguments(clone(1), '../escaped')).toThrow(/isolated relative tmp/);
  });

  it('normalizes the gallery report without returning producer-assembled media', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-gallery-adapter-'));
    cleanup.push(root);
    const outputDirectory = join(root, 'tmp', 'capture-test', 'producer');
    const runProcess = vi.fn(async () => {
      await writeFile(join(outputDirectory, 'frame.png'), 'png');
      await writeFile(join(outputDirectory, 'producer.json'), JSON.stringify({
        schemaVersion: 1,
        capture: {
          frameCount: 1,
          viewport: { width: 640, height: 480, devicePixelRatio: 1 },
          pageErrors: [],
        },
        browser: { chromiumVersion: '151.0.7922.34' },
        producer: {
          schemaVersion: 1,
          producer: { kind: 'moment', scenarioId: 'fire' },
          fixture: { seed: 7 },
          tickCount: 40,
          observedEvents: [{ type: 'fire', tick: 10 }],
          fixtureAssertions: [{
            kind: 'event-at-tick', type: 'fire', expectedTick: 10, observedTicks: [10], passed: true,
          }],
        },
      }));
      return { code: 0, stdout: '', stderr: '' };
    });
    await mkdir(outputDirectory, { recursive: true });
    const result = await runGalleryMoment({
      recipe: clone(0),
      root,
      outputDirectory,
      outputRelative: 'tmp/capture-test/producer',
      prerequisites: { playwright: { moduleSpecifier: 'fake-playwright' } },
      env: {},
    }, { runProcess });

    expect(result).toMatchObject({
      schemaVersion: 1,
      producer: { kind: 'moment', scenarioId: 'fire' },
      capture: { frameSchedule: { kind: 'still', frameCount: 1 } },
      metadata: {
        moment: {
          fixture: { id: 'gallery.fire', seed: 7 },
          tickSchedule: { kind: 'still', tick: 10, frameCount: 1 },
          observedEvents: [{ type: 'fire', tick: 10 }],
        },
      },
      toolVersions: { chromium: '151.0.7922.34' },
    });
    expect(result).not.toHaveProperty('previewFile');
    expect(result).not.toHaveProperty('report');
  });
});
