import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { buildGalleryArguments } from './gallery-adapter.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES } from './registry.mjs';

const clone = (index: number) => structuredClone(CAPTURE_RECIPES[index].recipe);

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
});
