import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { producerForKind } from './producers.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES, createRegistry } from './registry.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { canonicalStringify, recipeHash, validateRecipe } from './schema.mjs';

function recipe(index = 0): Record<string, any> {
  return structuredClone(CAPTURE_RECIPES[index].recipe);
}

function reverseKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  return value;
}

describe('capture recipe schema', () => {
  it('validates every registered recipe and keeps the initial IDs intentional', () => {
    expect(CAPTURE_RECIPES.map((entry: any) => entry.recipe.id)).toEqual([
      'gallery.fire.still',
      'gallery.ai-tracking.normal',
    ]);
    for (const entry of CAPTURE_RECIPES) expect(validateRecipe(entry.recipe)).toBe(entry.recipe);
  });

  it('rejects duplicate IDs instead of making lookup order decide which recipe runs', () => {
    const a = recipe();
    const b = recipe(1);
    b.id = a.id;
    expect(() => createRegistry([a, b])).toThrow(/duplicate capture recipe ID/);
  });

  it('hashes canonical content independently of object-key insertion order', () => {
    const original = recipe(1);
    const reordered = reverseKeys(original);
    expect(JSON.stringify(original)).not.toBe(JSON.stringify(reordered)); // the control really reordered it
    expect(canonicalStringify(original)).toBe(canonicalStringify(reordered));
    expect(recipeHash(original)).toBe(recipeHash(reordered));
  });

  it('rejects unknown producer kinds and clearly refuses recognized unimplemented kinds', () => {
    const unknown = recipe();
    unknown.producer.kind = 'shell';
    expect(() => validateRecipe(unknown)).toThrow(/must be one of moment, screen, flow, replay/);

    for (const kind of ['screen', 'flow', 'replay']) {
      const future = recipe();
      future.producer.kind = kind;
      future.variant = {};
      expect(() => validateRecipe(future)).not.toThrow(); // contract shape is extensible
      expect(() => producerForKind(kind)).toThrow(new RegExp(`'${kind}'.*not implemented`));
    }
  });

  it('rejects invalid producer options instead of forwarding arbitrary gallery arguments', () => {
    const command = recipe();
    command.variant.command = 'node';
    expect(() => validateRecipe(command)).toThrow(/variant\.command.*not an allowed field/);

    const future = recipe();
    future.producer.kind = 'screen';
    future.variant = { route: '/title' };
    expect(() => validateRecipe(future)).toThrow(/variant\.route.*not an allowed field/);

    const view = recipe();
    view.variant.view = 'whatever-the-cli-accepts';
    expect(() => validateRecipe(view)).toThrow(/variant\.view/);
  });

  it('rejects command-like machine values and unsafe artifact paths', () => {
    const scenario = recipe();
    scenario.producer.scenarioId = 'ai-tracking;rm-rf';
    expect(() => validateRecipe(scenario)).toThrow(/producer\.scenarioId.*stable ID/);

    const fixture = recipe();
    fixture.fixture.id = '$(touch-owned)';
    expect(() => validateRecipe(fixture)).toThrow(/fixture\.id.*stable ID/);

    for (const filename of ['../capture.png', 'nested/capture.png', '$(touch).png', 'capture.json']) {
      const artifact = recipe();
      artifact.artifacts[0].filename = filename;
      expect(() => validateRecipe(artifact), filename).toThrow(/artifacts/);
    }
  });

  it('rejects invalid still and fixed-tick schedules', () => {
    const negativeTick = recipe();
    negativeTick.schedule.tick = -1;
    expect(() => validateRecipe(negativeTick)).toThrow(/schedule\.tick/);

    const invalidAlpha = recipe();
    invalidAlpha.schedule.alpha = 1;
    expect(() => validateRecipe(invalidAlpha)).toThrow(/schedule\.alpha/);

    for (const [field, value] of [['step', 0], ['subdivisions', 0], ['tickRate', 0]] as const) {
      const temporal = recipe(1);
      temporal.schedule[field] = value;
      expect(() => validateRecipe(temporal), field).toThrow(new RegExp(`schedule\\.${field}`));
    }

    const mismatchedPlayback = recipe(1);
    mismatchedPlayback.playback.intendedFps = 30;
    expect(() => validateRecipe(mismatchedPlayback)).toThrow(/fixed schedule rate/);

    const frameScheduled = recipe(1);
    frameScheduled.producer.kind = 'screen';
    frameScheduled.producer.scenarioId = 'fake-screen';
    frameScheduled.variant = {};
    frameScheduled.schedule = { kind: 'frames', frameCount: 12 };
    frameScheduled.playback.intendedFps = 24;
    expect(() => validateRecipe(frameScheduled)).not.toThrow();

    frameScheduled.schedule.frameCount = 0;
    expect(() => validateRecipe(frameScheduled)).toThrow(/schedule\.frameCount/);
  });

  it('rejects non-JSON canonical values rather than hashing implementation accidents', () => {
    expect(() => canonicalStringify({ bad: undefined })).toThrow(/not a JSON value/);
    expect(() => canonicalStringify({ bad: Number.NaN })).toThrow(/non-finite/);
  });
});
