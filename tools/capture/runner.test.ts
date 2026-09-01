import { access, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { createProducerRegistry } from './producers.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { PRODUCER_RESULT_SCHEMA_VERSION } from './producer.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES, createRegistry } from './registry.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { captureRecipe, cleanupCaptureResources } from './runner.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

async function root(): Promise<string> {
  // realpath pins these fixtures to a plain checkout: macOS's tmpdir sits behind the
  // /var -> /private/var symlink, and the symlinked-root case has its own test below.
  const path = await realpath(await mkdtemp(join(tmpdir(), 'capture-runner-')));
  roots.push(path);
  return path;
}

const source = { requestedRef: null, commitSha: 'a'.repeat(40), dirty: false };
const prerequisites = {
  playwright: { moduleSpecifier: '/tmp/playwright/index.mjs', version: '1.62.0', executablePath: '/tmp/chromium' },
  ffmpeg: 'ffmpeg version 6.1.1',
  ffprobe: 'ffprobe version 6.1.1',
};

function quantizedGifDuration(frames: number): number {
  return Math.round((frames / 60) * 100) / 100;
}

function artifactDescription(format: string, frames: number) {
  const gifDuration = quantizedGifDuration(frames);
  return {
    width: 640,
    height: 480,
    frameCount: frames,
    durationSeconds: format === 'png' ? null : format === 'gif' ? gifDuration : frames / 60,
    codec: format === 'mp4' ? 'h264' : format,
    pixelFormat: format === 'mp4' ? 'yuv420p' : format === 'gif' ? 'bgra' : 'rgba',
    averageFrameRate: format === 'png' ? null : format === 'gif' ? 100 : 60,
    container: format === 'mp4'
      ? { faststart: true, moovOffset: 32, mdatOffset: 512, measuredBy: 'mp4-box-order' }
      : format === 'gif'
        ? {
            loopExtensionPresent: true,
            loopCount: 0,
            looping: true,
            frameCount: frames,
            displayedDurationSeconds: gifDuration,
            delayCentiseconds: { minimum: 1, maximum: 2, total: gifDuration * 100 },
            measuredBy: 'gif-block-parser',
          }
        : null,
    byteSize: 10,
    sha256: 'b'.repeat(64),
  };
}

function common(runProducer?: any, extra: Record<string, any> = {}) {
  return {
    inspectSourceState: vi.fn(async () => source),
    inspectPrerequisites: vi.fn(async () => prerequisites),
    ...(runProducer ? { runProducer } : {}),
    encodeMp4: vi.fn(async ({ output }: { output: string }) => writeFile(output, 'mp4')),
    encodeGif: vi.fn(async ({ output }: { output: string }) => writeFile(output, 'gif')),
    describeArtifact: vi.fn(async (_path: string, format: string) =>
      artifactDescription(format, format === 'png' ? 1 : 47)),
    ...extra,
  };
}

function normalizedResult(context: any, options: {
  frames: string[];
  assertions?: any[];
  metadata?: any;
  kind?: string;
  scenarioId?: string;
  toolVersions?: Record<string, string>;
}) {
  return {
    schemaVersion: PRODUCER_RESULT_SCHEMA_VERSION,
    producer: {
      kind: options.kind ?? context.recipe.producer.kind,
      scenarioId: options.scenarioId ?? context.recipe.producer.scenarioId,
    },
    rawFrames: options.frames,
    capture: {
      viewport: context.recipe.viewport,
      frameSchedule: context.recipe.schedule.kind === 'still'
        ? { kind: 'still', frameCount: 1 }
        : { kind: 'frames', frameCount: options.frames.length },
    },
    assertions: options.assertions ?? [],
    metadata: options.metadata ?? null,
    toolVersions: options.toolVersions ?? { chromium: '151.0.7922.34' },
    diagnostics: [],
  };
}

async function stillProducer(context: any) {
  const frame = join(context.outputDirectory, 'frame.png');
  await writeFile(frame, 'png');
  return normalizedResult(context, {
    frames: [frame],
    assertions: [{
      kind: 'event-count',
      passed: true,
      diagnostic: null,
      details: { expected: { type: 'fire', tick: 10, count: 1 }, observedCount: 1 },
    }],
    metadata: {
      moment: {
        fixture: { id: 'gallery.fire', seed: 7 },
        tickSchedule: { kind: 'still', tick: 10, alpha: 0, frameCount: 1 },
        observedEvents: [{ type: 'fire', tick: 10 }],
        fixtureAssertions: [],
      },
    },
  });
}

async function temporalProducer(context: any) {
  const rawFrames: string[] = [];
  for (let index = 0; index < 47; index++) {
    const frame = join(context.outputDirectory, `frame-${String(index).padStart(4, '0')}.png`);
    await writeFile(frame, `frame ${index}`);
    rawFrames.push(frame);
  }
  return normalizedResult(context, {
    frames: rawFrames,
    metadata: {
      moment: {
        fixture: { id: 'gallery.ai-tracking', seed: 7 },
        tickSchedule: {
          kind: 'ticks', startTick: 0, endTickExclusive: 47, step: 1,
          subdivisions: 1, tickRate: 60, frameCount: 47,
        },
        observedEvents: [],
        fixtureAssertions: [],
      },
    },
  });
}

describe('capture runner publication and cleanup', () => {
  it('publishes a complete still directory and removes its unique workspace', async () => {
    const checkout = await root();
    let workspace = '';
    const runProducer = vi.fn(async (context: any) => {
      workspace = dirname(context.outputDirectory);
      return stillProducer(context);
    });
    const result = await captureRecipe(CAPTURE_RECIPES[0], {
      root: checkout,
      out: 'artifacts/capture/still',
      retainFrames: false,
      sourceRef: null,
    }, common(runProducer));

    expect(await missing(workspace)).toBe(true);
    expect(await readFile(join(result.output.absolute, 'capture.png'), 'utf8')).toBe('png');
    const manifest = JSON.parse(await readFile(join(result.output.absolute, 'capture.json'), 'utf8'));
    expect(manifest.status).toBe('success');
    expect(manifest.outputs.rawFrames).toMatchObject({ retained: false, frameCount: 1 });
    expect(await missing(`${result.output.absolute}.capture.lock`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('publishes through a symlinked checkout root', async () => {
    const real = await root();
    const outer = await root();
    const checkout = join(outer, 'checkout');
    await symlink(real, checkout);
    let seen: any = null;
    const runProducer = vi.fn(async (context: any) => {
      seen = context;
      return stillProducer(context);
    });
    const result = await captureRecipe(CAPTURE_RECIPES[0], {
      root: checkout,
      out: 'artifacts/capture/still',
      retainFrames: false,
      sourceRef: null,
    }, common(runProducer));

    // What the gallery adapter's `tmp/...` argument check needs from the runner.
    expect(seen.outputRelative).toMatch(/^tmp\/capture-[^/]+\/producer$/);
    expect(await missing(dirname(seen.outputDirectory))).toBe(true);
    expect(await readFile(join(result.output.absolute, 'capture.png'), 'utf8')).toBe('png');
  });

  it('retains numbered raw frames only when explicitly requested', async () => {
    const checkout = await root();
    const result = await captureRecipe(CAPTURE_RECIPES[0], {
      root: checkout,
      out: 'artifacts/capture/retained',
      retainFrames: true,
      sourceRef: null,
    }, common(stillProducer));
    expect(await readFile(join(result.output.absolute, 'frames/frame-0000.png'), 'utf8')).toBe('png');
    const manifest = JSON.parse(await readFile(join(result.output.absolute, 'capture.json'), 'utf8'));
    expect(manifest.outputs.rawFrames).toMatchObject({
      retained: true,
      directory: 'frames',
      pattern: 'frames/frame-%04d.png',
      frameCount: 1,
    });
  });

  it('refuses an existing output before prerequisites or producer work', async () => {
    const checkout = await root();
    const output = join(checkout, 'artifacts/capture/existing');
    await mkdir(output, { recursive: true });
    const runProducer = vi.fn(stillProducer);
    const deps = common(runProducer);
    await expect(captureRecipe(CAPTURE_RECIPES[0], {
      root: checkout, out: 'artifacts/capture/existing', retainFrames: false,
    }, deps)).rejects.toThrow(/already exists/);
    expect(deps.inspectPrerequisites).not.toHaveBeenCalled();
    expect(runProducer).not.toHaveBeenCalled();
  });

  it('reports missing prerequisites before creating a temporary workspace', async () => {
    const checkout = await root();
    const runProducer = vi.fn(stillProducer);
    const deps = common(runProducer, {
      inspectPrerequisites: vi.fn(async () => { throw new Error('ffprobe is required'); }),
    });
    await expect(captureRecipe(CAPTURE_RECIPES[0], {
      root: checkout, out: 'artifacts/capture/missing-tools', retainFrames: false,
    }, deps)).rejects.toThrow(/ffprobe is required/);
    expect(runProducer).not.toHaveBeenCalled();
    expect(await missing(join(checkout, 'tmp'))).toBe(true);
  });

  it('removes workspace and partial publication after injected capture failure', async () => {
    const checkout = await root();
    let workspace = '';
    const runProducer = vi.fn(async (context: any) => {
      workspace = dirname(context.outputDirectory);
      await writeFile(join(context.outputDirectory, 'frame.png'), 'partial');
      throw new Error('injected capture failure');
    });
    const output = join(checkout, 'artifacts/capture/capture-failure');
    await expect(captureRecipe(CAPTURE_RECIPES[0], {
      root: checkout, out: 'artifacts/capture/capture-failure', retainFrames: false,
    }, common(runProducer))).rejects.toThrow(/injected capture failure/);
    expect(await missing(workspace)).toBe(true);
    expect(await missing(output)).toBe(true);
    expect(await missing(`${output}.capture.lock`)).toBe(true);
  });

  it('removes raw frames and partial output after injected encoder failure', async () => {
    const checkout = await root();
    let workspace = '';
    const runProducer = vi.fn(async (context: any) => {
      workspace = dirname(context.outputDirectory);
      return temporalProducer(context);
    });
    const encodeMp4 = vi.fn(async ({ output }: { output: string }) => {
      await writeFile(output, 'partial mp4');
      throw new Error('injected encoder failure');
    });
    const output = join(checkout, 'artifacts/capture/encoder-failure');
    await expect(captureRecipe(CAPTURE_RECIPES[1], {
      root: checkout, out: 'artifacts/capture/encoder-failure', retainFrames: false,
    }, common(runProducer, { encodeMp4 }))).rejects.toThrow(/injected encoder failure/);
    expect(await missing(workspace)).toBe(true);
    expect(await missing(output)).toBe(true);
    expect(await missing(`${output}.capture.lock`)).toBe(true);
  });

  it('removes raw frames and partial output after a normalized assertion failure', async () => {
    const checkout = await root();
    let workspace = '';
    const runProducer = vi.fn(async (context: any) => {
      workspace = dirname(context.outputDirectory);
      const result = await stillProducer(context);
      result.assertions[0].passed = false;
      result.assertions[0].diagnostic = 'expected 1 fire event at tick 10, observed 0';
      return result;
    });
    const output = join(checkout, 'artifacts/capture/assertion-failure');
    await expect(captureRecipe(CAPTURE_RECIPES[0], {
      root: checkout, out: 'artifacts/capture/assertion-failure', retainFrames: false,
    }, common(runProducer))).rejects.toThrow(/capture assertions failed.*fire.*tick 10/);
    expect(await missing(workspace)).toBe(true);
    expect(await missing(output)).toBe(true);
    expect(await missing(`${output}.capture.lock`)).toBe(true);
  });

  it('does not publish a temporal directory until both shared encoders and probes succeed', async () => {
    const checkout = await root();
    const deps = common(temporalProducer);
    const result = await captureRecipe(CAPTURE_RECIPES[1], {
      root: checkout,
      out: 'artifacts/capture/temporal',
      retainFrames: false,
      sourceRef: null,
    }, deps);
    expect(deps.encodeMp4).toHaveBeenCalledOnce();
    expect(deps.encodeGif).toHaveBeenCalledOnce();
    expect((await stat(join(result.output.absolute, 'capture.mp4'))).isFile()).toBe(true);
    expect((await stat(join(result.output.absolute, 'preview.gif'))).isFile()).toBe(true);
    expect((await stat(join(result.output.absolute, 'capture.json'))).isFile()).toBe(true);
  });

  it('runs a fake non-moment producer through the complete shared artifact pipeline', async () => {
    const checkout = await root();
    const recipe = structuredClone(CAPTURE_RECIPES[1].recipe);
    recipe.id = 'test.screen.clip';
    recipe.producer = { kind: 'screen', scenarioId: 'fake-screen' };
    recipe.fixture = { id: 'fake-screen', seed: 99 };
    recipe.variant = {};
    recipe.schedule = { kind: 'frames', frameCount: 2 };
    const [entry] = createRegistry([recipe]);
    const fakeScreen = vi.fn(async (context: any) => {
      const frames = [];
      for (let index = 0; index < 2; index++) {
        const frame = join(context.outputDirectory, `arbitrary-${index}.png`);
        await writeFile(frame, `screen ${index}`);
        frames.push(frame);
      }
      return normalizedResult(context, {
        frames,
        kind: 'screen',
        scenarioId: 'fake-screen',
        metadata: null,
        assertions: [{ kind: 'screen-ready', passed: true, diagnostic: null, details: {} }],
        toolVersions: { fake: '1.0.0' },
      });
    });
    const producerRegistry = createProducerRegistry([['screen', fakeScreen]]);
    const deps = common(undefined, {
      producerRegistry,
      describeArtifact: vi.fn(async (_path: string, format: string) => artifactDescription(format, 2)),
    });

    const result = await captureRecipe(entry, {
      root: checkout,
      out: 'artifacts/capture/fake-screen',
      retainFrames: false,
      sourceRef: null,
    }, deps);

    expect(fakeScreen).toHaveBeenCalledOnce();
    expect(deps.encodeMp4).toHaveBeenCalledOnce();
    expect(deps.encodeGif).toHaveBeenCalledOnce();
    expect(result.manifest.producer).toMatchObject({
      kind: 'screen', scenarioId: 'fake-screen', metadata: null,
    });
    expect(result.manifest.capture).toMatchObject({
      requestedSchedule: { kind: 'frames', frameCount: 2 },
      frameSchedule: { kind: 'frames', frameCount: 2 },
    });
    expect(result.manifest.assertions).toEqual([
      { kind: 'screen-ready', passed: true, diagnostic: null, details: {} },
    ]);
    expect((await stat(join(result.output.absolute, 'capture.mp4'))).isFile()).toBe(true);
    expect((await stat(join(result.output.absolute, 'preview.gif'))).isFile()).toBe(true);
  });

  it('makes cleanup idempotent across overlapping cancellation paths', async () => {
    const checkout = await root();
    const workspace = join(checkout, 'tmp', 'capture-test');
    const publishDirectory = join(workspace, 'publish');
    const lockPath = join(checkout, 'capture.lock');
    await mkdir(publishDirectory, { recursive: true });
    const lock = await open(lockPath, 'wx');
    const state: any = { lock, lockPath, workspace, publishDirectory, cleanupPromise: null };
    const first = cleanupCaptureResources(state);
    const second = cleanupCaptureResources(state);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await expect(cleanupCaptureResources(state)).resolves.toBeUndefined();
    expect(await missing(workspace)).toBe(true);
    expect(await missing(lockPath)).toBe(true);
  });
});
