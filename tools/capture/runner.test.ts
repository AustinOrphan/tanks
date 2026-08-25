import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES } from './registry.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { captureRecipe } from './runner.mjs';

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
  const path = await mkdtemp(join(tmpdir(), 'capture-runner-'));
  roots.push(path);
  return path;
}

const source = { requestedRef: null, commitSha: 'a'.repeat(40), dirty: false };
const prerequisites = {
  playwright: { moduleSpecifier: '/tmp/playwright/index.mjs', version: '1.62.0', executablePath: '/tmp/chromium' },
  ffmpeg: 'ffmpeg version 6.1.1',
  ffprobe: 'ffprobe version 6.1.1',
};

function artifactDescription(format: string, frames: number) {
  return {
    width: 640,
    height: 480,
    frameCount: frames,
    durationSeconds: format === 'png' ? null : frames / 60,
    codec: format === 'mp4' ? 'h264' : format,
    pixelFormat: format === 'mp4' ? 'yuv420p' : format === 'gif' ? 'bgra' : 'rgba',
    averageFrameRate: format === 'png' ? null : 60,
    looping: format === 'gif' ? true : null,
    byteSize: 10,
    sha256: 'b'.repeat(64),
  };
}

function common(runProducer: any, extra: Record<string, any> = {}) {
  return {
    inspectSourceState: vi.fn(async () => source),
    inspectPrerequisites: vi.fn(async () => prerequisites),
    runProducer,
    describeArtifact: vi.fn(async (_path: string, format: string) => artifactDescription(format, format === 'png' ? 1 : 47)),
    ...extra,
  };
}

async function stillProducer(context: any) {
  const frame = join(context.outputDirectory, 'frame.png');
  await writeFile(frame, 'png');
  return {
    rawFrames: [frame],
    previewFile: null,
    chromiumVersion: '151.0.7922.34',
    report: {
      producer: {
        tickCount: 40,
        fixture: { seed: 7 },
        observedEvents: [{ type: 'fire', tick: 10 }],
        fixtureAssertions: [],
      },
    },
  };
}

async function temporalProducer(context: any) {
  const rawFrames: string[] = [];
  for (let index = 0; index < 47; index++) {
    const frame = join(context.outputDirectory, `frame-${String(index).padStart(4, '0')}.png`);
    await writeFile(frame, `frame ${index}`);
    rawFrames.push(frame);
  }
  const previewFile = join(context.outputDirectory, 'gallery.gif');
  await writeFile(previewFile, 'gif');
  return {
    rawFrames,
    previewFile,
    chromiumVersion: '151.0.7922.34',
    report: {
      producer: {
        tickCount: 47, fixture: { seed: 7 }, observedEvents: [], fixtureAssertions: [],
      },
    },
  };
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

  it('removes raw frames and partial output after an assertion failure', async () => {
    const checkout = await root();
    let workspace = '';
    const runProducer = vi.fn(async (context: any) => {
      workspace = dirname(context.outputDirectory);
      const result = await stillProducer(context);
      result.report.producer.observedEvents = [];
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

  it('does not publish a temporal directory until encoding and probing both succeed', async () => {
    const checkout = await root();
    const encodeMp4 = vi.fn(async ({ output }: { output: string }) => writeFile(output, 'mp4'));
    const result = await captureRecipe(CAPTURE_RECIPES[1], {
      root: checkout,
      out: 'artifacts/capture/temporal',
      retainFrames: false,
      sourceRef: null,
    }, common(temporalProducer, { encodeMp4 }));
    expect(encodeMp4).toHaveBeenCalledOnce();
    expect((await stat(join(result.output.absolute, 'capture.mp4'))).isFile()).toBe(true);
    expect((await stat(join(result.output.absolute, 'preview.gif'))).isFile()).toBe(true);
    expect((await stat(join(result.output.absolute, 'capture.json'))).isFile()).toBe(true);
  });
});
