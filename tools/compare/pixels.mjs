/**
 * Raw-frame comparison: the part of a before/after that is a measurement rather than a
 * picture.
 *
 * COMPARISON HAPPENS ON RAW FRAMES, BEFORE ENCODING, and that ordering is the whole point.
 * PNG, GIF and MP4 bytes are not promised to be stable across FFmpeg builds or operating
 * systems (see tools/capture/README.md's determinism boundary), so comparing encoded files
 * would report differences that are entirely the encoder's. Comparing the decoded pixels
 * measures what the renderer actually drew.
 *
 * The decode step shells out to FFmpeg and writes to a FILE rather than a pipe: capture's
 * `runProcess` decodes stdout as utf8, which would quietly corrupt binary. Everything below
 * the decode is pure and testable without FFmpeg installed.
 */
import { readFile } from 'node:fs/promises';
import { runProcess } from '../capture/process.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read a PNG's dimensions straight out of its IHDR.
 *
 * Deliberately not ffprobe: the dimensions are needed to CHECK the decoded byte length, so
 * taking them from the same tool that produced those bytes would make the check agree with
 * itself. The header is a fixed layout -- 8-byte signature, 4-byte length, 4-byte type,
 * then width and height as big-endian uint32.
 */
export function readPngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('PNG does not begin with an IHDR chunk');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error(`PNG reports an empty ${width}x${height} image`);
  return { width, height };
}

/**
 * Decode one PNG to RGBA bytes on disk, and prove the result is the size it should be.
 *
 * The length check is not ceremony: a partially-written raw file, or a pix_fmt FFmpeg
 * silently substituted, would otherwise be compared byte-for-byte against a differently
 * laid out buffer and reported as a huge pixel difference.
 */
export async function decodeRgba(pngPath, rawPath, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const png = await (deps.readFile ?? readFile)(pngPath);
  const { width, height } = readPngSize(png);
  await run(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', pngPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', rawPath],
    { timeoutMs: 60_000, signal: deps.signal },
  );
  const data = await (deps.readFile ?? readFile)(rawPath);
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new Error(`decoded ${pngPath} to ${data.length} bytes, expected ${expected} for ${width}x${height} RGBA`);
  }
  return { width, height, data };
}

/**
 * Compare two decoded frames.
 *
 * A pixel counts as changed when ANY of its four channels differs. `maxChannelDelta`
 * separates "a few pixels moved a lot" from "everything shifted by one" -- antialiasing
 * noise and a moved object look identical in a bare changed-pixel count, and a reviewer
 * needs to tell them apart.
 *
 * Mismatched dimensions are the caller's problem to refuse, not something to paper over by
 * cropping: a comparison of differently sized frames is not a comparison.
 */
export function comparePixels(base, head) {
  if (base.width !== head.width || base.height !== head.height) {
    throw new Error(
      `frame dimensions differ: base ${base.width}x${base.height}, head ${head.width}x${head.height}`,
    );
  }
  if (base.data.length !== head.data.length) {
    throw new Error(`frame byte lengths differ: base ${base.data.length}, head ${head.data.length}`);
  }
  const totalPixels = base.width * base.height;
  let changedPixels = 0;
  let maxChannelDelta = 0;
  let totalChannelDelta = 0;
  for (let offset = 0; offset < base.data.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(base.data[offset + channel] - head.data[offset + channel]);
      if (delta !== 0) {
        changed = true;
        totalChannelDelta += delta;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
      }
    }
    if (changed) changedPixels++;
  }
  return {
    width: base.width,
    height: base.height,
    totalPixels,
    changedPixels,
    changedFraction: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    maxChannelDelta,
    meanChannelDelta: totalPixels === 0 ? 0 : totalChannelDelta / (totalPixels * 4),
    identical: changedPixels === 0,
  };
}

/**
 * Roll per-frame comparisons up into one verdict for a temporal capture.
 *
 * `identical` is a legitimate, reportable outcome -- a change that was expected to move
 * pixels and did not is a real finding, not a tool failure -- so it is summarised rather
 * than treated as an error anywhere in this pipeline.
 */
export function summariseFrames(frames) {
  const changed = frames.filter((frame) => !frame.identical);
  return {
    frameCount: frames.length,
    changedFrameCount: changed.length,
    firstChangedFrame: changed.length > 0 ? frames.indexOf(changed[0]) : null,
    maxChangedPixels: frames.reduce((most, frame) => Math.max(most, frame.changedPixels), 0),
    maxChannelDelta: frames.reduce((most, frame) => Math.max(most, frame.maxChannelDelta), 0),
    identical: changed.length === 0,
    frames,
  };
}
