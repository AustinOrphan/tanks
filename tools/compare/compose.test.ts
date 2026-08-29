import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// @ts-expect-error -- plain-node ESM module, no types
import { fitLabel, composeStill, composeTemporal, LABEL_FONT_SIZE } from './compose.mjs';

function recorder() {
  const calls: string[][] = [];
  return {
    calls,
    runProcess: async (command: string, args: string[]) => { calls.push([command, ...args]); return { stdout: '' }; },
    /** The nth ffmpeg invocation's arguments, joined, for substring assertions. */
    joined: (index: number) => calls[index].join(' '),
  };
}

describe('fitLabel', () => {
  it('keeps a short caption intact', () => {
    expect(fitLabel('base', 'bb13d5a99eef', 'main', 640)).toBe('base  bb13d5a  main');
  });

  it('NEVER lets truncation reach the SHA', () => {
    // The bug this closes, found by looking at a rendered frame rather than by reasoning:
    // with the ref first, a long branch name pushed the SHA off the right edge and the
    // caption still looked plausible while no longer identifying the commit.
    const label = fitLabel('head', '0324dc2ffff', 'feat/a-really-quite-long-branch-name-here', 320);
    expect(label.startsWith('head  0324dc2  ')).toBe(true);
    expect(label.endsWith('...')).toBe(true);
  });

  it('gives a wider panel more room for the ref', () => {
    // The budget has to actually depend on the width; a fixed truncation length would
    // pass the two tests above and waste half of a 1280px panel.
    const ref = 'feat/a-really-quite-long-branch-name-here';
    const narrow = fitLabel('head', '0324dc2', ref, 320);
    const wide = fitLabel('head', '0324dc2', ref, 1280);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(wide).toContain(ref); // wide enough to need no ellipsis at all
  });

  it('degrades to just the side and SHA when the panel cannot fit a ref', () => {
    expect(fitLabel('base', 'abcdef1234', 'main', 40)).toBe('base  abcdef1');
  });
});

describe('composeStill', () => {
  async function run() {
    const dir = await mkdtemp(resolve(tmpdir(), 'compose-'));
    const ff = recorder();
    const files = await composeStill({
      basePng: '/w/base.png', headPng: '/w/head.png',
      baseLabel: 'base  aaaaaaa  main', headLabel: 'head  bbbbbbb  topic',
      outDir: dir, workspace: dir,
    }, { runProcess: ff.runProcess });
    return { dir, ff, files };
  }

  it('publishes the four still artifacts the contract names', async () => {
    const { files } = await run();
    expect(files).toEqual(['base.png', 'head.png', 'side-by-side.png', 'difference.png']);
  });

  it('passes label text through a FILE, never through the filter string', async () => {
    // A ref can contain `:` and `\`, which drawtext's own parser gives meaning to.
    // textfile= makes the bytes text rather than syntax.
    const { dir, ff } = await run();
    expect(ff.joined(0)).toContain('textfile=');
    expect(ff.joined(0)).not.toContain('text=base');
    expect(await readFile(resolve(dir, 'base.label.txt'), 'utf8')).toBe('base  aaaaaaa  main');
    expect(await readFile(resolve(dir, 'head.label.txt'), 'utf8')).toBe('head  bbbbbbb  topic');
  });

  it('resolves the font through fontconfig rather than a hardcoded font path', async () => {
    // A font FILE path is the thing that differs between this box and a CI runner.
    const { ff } = await run();
    expect(ff.joined(0)).toContain('font=Sans');
    expect(ff.joined(0)).not.toMatch(/fontfile=/);
    expect(ff.joined(0)).toContain(`fontsize=${LABEL_FONT_SIZE}`);
  });

  it('stacks the LABELLED pair but differences the UNLABELLED originals', async () => {
    // Differencing the labelled frames would light up the caption text wherever the two
    // captions differ -- which is always, since they name different refs -- and that band
    // of glowing text would be the largest "change" in the image.
    const { dir, ff } = await run();
    const stack = ff.calls.find((c) => c.join(' ').includes('hstack'))!.join(' ');
    expect(stack).toContain(resolve(dir, 'base.png'));
    expect(stack).toContain(resolve(dir, 'head.png'));

    const diff = ff.calls.find((c) => c.join(' ').includes('blend=all_mode=difference'))!.join(' ');
    expect(diff).toContain('/w/base.png');
    expect(diff).toContain('/w/head.png');
    expect(diff).not.toContain(resolve(dir, 'base.png'));
  });
});

describe('composeTemporal', () => {
  async function run(fps = 60, frameCount = 47) {
    const dir = await mkdtemp(resolve(tmpdir(), 'compose-'));
    const ff = recorder();
    const files = await composeTemporal({
      baseFrames: '/w/base/frame-%04d.png', headFrames: '/w/head/frame-%04d.png',
      frameCount, fps, baseLabel: 'base', headLabel: 'head', outDir: dir, workspace: dir,
    }, { runProcess: ff.runProcess });
    return { ff, files, dir };
  }

  it('publishes the MP4 review source of truth and the GIF preview', async () => {
    const { files } = await run();
    expect(files).toEqual(['comparison.mp4', 'comparison.gif']);
  });

  it('encodes H.264 / yuv420p with faststart, as the artifact contract requires', async () => {
    const { ff } = await run();
    const mp4 = ff.joined(0);
    expect(mp4).toContain('libx264');
    expect(mp4).toContain('yuv420p');
    expect(mp4).toContain('+faststart');
  });

  it('sets the frame rate on BOTH inputs and the output from the recipe', async () => {
    // FFmpeg defaults an image sequence to 25fps. Left alone, a 60fps capture plays at
    // less than half speed and every judgement about motion is wrong -- and "normal
    // speed" is the thing the MP4 is supposed to be.
    const { ff } = await run(60);
    const mp4 = ff.calls[0];
    expect(mp4.filter((a) => a === '-framerate')).toHaveLength(2);
    expect(mp4.filter((a) => a === '60')).toHaveLength(3); // two inputs plus -r
    // And it follows the recipe rather than pinning 60.
    const slow = await run(30);
    expect(slow.ff.calls[0].filter((a) => a === '30')).toHaveLength(3);
  });

  it('bounds every pass to the captured frame count, so neither side is padded', async () => {
    const { ff } = await run(60, 47);
    const encodes = ff.calls.filter((c) => c.includes('-frames:v'));
    // The palette pass is a single frame by design; the two media passes carry the real count.
    const counts = encodes.map((c) => c[c.indexOf('-frames:v') + 1]);
    expect(counts.filter((c) => c === '47')).toHaveLength(2);
    expect(counts.filter((c) => c === '1')).toHaveLength(1);
  });

  it('generates a palette before applying one, rather than trusting the default quantiser', async () => {
    const { ff } = await run();
    const palettegen = ff.calls.findIndex((c) => c.join(' ').includes('palettegen'));
    const paletteuse = ff.calls.findIndex((c) => c.join(' ').includes('paletteuse'));
    expect(palettegen).toBeGreaterThan(-1);
    expect(paletteuse).toBeGreaterThan(palettegen);
  });

  it('loops the GIF forever, matching the capture contract preview', async () => {
    const { ff } = await run();
    const gif = ff.calls[ff.calls.length - 1];
    expect(gif[gif.indexOf('-loop') + 1]).toBe('0');
  });
});
