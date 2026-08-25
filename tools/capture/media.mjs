import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { runProcess } from './process.mjs';

export const MEDIA_VALIDATION_TOLERANCES = Object.freeze({
  fpsAbsolute: 0.01,
  fpsRelative: 0.001,
  durationFrames: 0.5,
  gifCentiseconds: 1,
});

const GIF_PALETTE_FILTER = 'split[a][b];[a]palettegen=stats_mode=diff[p];'
  + '[b][p]paletteuse=dither=bayer:bayer_scale=3';

export function mp4Arguments({ fps, inputPattern, frameCount, output }) {
  return [
    '-y',
    '-framerate', String(fps),
    '-start_number', '0',
    '-i', inputPattern,
    '-frames:v', String(frameCount),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ];
}

export function gifArguments({ fps, inputPattern, frameCount, output }) {
  return [
    '-y',
    '-framerate', String(fps),
    '-start_number', '0',
    '-i', inputPattern,
    '-frames:v', String(frameCount),
    '-vf', GIF_PALETTE_FILTER,
    '-loop', '0',
    output,
  ];
}

async function encode(format, commandArgs, options, deps) {
  const run = deps.runProcess ?? runProcess;
  try {
    await run('ffmpeg', commandArgs, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    const label = format === 'mp4' ? 'H.264 MP4' : 'GIF preview';
    throw new Error(`${label} encoding failed: ${error.message}`, { cause: error });
  }
}

export function encodeMp4(options, deps = {}) {
  return encode('mp4', mp4Arguments(options), options, deps);
}

export function encodeGif(options, deps = {}) {
  return encode('gif', gifArguments(options), options, deps);
}

export function ffprobeArguments(file) {
  return [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries',
    'stream=codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration:format=duration,size',
    '-of', 'json',
    file,
  ];
}

function numeric(value) {
  if (value === undefined || value === null || value === 'N/A' || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rational(value) {
  if (typeof value !== 'string') return null;
  const [numerator, denominator = '1'] = value.split('/');
  const a = Number(numerator);
  const b = Number(denominator);
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;
}

export function parseProbeJson(text, { format } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON: ${error.message}`, { cause: error });
  }
  const stream = data.streams?.[0];
  if (!stream) throw new Error('ffprobe found no video stream');
  const duration = numeric(stream.duration) ?? numeric(data.format?.duration);
  const frameCount = numeric(stream.nb_read_frames) ?? numeric(stream.nb_frames)
    ?? (format === 'png' ? 1 : null);
  const averageFrameRate = rational(stream.avg_frame_rate) ?? rational(stream.r_frame_rate);
  return {
    format,
    width: numeric(stream.width),
    height: numeric(stream.height),
    frameCount,
    durationSeconds: duration,
    codec: stream.codec_name ?? null,
    pixelFormat: stream.pix_fmt ?? null,
    averageFrameRate,
  };
}

function readSubBlocks(buffer, start) {
  let offset = start;
  const chunks = [];
  for (;;) {
    if (offset >= buffer.length) throw new Error('GIF ended inside an extension block');
    const size = buffer[offset++];
    if (size === 0) return { offset, data: Buffer.concat(chunks) };
    if (offset + size > buffer.length) throw new Error('GIF extension block exceeds the file');
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
}

/** Inspect image delays and the NETSCAPE/ANIMEXTS loop extension from GIF bytes. */
export function inspectGifBuffer(buffer) {
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('invalid GIF signature');
  if (buffer.length < 13) throw new Error('GIF is shorter than its logical screen descriptor');
  const globalPacked = buffer[10];
  let offset = 13;
  if (globalPacked & 0x80) offset += 3 * (2 ** ((globalPacked & 0x07) + 1));

  let loopCount = null;
  let pendingDelay = 0;
  const delays = [];
  for (;;) {
    if (offset >= buffer.length) throw new Error('GIF has no trailer');
    const marker = buffer[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= buffer.length) throw new Error('GIF ended before an extension label');
      const label = buffer[offset++];
      if (label === 0xf9) {
        if (buffer[offset++] !== 4 || offset + 5 > buffer.length) {
          throw new Error('invalid GIF graphic-control extension');
        }
        pendingDelay = buffer.readUInt16LE(offset + 1);
        offset += 4;
        if (buffer[offset++] !== 0) throw new Error('invalid GIF graphic-control terminator');
        continue;
      }
      if (offset >= buffer.length) throw new Error('GIF ended inside an extension');
      const headerSize = buffer[offset++];
      if (offset + headerSize > buffer.length) throw new Error('GIF extension header exceeds the file');
      const header = buffer.subarray(offset, offset + headerSize);
      offset += headerSize;
      const blocks = readSubBlocks(buffer, offset);
      offset = blocks.offset;
      if (label === 0xff) {
        const application = header.toString('ascii');
        if (
          (application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0')
          && blocks.data.length >= 3
          && blocks.data[0] === 1
        ) {
          loopCount = blocks.data.readUInt16LE(1);
        }
      }
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 9 > buffer.length) throw new Error('GIF image descriptor exceeds the file');
      const packed = buffer[offset + 8];
      offset += 9;
      if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
      if (offset >= buffer.length) throw new Error('GIF image has no LZW code size');
      offset += 1;
      const imageData = readSubBlocks(buffer, offset);
      offset = imageData.offset;
      delays.push(pendingDelay);
      pendingDelay = 0;
      continue;
    }
    throw new Error(`unsupported GIF block marker 0x${marker.toString(16).padStart(2, '0')}`);
  }

  const totalCentiseconds = delays.reduce((sum, delay) => sum + delay, 0);
  return {
    loopExtensionPresent: loopCount !== null,
    loopCount,
    looping: loopCount === 0,
    frameCount: delays.length,
    displayedDurationSeconds: totalCentiseconds / 100,
    delayCentiseconds: {
      minimum: delays.length > 0 ? Math.min(...delays) : null,
      maximum: delays.length > 0 ? Math.max(...delays) : null,
      total: totalCentiseconds,
    },
    measuredBy: 'gif-block-parser',
  };
}

/** Inspect top-level ISO-BMFF boxes; faststart means `moov` precedes the first `mdat`. */
export function inspectMp4FaststartBuffer(buffer) {
  const boxes = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('MP4 ended inside a box header');
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > buffer.length) throw new Error(`MP4 ${type} box has no extended size`);
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`MP4 ${type} box is too large to inspect`);
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) size = buffer.length - offset;
    if (size < headerSize || offset + size > buffer.length) {
      throw new Error(`MP4 ${type} box has invalid size ${size}`);
    }
    boxes.push({ type, offset, size });
    offset += size;
  }
  const moov = boxes.find((box) => box.type === 'moov');
  const mdat = boxes.find((box) => box.type === 'mdat');
  if (!moov) throw new Error('MP4 has no top-level moov box');
  if (!mdat) throw new Error('MP4 has no top-level mdat box');
  return {
    faststart: moov.offset < mdat.offset,
    moovOffset: moov.offset,
    mdatOffset: mdat.offset,
    measuredBy: 'mp4-box-order',
  };
}

async function inspectContainer(file, format) {
  if (format === 'gif') return inspectGifBuffer(await readFile(file));
  if (format === 'mp4') return inspectMp4FaststartBuffer(await readFile(file));
  return null;
}

export async function probeMedia(file, format, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  let result;
  try {
    result = await run('ffprobe', ffprobeArguments(file), {
      timeoutMs: deps.timeoutMs ?? 30_000,
      signal: deps.signal,
    });
  } catch (error) {
    throw new Error(`media probing failed for ${basename(file)}: ${error.message}`, { cause: error });
  }
  return parseProbeJson(result.stdout, { format });
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function describeArtifact(file, format, deps = {}) {
  const [media, container, info, checksum] = await Promise.all([
    probeMedia(file, format, deps),
    inspectContainer(file, format),
    stat(file),
    sha256File(file),
  ]);
  return { ...media, container, byteSize: info.size, sha256: checksum };
}

function near(actual, expected, tolerance) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

/** Validate probed media against effective captured frames, returning manifest evidence. */
export function validateArtifact(recipe, artifact, expectedFrameCount) {
  const expectedWidth = Math.round(recipe.viewport.width * recipe.viewport.devicePixelRatio);
  const expectedHeight = Math.round(recipe.viewport.height * recipe.viewport.devicePixelRatio);
  if (artifact.width !== expectedWidth || artifact.height !== expectedHeight) {
    throw new Error(
      `${artifact.filename} is ${artifact.width}x${artifact.height}; expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  if (artifact.frameCount !== expectedFrameCount) {
    throw new Error(
      `${artifact.filename} has ${artifact.frameCount} frames; expected ${expectedFrameCount}`,
    );
  }
  if (artifact.format === 'png' && artifact.codec !== 'png') {
    throw new Error(`${artifact.filename} codec is ${artifact.codec}; expected png`);
  }

  const expectedDurationSeconds = recipe.schedule.kind === 'still'
    ? null
    : expectedFrameCount / recipe.playback.intendedFps;
  const expected = {
    width: expectedWidth,
    height: expectedHeight,
    frameCount: expectedFrameCount,
    durationSeconds: expectedDurationSeconds,
  };
  const tolerances = {};

  if (artifact.format === 'mp4') {
    if (artifact.codec !== 'h264') throw new Error(`${artifact.filename} codec is ${artifact.codec}; expected h264`);
    if (artifact.pixelFormat !== 'yuv420p') {
      throw new Error(`${artifact.filename} pixel format is ${artifact.pixelFormat}; expected yuv420p`);
    }
    const fpsTolerance = Math.max(
      MEDIA_VALIDATION_TOLERANCES.fpsAbsolute,
      recipe.playback.intendedFps * MEDIA_VALIDATION_TOLERANCES.fpsRelative,
    );
    if (!near(artifact.averageFrameRate, recipe.playback.intendedFps, fpsTolerance)) {
      throw new Error(
        `${artifact.filename} average frame rate is ${artifact.averageFrameRate}; expected `
          + `${recipe.playback.intendedFps} ± ${fpsTolerance} fps`,
      );
    }
    const durationTolerance = MEDIA_VALIDATION_TOLERANCES.durationFrames
      / recipe.playback.intendedFps;
    if (!near(artifact.durationSeconds, expectedDurationSeconds, durationTolerance)) {
      throw new Error(
        `${artifact.filename} duration is ${artifact.durationSeconds}s; expected `
          + `${expectedDurationSeconds}s ± ${durationTolerance}s for ${expectedFrameCount} frames`,
      );
    }
    const measuredFramesFromTiming = artifact.durationSeconds * artifact.averageFrameRate;
    if (Math.abs(measuredFramesFromTiming - expectedFrameCount) > MEDIA_VALIDATION_TOLERANCES.durationFrames) {
      throw new Error(
        `${artifact.filename} timing implies ${measuredFramesFromTiming} frames; probed frame count is `
          + `${expectedFrameCount} (tolerance ${MEDIA_VALIDATION_TOLERANCES.durationFrames} frame)`,
      );
    }
    if (artifact.container?.faststart !== true) {
      throw new Error(
        `${artifact.filename} is not fast-start: moov offset ${artifact.container?.moovOffset ?? 'missing'} `
          + `must precede mdat offset ${artifact.container?.mdatOffset ?? 'missing'}`,
      );
    }
    expected.averageFrameRate = recipe.playback.intendedFps;
    expected.faststart = true;
    tolerances.averageFrameRate = fpsTolerance;
    tolerances.durationSeconds = durationTolerance;
    tolerances.frameDurationConsistency = MEDIA_VALIDATION_TOLERANCES.durationFrames;
  }

  if (artifact.format === 'gif') {
    if (artifact.codec !== 'gif') throw new Error(`${artifact.filename} codec is ${artifact.codec}; expected gif`);
    if (artifact.container?.frameCount !== expectedFrameCount) {
      throw new Error(
        `${artifact.filename} GIF blocks contain ${artifact.container?.frameCount ?? 'unknown'} frames; `
          + `expected ${expectedFrameCount}`,
      );
    }
    if (artifact.container?.looping !== true || artifact.container?.loopCount !== 0) {
      throw new Error(
        `${artifact.filename} is not infinitely looping: expected a measured loop count of 0, got `
          + `${artifact.container?.loopCount ?? 'no loop extension'}`,
      );
    }
    const gifTolerance = MEDIA_VALIDATION_TOLERANCES.gifCentiseconds / 100;
    const displayedDuration = artifact.container.displayedDurationSeconds;
    if (!near(displayedDuration, expectedDurationSeconds, gifTolerance)) {
      throw new Error(
        `${artifact.filename} displayed duration is ${displayedDuration}s; expected `
          + `${expectedDurationSeconds}s ± ${gifTolerance}s after centisecond quantization`,
      );
    }
    if (!near(artifact.durationSeconds, displayedDuration, gifTolerance)) {
      throw new Error(
        `${artifact.filename} ffprobe duration ${artifact.durationSeconds}s disagrees with parsed GIF delays `
          + `${displayedDuration}s by more than ${gifTolerance}s`,
      );
    }
    expected.loopCount = 0;
    expected.displayedDurationSeconds = expectedDurationSeconds;
    tolerances.displayedDurationSeconds = gifTolerance;
    tolerances.ffprobeVsParsedDurationSeconds = gifTolerance;
  }

  return {
    status: 'passed',
    expected,
    tolerances,
    measuredBy: {
      stream: 'ffprobe',
      container: artifact.container?.measuredBy ?? null,
    },
  };
}

export async function describeRawFrames(files) {
  const rows = [];
  let byteSize = 0;
  for (const file of files) {
    const [info, sha256] = await Promise.all([stat(file), sha256File(file)]);
    byteSize += info.size;
    rows.push({ filename: basename(file), byteSize: info.size, sha256 });
  }
  const digest = createHash('sha256');
  for (const row of rows) digest.update(`${row.filename}\0${row.byteSize}\0${row.sha256}\n`);
  return { frameCount: rows.length, byteSize, sha256: digest.digest('hex') };
}
