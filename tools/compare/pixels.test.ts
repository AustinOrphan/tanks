import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain-node ESM module, no types
import { readPngSize, comparePixels, summariseFrames, decodeRgba } from './pixels.mjs';

/** A PNG header with the given dimensions; enough for readPngSize, which reads only IHDR. */
function pngHeader(width: number, height: number, { signature = true, type = 'IHDR' } = {}) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  if (!signature) buffer[1] = 0x00;
  buffer.writeUInt32BE(13, 8);
  buffer.write(type, 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function frame(width: number, height: number, fill: number[]) {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 4; channel++) data[offset + channel] = fill[channel];
  }
  return { width, height, data };
}

describe('readPngSize', () => {
  it('reads width and height out of the IHDR', () => {
    expect(readPngSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
    // Non-square, so a width/height transposition cannot pass.
    expect(readPngSize(pngHeader(200, 150))).toEqual({ width: 200, height: 150 });
  });

  it.each([
    ['a non-PNG', pngHeader(1, 1, { signature: false }), /not a PNG file/],
    ['a PNG whose first chunk is not IHDR', pngHeader(1, 1, { type: 'sRGB' }), /IHDR/],
    ['a truncated header', pngHeader(1, 1).subarray(0, 20), /not a PNG file/],
    ['a zero-sized image', pngHeader(0, 10), /empty 0x10 image/],
  ])('refuses %s', (_label, buffer, message) => {
    expect(() => readPngSize(buffer as Buffer)).toThrow(message as RegExp);
  });
});

describe('comparePixels', () => {
  it('reports identical frames as identical, which is valid evidence', () => {
    const result = comparePixels(frame(4, 4, [10, 20, 30, 255]), frame(4, 4, [10, 20, 30, 255]));
    expect(result).toMatchObject({ changedPixels: 0, changedFraction: 0, maxChannelDelta: 0, identical: true });
    expect(result.totalPixels).toBe(16);
  });

  it('counts a pixel once however many of its channels moved', () => {
    // Otherwise "changed pixels" silently means "changed channels" and reads 4x high.
    const base = frame(2, 1, [0, 0, 0, 255]);
    const head = frame(2, 1, [0, 0, 0, 255]);
    head.data[0] = 9; head.data[1] = 9; head.data[2] = 9; // three channels of pixel 0
    const result = comparePixels(base, head);
    expect(result.changedPixels).toBe(1);
    expect(result.totalPixels).toBe(2);
    expect(result.changedFraction).toBe(0.5);
  });

  it('separates a big change in few pixels from a small change everywhere', () => {
    // The distinction a reviewer actually needs: antialiasing noise and a moved object
    // look the same in a bare changed-pixel count.
    const base = frame(10, 10, [0, 0, 0, 255]);
    const spike = frame(10, 10, [0, 0, 0, 255]);
    spike.data[0] = 255;
    const drift = frame(10, 10, [1, 1, 1, 255]);

    const spiky = comparePixels(base, spike);
    const drifty = comparePixels(base, drift);
    expect(spiky.changedPixels).toBe(1);
    expect(spiky.maxChannelDelta).toBe(255);
    expect(drifty.changedPixels).toBe(100);
    expect(drifty.maxChannelDelta).toBe(1);
    // The two are ordered oppositely on the two statistics, which is the point of
    // reporting both.
    expect(spiky.changedPixels).toBeLessThan(drifty.changedPixels);
    expect(spiky.maxChannelDelta).toBeGreaterThan(drifty.maxChannelDelta);
  });

  it('refuses mismatched dimensions rather than cropping to fit', () => {
    // Cropping or padding would turn "these are not comparable" into a difference image,
    // which is the specific dishonesty the issue rules out.
    expect(() => comparePixels(frame(4, 4, [0, 0, 0, 0]), frame(4, 5, [0, 0, 0, 0])))
      .toThrow(/dimensions differ: base 4x4, head 4x5/);
  });

  it('refuses a byte length that disagrees with the dimensions', () => {
    const base = frame(4, 4, [0, 0, 0, 0]);
    const head = frame(4, 4, [0, 0, 0, 0]);
    head.data = head.data.subarray(0, 32);
    expect(() => comparePixels(base, head)).toThrow(/byte lengths differ/);
  });
});

describe('summariseFrames', () => {
  const same = { identical: true, changedPixels: 0, maxChannelDelta: 0 };
  const moved = { identical: false, changedPixels: 12, maxChannelDelta: 40 };

  it('summarises an all-identical clip as identical, not as a failure', () => {
    const summary = summariseFrames([same, same, same]);
    expect(summary).toMatchObject({ frameCount: 3, changedFrameCount: 0, identical: true, firstChangedFrame: null });
  });

  it('reports where the change starts, not just that there was one', () => {
    // "Frame 2 is where they diverge" is the reviewable fact; a bare count is not.
    const summary = summariseFrames([same, same, moved, same]);
    expect(summary).toMatchObject({
      frameCount: 4, changedFrameCount: 1, firstChangedFrame: 2, identical: false,
      maxChangedPixels: 12, maxChannelDelta: 40,
    });
  });
});

describe('decodeRgba', () => {
  const png = pngHeader(2, 3);

  function fakeDeps(rawBytes: number, calls: string[][] = []) {
    return {
      calls,
      readFile: async (path: string) => (path.endsWith('.png') ? png : Buffer.alloc(rawBytes)),
      runProcess: async (command: string, args: string[]) => { calls.push([command, ...args]); return { stdout: '' }; },
    };
  }

  it('asks FFmpeg for rawvideo/rgba into a FILE, never a pipe', async () => {
    const deps = fakeDeps(2 * 3 * 4);
    const result = await decodeRgba('/w/base.png', '/w/base.raw', deps);
    expect(result).toMatchObject({ width: 2, height: 3 });
    const [, ...args] = deps.calls[0];
    expect(args).toContain('rawvideo');
    expect(args).toContain('rgba');
    // The destination is the path, not '-': capture's runProcess decodes stdout as utf8
    // and would corrupt every binary byte.
    expect(args[args.length - 1]).toBe('/w/base.raw');
    expect(args).not.toContain('-');
  });

  it('refuses a decode whose byte count disagrees with the PNG header', async () => {
    // A truncated raw file or a substituted pix_fmt would otherwise be compared against a
    // differently laid out buffer and reported as an enormous pixel difference.
    await expect(decodeRgba('/w/base.png', '/w/base.raw', fakeDeps(10)))
      .rejects.toThrow(/decoded \/w\/base\.png to 10 bytes, expected 24 for 2x3 RGBA/);
  });
});
