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
  mp4Arguments,
  parseProbeJson,
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

describe('capture media utilities', () => {
  it('constructs a broadly compatible H.264 command without a shell', () => {
    const args = mp4Arguments({
      fps: 60,
      inputPattern: '/tmp/frames/frame-%04d.png',
      frameCount: 47,
      output: '/tmp/out/capture.mp4',
    });
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('+faststart');
    expect(args).toContain('/tmp/frames/frame-%04d.png');
    expect(args.at(-1)).toBe('/tmp/out/capture.mp4');
  });

  it('parses media dimensions, timing, codec, pixel format, and looping', () => {
    expect(parseProbeJson(probeJson, { format: 'mp4' })).toEqual({
      format: 'mp4',
      width: 640,
      height: 480,
      frameCount: 47,
      durationSeconds: 0.783333,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      averageFrameRate: 60,
      looping: null,
    });
    const gif = JSON.stringify({
      streams: [{ codec_name: 'gif', pix_fmt: 'bgra', width: 640, height: 480, nb_read_frames: '47' }],
      format: { duration: '0.790000' },
    });
    expect(parseProbeJson(gif, { format: 'gif', looping: true })).toMatchObject({
      codec: 'gif', frameCount: 47, durationSeconds: 0.79, looping: true,
    });
    expect(() => parseProbeJson('{bad json', { format: 'png' })).toThrow(/invalid JSON/);
    expect(() => parseProbeJson('{}', { format: 'png' })).toThrow(/no video stream/);
  });

  it('probes with ffprobe and records the real file checksum and byte size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-media-'));
    cleanup.push(root);
    const file = join(root, 'capture.mp4');
    await writeFile(file, 'fixture bytes');
    const runProcess = vi.fn(async () => ({ code: 0, stdout: probeJson, stderr: '' }));
    const described = await describeArtifact(file, 'mp4', { runProcess });
    expect(runProcess).toHaveBeenCalledWith('ffprobe', ffprobeArguments(file), { timeoutMs: 30_000 });
    expect(described).toMatchObject({
      width: 640,
      height: 480,
      frameCount: 47,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      byteSize: 13,
      sha256: createHash('sha256').update('fixture bytes').digest('hex'),
    });
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
      chromiumVersion: '151.0.7922.34',
      report: {
        producer: {
          tickCount: temporal ? 47 : 40,
          fixture: { seed: 7 },
          observedEvents: temporal ? [] : [{ type: 'fire', tick: 10 }],
          fixtureAssertions: temporal ? [] : [{ kind: 'event-at-tick', passed: true }],
        },
      },
    },
    prerequisites: {
      playwright: { version: '1.62.0' },
      ffmpeg: 'ffmpeg version 6.1.1',
      ffprobe: 'ffprobe version 6.1.1',
    },
    assertions: [{ kind: 'no-unexpected-events', passed: true }],
    artifacts,
    rawFrames: null,
    startedAt: '2026-08-25T12:00:00.000Z',
    completedAt: '2026-08-25T12:00:01.000Z',
  };
}

describe('capture manifest construction', () => {
  it('constructs the still manifest with relative artifacts and complete provenance', () => {
    const artifact = {
      filename: 'capture.png', format: 'png', width: 640, height: 480, frameCount: 1,
      durationSeconds: null, codec: 'png', pixelFormat: 'rgba', averageFrameRate: null,
      looping: null, byteSize: 100, sha256: 'b'.repeat(64),
    };
    const manifest = buildManifest(manifestInput(0, [artifact]));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      status: 'success',
      recipe: { id: 'gallery.fire.still', version: 1 },
      source: { requestedRef: 'HEAD', commitSha: 'a'.repeat(40), dirty: false },
      producer: {
        kind: 'moment', scenarioId: 'fire', fixture: { id: 'gallery.fire', seed: 7 },
        observedEvents: [{ type: 'fire', tick: 10 }],
      },
      capture: { schedule: { kind: 'still', tick: 10, frameCount: 1 } },
      playback: { sourceOfTruth: 'capture.png', effective: null },
      tools: { node: process.version, playwright: '1.62.0', chromium: '151.0.7922.34' },
      outputs: { files: [artifact], totalByteSize: 100, withinBudget: true },
    });
    expect(JSON.stringify(manifest)).not.toContain('/machine/tmp');
  });

  it('constructs temporal playback metadata and identifies MP4 as timing truth', () => {
    const mp4 = {
      filename: 'capture.mp4', format: 'mp4', width: 640, height: 480, frameCount: 47,
      durationSeconds: 0.783333, codec: 'h264', pixelFormat: 'yuv420p', averageFrameRate: 60,
      looping: null, byteSize: 1_000, sha256: 'c'.repeat(64),
    };
    const gif = {
      filename: 'preview.gif', format: 'gif', width: 640, height: 480, frameCount: 47,
      durationSeconds: 0.79, codec: 'gif', pixelFormat: 'bgra', averageFrameRate: 60,
      looping: true, byteSize: 2_000, sha256: 'd'.repeat(64),
    };
    const manifest = buildManifest(manifestInput(1, [mp4, gif]));
    expect(manifest.capture.schedule).toEqual({
      kind: 'ticks', startTick: 0, endTickExclusive: 47, step: 1, subdivisions: 1,
      tickRate: 60, frameCount: 47,
    });
    expect(manifest.playback).toMatchObject({
      intendedFps: 60,
      intendedDurationSeconds: 47 / 60,
      sourceOfTruth: 'capture.mp4',
      effective: {
        mp4: { averageFrameRate: 60, durationSeconds: 0.783333, playbackRate: 1 },
        gif: { durationSeconds: 0.79, displayedPlaybackRate: 47 / 0.79 / 60 },
      },
    });
    expect(manifest.playback.effective.gif.timingNote).toMatch(/not exact 60 fps/);
    expect(manifest.outputs.totalByteSize).toBe(3_000);
    expect(manifest.determinism.encodedByteEqualityAcrossEnvironments).toBe(false);
  });
});
