import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { buildGalleryArguments, runGalleryMoment } from './gallery-adapter.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES } from './registry.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { validateRecipe } from './schema.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { galleryQuery, parseArgs } from '../gallery/args.mjs';

const clone = (index: number) => structuredClone(CAPTURE_RECIPES[index].recipe);
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const NO_ARMS = { arrival: null, identityMarker: null, shellTrail: null };

/** Runs the adapter over a faked gallery process whose report claims `arms` were applied. */
async function runFakeMoment(root: string, outputDirectory: string, recipe: any, arms: unknown) {
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
      arms,
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
  return runGalleryMoment({
    recipe,
    root,
    outputDirectory,
    outputRelative: 'tmp/capture-test/producer',
    prerequisites: { playwright: { moduleSpecifier: 'fake-playwright' } },
    env: {},
  }, { runProcess });
}

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
    const result = await runFakeMoment(root, outputDirectory, clone(0), NO_ARMS);

    expect(result).toMatchObject({
      schemaVersion: 1,
      producer: { kind: 'moment', scenarioId: 'fire' },
      capture: { frameSchedule: { kind: 'still', frameCount: 1 } },
      metadata: {
        moment: {
          fixture: { id: 'gallery.fire', seed: 7 },
          arms: NO_ARMS,
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

describe('moment recipes naming developer arms (issue #775)', () => {
  const ARM_FLAGS = ['--arrival', '--identityMarker', '--shellTrail'];
  /** A moment recipe re-pointed at another scene, still valid by the schema. */
  const momentAt = (scenarioId: string, arms?: Record<string, string>) => {
    const recipe = clone(0);
    recipe.producer.scenarioId = scenarioId;
    recipe.fixture.id = `gallery.${scenarioId}`;
    recipe.expectations = { events: [], allowUnexpectedEvents: true };
    if (arms) recipe.variant.arms = arms;
    return recipe;
  };
  /** What the gallery page is asked for: the adapter's argv, parsed by the gallery's own CLI. */
  const pageQuery = (recipe: any) =>
    new URLSearchParams(galleryQuery(parseArgs(buildGalleryArguments(recipe, 'tmp/capture-test/gallery'))));

  it('adds no arm flag for any shipped moment recipe, since none names an arm', () => {
    const moments = CAPTURE_RECIPES.filter((entry: any) => entry.recipe.producer.kind === 'moment');
    expect(moments.length).toBeGreaterThan(0);
    for (const { recipe } of moments) {
      expect(recipe.variant, recipe.id).not.toHaveProperty('arms');
      const argv = buildGalleryArguments(recipe, 'tmp/capture-test/gallery');
      expect(argv.filter((a: string) => ARM_FLAGS.includes(a)), recipe.id).toEqual([]);
    }
  });

  it("carries a recipe's arrival arm into the respawn moment's page request, and nothing without it", () => {
    const shipped = momentAt('respawn');
    const opposed = momentAt('respawn', { arrival: 'opposed' });
    expect(() => validateRecipe(shipped)).not.toThrow();
    expect(() => validateRecipe(opposed)).not.toThrow();
    expect(pageQuery(opposed).get('arrival')).toBe('opposed');
    expect(pageQuery(shipped).get('arrival')).toBeNull();
    expect(pageQuery(opposed).get('scene')).toBe('respawn');
  });

  it('records the arms the gallery applied, and refuses a report that applied something else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-gallery-arms-'));
    cleanup.push(root);
    const recipe = momentAt('fire', { shellTrail: 'segments' });
    const applied = { ...NO_ARMS, shellTrail: 'segments' };
    const result = await runFakeMoment(root, join(root, 'tmp', 'capture-test', 'a'), recipe, applied);
    expect(result.metadata.moment.arms).toEqual(applied);
    // The shipped look under an arm's name: the gallery reports no trail for a trail recipe.
    await expect(
      runFakeMoment(root, join(root, 'tmp', 'capture-test', 'b'), recipe, NO_ARMS),
    ).rejects.toThrow(/gallery applied shellTrail=null, but the recipe requested shellTrail=segments/);
  });

  it('refuses arms the gallery itself would refuse', () => {
    expect(() => validateRecipe(momentAt('fire', { shellTrail: 'segments' }))).not.toThrow();
    expect(() => validateRecipe(momentAt('fire', { shellTrail: 'comet' }))).toThrow(/variant\.arms.*--shellTrail must be one of/);
    // A real arm on a scene where it shows nothing: the gallery's own applicability refusal.
    expect(() => validateRecipe(momentAt('fire', { arrival: 'opposed' }))).toThrow(/variant\.arms.*--arrival needs a scene/);
    expect(() => validateRecipe(momentAt('fire', { stockCue: 'pips' }))).toThrow(/variant\.arms\.stockCue.*not an allowed field/);
    expect(() => validateRecipe(momentAt('fire', {}))).toThrow(/variant\.arms.*at least one arm/);
    const screen = structuredClone(CAPTURE_RECIPES.find((e: any) => e.recipe.producer.kind === 'screen').recipe);
    screen.variant.arms = { shellTrail: 'segments' };
    expect(() => validateRecipe(screen)).toThrow(/variant\.arms.*not an allowed field/);
  });
});
