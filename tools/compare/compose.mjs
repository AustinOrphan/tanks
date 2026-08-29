/**
 * Turning two captures into reviewable evidence.
 *
 * Every output here is assembled from the RAW frames both captures retained, never from
 * their encoded artifacts. Re-encoding an MP4 to stack it beside another would put two
 * generations of lossy compression between the reviewer and the renderer, and the
 * difference image would then partly show the encoder.
 *
 * ONE RULE GOVERNS ALL OF IT: nothing may freeze, pad, retime, or crop one side to make the
 * two fit. If they do not fit, that is the finding, and the caller refuses. A comparison
 * that silently stretched one side to match would look exactly like a successful one.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runProcess } from '../capture/process.mjs';

/**
 * Label text goes through a FILE, not through the filter string.
 *
 * A label carries a user-supplied ref name, and drawtext's own syntax gives `:`, `\`, `'`
 * and `%` meaning. Escaping them correctly for the nested filtergraph parser is a known
 * source of bugs and, with an attacker-chosen ref, of injected filter options. `textfile=`
 * sidesteps the entire class: the bytes are read as text and never parsed as syntax.
 */
async function writeLabel(directory, name, text) {
  const path = resolve(directory, `${name}.label.txt`);
  await writeFile(path, text, 'utf8');
  return path;
}

export const LABEL_FONT_SIZE = 18;
/** x offset on both sides plus the box border, in pixels. */
const LABEL_PADDING = 12 * 2 + 8 * 2;
/**
 * Upper bound on Sans's average advance as a fraction of font size.
 *
 * MEASURED, not assumed: at size 18 in a 320px panel a 40-character caption rendered about
 * 36 characters before running off the edge, i.e. ~0.46. 0.55 keeps a margin over that for
 * a caption that happens to be full of wide glyphs.
 */
const AVERAGE_ADVANCE_RATIO = 0.55;

/**
 * Build a caption that fits its panel, putting the SHA where truncation cannot reach it.
 *
 * The first attempt read `head  <ref> (<sha>)` and a long branch name pushed the SHA off
 * the right edge -- the caption still looked plausible, while having dropped the only part
 * that identifies which commit the reader is looking at. Side and SHA come first for that
 * reason, and the ref, which is the expendable part, is what gets an ellipsis.
 */
export function fitLabel(side, sha, ref, panelWidth, fontSize = LABEL_FONT_SIZE) {
  const prefix = `${side}  ${sha.slice(0, 7)}  `;
  const budget = Math.max(prefix.length, Math.floor((panelWidth - LABEL_PADDING) / (fontSize * AVERAGE_ADVANCE_RATIO)));
  const room = budget - prefix.length;
  if (room <= 3) return prefix.trimEnd();
  return prefix + (ref.length <= room ? ref : `${ref.slice(0, room - 3)}...`);
}

/**
 * A readable caption over any background.
 *
 * `font=Sans` resolves through fontconfig rather than naming a font FILE: a hardcoded path
 * is the thing that differs between this box and a CI runner. The dark box behind the text
 * is what makes the label legible over both the pale felt floor and a dark tank.
 */
function drawtext(textfilePath) {
  return [
    'drawtext=',
    `textfile='${textfilePath}'`,
    ':font=Sans',
    ':fontcolor=white',
    `:fontsize=${LABEL_FONT_SIZE}`,
    ':box=1:boxcolor=black@0.6:boxborderw=8',
    ':x=12:y=12',
  ].join('');
}

async function ffmpeg(args, deps) {
  const run = deps.runProcess ?? runProcess;
  return run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    timeoutMs: deps.timeoutMs ?? 300_000,
    signal: deps.signal,
  });
}

/**
 * Still comparison: two labelled frames, the pair side by side, and their difference.
 *
 * The difference image uses `blend=all_mode=difference`, so an unchanged region is black
 * and anything that moved glows. It is deliberately NOT amplified or thresholded -- a
 * normalised difference makes a one-channel rounding wobble look like a redesign, and the
 * changed-pixel statistics in compare.json are the quantitative half anyway.
 */
export async function composeStill({ basePng, headPng, baseLabel, headLabel, outDir, workspace }, deps = {}) {
  const baseText = await writeLabel(workspace, 'base', baseLabel);
  const headText = await writeLabel(workspace, 'head', headLabel);
  const labelledBase = resolve(outDir, 'base.png');
  const labelledHead = resolve(outDir, 'head.png');
  const sideBySide = resolve(outDir, 'side-by-side.png');
  const difference = resolve(outDir, 'difference.png');

  await ffmpeg(['-i', basePng, '-vf', drawtext(baseText), labelledBase], deps);
  await ffmpeg(['-i', headPng, '-vf', drawtext(headText), labelledHead], deps);
  // Stacked from the LABELLED frames, so the halves of the pair stay identifiable if the
  // file is cropped or pasted into a review comment.
  await ffmpeg(['-i', labelledBase, '-i', labelledHead, '-filter_complex', '[0:v][1:v]hstack=inputs=2', sideBySide], deps);
  // Differenced from the UNLABELLED originals: differencing the labelled ones would light
  // up the caption text wherever the two captions differ, which they always do.
  await ffmpeg(['-i', basePng, '-i', headPng, '-filter_complex', '[0:v][1:v]blend=all_mode=difference', difference], deps);

  return ['base.png', 'head.png', 'side-by-side.png', 'difference.png'];
}

/**
 * Temporal comparison: a normal-speed H.264 MP4 and a practical GIF preview, both stacked
 * base-left/head-right and both labelled.
 *
 * NORMAL SPEED IS THE CONTRACT. `-framerate` on each input and `-r` on the output are set
 * from the recipe's own intended FPS, so a clip plays at the rate the recipe declares
 * rather than at FFmpeg's 25fps default -- which would silently slow a 60fps capture to
 * less than half speed and make every motion judgement wrong.
 */
export async function composeTemporal(
  { baseFrames, headFrames, frameCount, fps, baseLabel, headLabel, outDir, workspace },
  deps = {},
) {
  const baseText = await writeLabel(workspace, 'base', baseLabel);
  const headText = await writeLabel(workspace, 'head', headLabel);
  const mp4 = resolve(outDir, 'comparison.mp4');
  const gif = resolve(outDir, 'comparison.gif');
  const stack = `[0:v]${drawtext(baseText)}[l];[1:v]${drawtext(headText)}[r];[l][r]hstack=inputs=2`;
  const inputs = [
    '-framerate', String(fps), '-start_number', '0', '-i', baseFrames,
    '-framerate', String(fps), '-start_number', '0', '-i', headFrames,
  ];

  await ffmpeg([
    ...inputs,
    '-filter_complex', stack,
    '-frames:v', String(frameCount),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-r', String(fps),
    mp4,
  ], deps);

  // Two passes for the GIF: a palette generated from the stacked stream, then applied.
  // FFmpeg's default 256-colour quantisation without a generated palette produces heavy
  // banding on the felt floor, which reads as a rendering difference and is not one.
  const palette = resolve(workspace, 'palette.png');
  await ffmpeg([...inputs, '-filter_complex', `${stack},palettegen=stats_mode=diff`, '-frames:v', '1', palette], deps);
  await ffmpeg([
    ...inputs, '-i', palette,
    '-filter_complex', `${stack}[s];[s][2:v]paletteuse=dither=bayer:bayer_scale=5`,
    '-frames:v', String(frameCount),
    '-loop', '0', '-r', String(fps),
    gif,
  ], deps);

  return ['comparison.mp4', 'comparison.gif'];
}
