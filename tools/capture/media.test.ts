import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { buildManifest } from './manifest.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import {
  describeArtifact,
  ffprobeArguments,
  gifArguments,
  inspectGifBuffer,
  inspectMp4FaststartBuffer,
  mp4Arguments,
  parseProbeJson,
  validateArtifact,
} from './media.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES } from './registry.mjs';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const probeJson = JSON.stringify({
  streams: [{
    codec_name: 'h264',
    pix_fmt: 'yuv420p',
    width: 640,
    height: 480,
    avg_frame_rate: '60/1',
    r_frame_rate: '60/1',
    nb_frames: '47',
    nb_read_frames: '47',
    duration: '0.783333',
  }],
  format: { duration: '0.783333', size: '1234' },
});

function mp4Box(type: string, payload = Buffer.alloc(0)): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function mp4Buffer(faststart: boolean): Buffer {
  const ftyp = mp4Box('ftyp');
  const moov = mp4Box('moov');
  const mdat = mp4Box('mdat');
  return Buffer.concat(faststart ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}

function gifBuffer(delays: number[], loopCount: number | null): Buffer {
  const header = Buffer.from('GIF89a', 'ascii');
  const logicalScreen = Buffer.from([
    0x01, 0x00, 0x01, 0x00, // 1x1
    0x80, 0x00, 0x00, // global colour table, background, aspect
  ]);
  const colourTable = Buffer.from([0, 0, 0, 255, 255, 255]);
  const loop = loopCount === null ? Buffer.alloc(0) : Buffer.from([
    0x21, 0xff, 0x0b,
    ...Buffer.from('NETSCAPE2.0', 'ascii'),
    0x03, 0x01, loopCount & 0xff, (loopCount >> 8) & 0xff, 0x00,
  ]);
  const frames = delays.map((delay) => Buffer.from([
    0x21, 0xf9, 0x04, 0x00, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00,
    0x2c,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
  ]));
  return Buffer.concat([header, logicalScreen, colourTable, loop, ...frames, Buffer.from([0x3b])]);
}

function mp4Artifact(overrides: Record<string, any> = {}) {
  return {
    filename: 'capture.mp4',
    format: 'mp4',
    width: 640,
    height: 480,
    frameCount: 47,
    durationSeconds: 0.783333,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    averageFrameRate: 60,
    container: { faststart: true, moovOffset: 8, mdatOffset: 16, measuredBy: 'mp4-box-order' },
    byteSize: 1_000,
    sha256: 'c'.repeat(64),
    construction: { method: 'ffmpeg', faststartRequested: true },
    ...overrides,
  };
}

function gifArtifact(overrides: Record<string, any> = {}) {
  return {
    filename: 'preview.gif',
    format: 'gif',
    width: 640,
    height: 480,
    frameCount: 47,
    durationSeconds: 0.79,
    codec: 'gif',
    pixelFormat: 'bgra',
    averageFrameRate: 100,
    container: {
      loopExtensionPresent: true,
      loopCount: 0,
      looping: true,
      frameCount: 47,
      displayedDurationSeconds: 0.79,
      delayCentiseconds: { minimum: 1, maximum: 2, total: 79 },
      measuredBy: 'gif-block-parser',
    },
    byteSize: 2_000,
    sha256: 'd'.repeat(64),
    construction: { method: 'ffmpeg', infiniteLoopRequested: true },
    ...overrides,
  };
}

describe('capture media utilities', () => {
  it('constructs shared H.264 and GIF commands without a shell', () => {
    const options = {
      fps: 60,
      inputPattern: '/tmp/frames/frame-%04d.png',
      frameCount: 47,
      output: '/tmp/out/capture.mp4',
    };
    const mp4 = mp4Arguments(options);
    expect(mp4).toContain('libx264');
    expect(mp4).toContain('yuv420p');
    expect(mp4).toContain('+faststart');
    expect(mp4).toContain('/tmp/frames/frame-%04d.png');
    expect(mp4.at(-1)).toBe('/tmp/out/capture.mp4');

    const gif = gifArguments({ ...options, output: '/tmp/out/preview.gif' });
    expect(gif.join(' ')).toContain('palettegen=stats_mode=diff');
    expect(gif.join(' ')).toContain('paletteuse=dither=bayer:bayer_scale=3');
    expect(gif.slice(-3)).toEqual(['-loop', '0', '/tmp/out/preview.gif']);
  });

  it('parses stream dimensions, timing, codec, and pixel format without inventing container facts', () => {
    expect(parseProbeJson(probeJson, { format: 'mp4' })).toEqual({
      format: 'mp4',
      width: 640,
      height: 480,
      frameCount: 47,
      durationSeconds: 0.783333,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      averageFrameRate: 60,
    });
    expect(() => parseProbeJson('{bad json', { format: 'png' })).toThrow(/invalid JSON/);
    expect(() => parseProbeJson('{}', { format: 'png' })).toThrow(/no video stream/);
  });

  it('measures GIF frame delays and loop metadata from the file', () => {
    expect(inspectGifBuffer(gifBuffer([2, 1, 2], 0))).toMatchObject({
      loopExtensionPresent: true,
      loopCount: 0,
      looping: true,
      frameCount: 3,
      displayedDurationSeconds: 0.05,
      delayCentiseconds: { minimum: 1, maximum: 2, total: 5 },
    });
    expect(inspectGifBuffer(gifBuffer([2], null))).toMatchObject({
      loopExtensionPresent: false, loopCount: null, looping: false,
    });
  });

  it('measures MP4 faststart from top-level box ordering', () => {
    expect(inspectMp4FaststartBuffer(mp4Buffer(true))).toMatchObject({
      faststart: true, moovOffset: 8, mdatOffset: 16,
    });
    expect(inspectMp4FaststartBuffer(mp4Buffer(false))).toMatchObject({
      faststart: false, moovOffset: 16, mdatOffset: 8,
    });
  });

  it('probes media and records measured container facts, checksum, and byte size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-media-'));
    cleanup.push(root);
    const file = join(root, 'capture.mp4');
    const bytes = mp4Buffer(true);
    await writeFile(file, bytes);
    const runProcess = vi.fn(async () => ({ code: 0, stdout: probeJson, stderr: '' }));
    const described = await describeArtifact(file, 'mp4', { runProcess });
    expect(runProcess).toHaveBeenCalledWith('ffprobe', ffprobeArguments(file), {
      timeoutMs: 30_000,
      signal: undefined,
    });
    expect(described).toMatchObject({
      width: 640,
      height: 480,
      frameCount: 47,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      container: { faststart: true, measuredBy: 'mp4-box-order' },
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
});

describe('capture media validation', () => {
  it('accepts measured MP4 and GIF timing within explicit tolerances', () => {
    expect(validateArtifact(CAPTURE_RECIPES[1].recipe, mp4Artifact(), 47)).toMatchObject({
      status: 'passed',
      expected: { averageFrameRate: 60, durationSeconds: 47 / 60, faststart: true },
      measuredBy: { stream: 'ffprobe', container: 'mp4-box-order' },
    });
    expect(validateArtifact(CAPTURE_RECIPES[1].recipe, gifArtifact(), 47)).toMatchObject({
      status: 'passed',
      expected: { loopCount: 0, displayedDurationSeconds: 47 / 60 },
      tolerances: { displayedDurationSeconds: 0.01 },
      measuredBy: { container: 'gif-block-parser' },
    });
  });

  it.each([
    ['incorrect FPS', mp4Artifact({ averageFrameRate: 30 }), /average frame rate.*expected 60/],
    ['incorrect duration', mp4Artifact({ durationSeconds: 1 }), /duration.*expected/],
    ['incorrect frame count', mp4Artifact({ frameCount: 46 }), /46 frames.*expected 47/],
    [
      'inconsistent frame count and measured timing',
      mp4Artifact({ averageFrameRate: 60.059, durationSeconds: 0.7915 }),
      /timing implies.*probed frame count.*tolerance 0\.5 frame/,
    ],
    [
      'non-faststart MP4',
      mp4Artifact({ container: { faststart: false, moovOffset: 900, mdatOffset: 32, measuredBy: 'mp4-box-order' } }),
      /not fast-start.*moov offset 900.*mdat offset 32/,
    ],
  ])('rejects %s', (_name, artifact, pattern) => {
    expect(() => validateArtifact(CAPTURE_RECIPES[1].recipe, artifact, 47)).toThrow(pattern as RegExp);
  });

  it.each([
    [
      'incorrect GIF block frame count',
      gifArtifact({ container: { ...gifArtifact().container, frameCount: 46 } }),
      /GIF blocks contain 46 frames.*expected 47/,
    ],
    [
      'incorrect GIF displayed timing',
      gifArtifact({ container: { ...gifArtifact().container, displayedDurationSeconds: 0.9 } }),
      /displayed duration.*expected/,
    ],
    [
      'ffprobe/GIF delay disagreement',
      gifArtifact({ durationSeconds: 0.95 }),
      /ffprobe duration.*disagrees with parsed GIF delays/,
    ],
    [
      'non-looping GIF',
      gifArtifact({
        container: {
          ...gifArtifact().container,
          loopExtensionPresent: false,
          loopCount: null,
          looping: false,
        },
      }),
      /not infinitely looping.*no loop extension/,
    ],
  ])('rejects %s', (_name, artifact, pattern) => {
    expect(() => validateArtifact(CAPTURE_RECIPES[1].recipe, artifact, 47)).toThrow(pattern as RegExp);
  });
});

function manifestInput(index: number, artifacts: any[]) {
  const entry = CAPTURE_RECIPES[index];
  const temporal = entry.recipe.schedule.kind === 'ticks';
  const frameCount = temporal ? 47 : 1;
  return {
    entry,
    source: { requestedRef: 'HEAD', commitSha: 'a'.repeat(40), dirty: false },
    producerResult: {
      rawFrames: Array.from({ length: frameCount }, (_, i) => `/machine/tmp/frame-${i}.png`),
      capture: {
        viewport: entry.recipe.viewport,
        frameSchedule: temporal
          ? { kind: 'frames', frameCount: 47 }
          : { kind: 'still', frameCount: 1 },
      },
      assertions: [{ kind: 'producer-ready', passed: true, diagnostic: null, details: {} }],
      metadata: temporal ? null : {
        moment: {
          fixture: { id: 'gallery.fire', seed: 7 },
          tickSchedule: { kind: 'still', tick: 10, alpha: 0, frameCount: 1 },
          observedEvents: [{ type: 'fire', tick: 10 }],
          fixtureAssertions: [{ kind: 'event-at-tick', passed: true }],
        },
      },
      toolVersions: { chromium: '151.0.7922.34' },
      diagnostics: [],
    },
    prerequisites: {
      playwright: { version: '1.62.0' },
      ffmpeg: 'ffmpeg version 6.1.1',
      ffprobe: 'ffprobe version 6.1.1',
    },
    artifacts,
    rawFrames: null,
    startedAt: '2026-08-25T12:00:00.000Z',
    completedAt: '2026-08-25T12:00:01.000Z',
  };
}

describe('capture manifest construction', () => {
  it('constructs the still manifest with separated producer metadata and no machine paths', () => {
    const artifact = {
      filename: 'capture.png', format: 'png', width: 640, height: 480, frameCount: 1,
      durationSeconds: null, codec: 'png', pixelFormat: 'rgba', averageFrameRate: null,
      container: null, byteSize: 100, sha256: 'b'.repeat(64),
      construction: { method: 'captured-frame-copy' },
      verification: { status: 'passed' },
    };
    const manifest = buildManifest(manifestInput(0, [artifact]));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      status: 'success',
      recipe: { id: 'gallery.fire.still', version: 1 },
      source: { requestedRef: 'HEAD', commitSha: 'a'.repeat(40), dirty: false },
      producer: {
        kind: 'moment',
        scenarioId: 'fire',
        requestedInputs: { fixture: { id: 'gallery.fire', seed: 7 } },
        metadata: { moment: { observedEvents: [{ type: 'fire', tick: 10 }] } },
      },
      capture: { frameSchedule: { kind: 'still', frameCount: 1 } },
      playback: { sourceOfTruth: 'capture.png', effective: null },
      tools: {
        node: process.version,
        playwright: '1.62.0',
        producer: { chromium: '151.0.7922.34' },
      },
      outputs: { files: [artifact], totalByteSize: 100, withinBudget: true },
    });
    expect(JSON.stringify(manifest)).not.toContain('/machine/tmp');
  });

  it('constructs generic temporal playback metadata and identifies MP4 as timing truth', () => {
    const mp4 = mp4Artifact();
    const gif = gifArtifact();
    const manifest = buildManifest(manifestInput(1, [mp4, gif]));
    expect(manifest.capture.frameSchedule).toEqual({ kind: 'frames', frameCount: 47 });
    expect(manifest.playback).toMatchObject({
      intendedFps: 60,
      intendedDurationSeconds: 47 / 60,
      sourceOfTruth: 'capture.mp4',
      effective: {
        mp4: { averageFrameRate: 60, durationSeconds: 0.783333, playbackRate: 1, faststart: true },
        gif: {
          displayedAverageFrameRate: 47 / 0.79,
          durationSeconds: 0.79,
          displayedPlaybackRate: 47 / 0.79 / 60,
          loopCount: 0,
          looping: true,
        },
      },
    });
    expect(manifest.playback.effective.gif.timingNote).toMatch(/measured in centiseconds/);
    expect(manifest.outputs.totalByteSize).toBe(3_000);
    expect(manifest.determinism.encodedByteEqualityAcrossEnvironments).toBe(false);
  });
});
