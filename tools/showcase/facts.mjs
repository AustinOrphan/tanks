import { inspectGifBuffer } from '../capture/media.mjs';

/**
 * The facts the showcase rules judge, measured from a GIF's bytes with no FFmpeg. Frames, delays
 * and the loop count come from the capture pipeline's own block parser; the width and height are
 * the logical screen size, the two little-endian 16-bit values at bytes 6 to 9 of the header.
 * Throws on bytes that are not a whole GIF, so a truncated file is never measured as zeros.
 */
export function gifFacts(buffer) {
  // Parse first: it rejects a bad signature and a file too short to hold the header read below.
  const inspected = inspectGifBuffer(buffer);
  return {
    bytes: buffer.length,
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
    frameCount: inspected.frameCount,
    durationCentiseconds: inspected.delayCentiseconds.total,
    loopCount: inspected.loopCount,
  };
}
