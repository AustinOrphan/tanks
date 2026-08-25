import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { runProcess } from './process.mjs';

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

export async function encodeMp4(options, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  try {
    await run('ffmpeg', mp4Arguments(options), {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw new Error(`H.264 MP4 encoding failed: ${error.message}`, { cause: error });
  }
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

export function parseProbeJson(text, { format, looping = null } = {}) {
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
    looping,
  };
}

export async function probeMedia(file, format, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  let result;
  try {
    result = await run('ffprobe', ffprobeArguments(file), { timeoutMs: deps.timeoutMs ?? 30_000 });
  } catch (error) {
    throw new Error(`media probing failed for ${basename(file)}: ${error.message}`, { cause: error });
  }
  return parseProbeJson(result.stdout, { format, looping: format === 'gif' ? true : null });
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
  const [media, info, checksum] = await Promise.all([
    probeMedia(file, format, deps),
    stat(file),
    sha256File(file),
  ]);
  return { ...media, byteSize: info.size, sha256: checksum };
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
