// The showcase publication rules (issue #1062). Every rule has a negative control: a
// structuredClone of one conforming fixture with one field flipped, which must fail with that
// rule's message and no other. The limits are spelled as literals here, never read from
// SHOWCASE_LIMITS, so a mutated limit moves the validator without moving its controls.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gifFacts } from './facts.mjs';
import { validateShowcase } from './validate.mjs';

interface Clip {
  id: string;
  recipe: string;
  output: string;
  placement: string;
  caption: string;
  alt: string;
  maxBytes: number;
  order: number;
}

interface Facts {
  bytes: number;
  width: number;
  height: number;
  frameCount: number;
  durationCentiseconds: number;
  loopCount: number | null;
}

interface Inputs {
  manifest: { version: number; clips: Clip[] } & Record<string, unknown>;
  tracked: string[];
  media: Record<string, Facts | { error: string }>;
  documents: Record<string, string>;
}

/** A GIF built byte by byte: a two-colour global table, an optional NETSCAPE loop, 1x1 frames. */
function buildGif(
  { width = 320, height = 180, delays = [7, 7, 6], loop = 0 }:
    { width?: number; height?: number; delays?: number[]; loop?: number | null } = {},
): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x80; // a global colour table of two entries
  const table = Buffer.from([0, 0, 0, 255, 255, 255]);
  const loopBlock = loop === null ? [] : [Buffer.from([
    0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, loop & 0xff, loop >> 8, 0x00,
  ])];
  const frames = delays.map((delay) => Buffer.from([
    0x21, 0xf9, 0x04, 0x00, delay & 0xff, delay >> 8, 0x00, 0x00, // graphic control: the delay
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // a 1x1 image at the origin
    0x02, 0x02, 0x4c, 0x01, 0x00, // LZW minimum code size 2, one data sub-block
  ]));
  return Buffer.concat([Buffer.from('GIF89a', 'ascii'), screen, table, ...loopBlock, ...frames,
    Buffer.from([0x3b])]);
}

// The registry lookup the CLI builds from `findRecipe`, here as a literal table.
const RECIPES: Record<string, string[]> = {
  'flow.campaign-round.docs': ['mp4', 'gif'],
  'flow.versus-round.docs': ['mp4', 'gif'],
  'screen.levels': ['png'],
};
const recipeArtifacts = (id: string): string[] | null => RECIPES[id] ?? null;

function validate(inputs: Inputs): string[] {
  return validateShowcase({ ...inputs, recipeArtifacts });
}

/** A Markdown image of a clip, written relative to the document that shows it. */
function image(clip: Clip, from: string): string {
  return `![${clip.alt}](${path.posix.relative(from, clip.output)})`;
}

/**
 * The repository a manifest implies: every output tracked and measured, and every clip shown in
 * the document its placement names. A control that changes an output, an alt or a placement
 * rebuilds this from the edited clips, because those fields also name the tracked file, its facts
 * and its reference; flipping one alone would fail rules 8, 14 and 15 as well as its own.
 */
function world(clips: Clip[], facts: (index: number) => Facts = () => gifFacts(buildGif())): Inputs {
  const media: Inputs['media'] = {};
  clips.forEach((clip, index) => {
    media[clip.output] ??= facts(index);
  });
  const shown = (placement: string, from: string) => clips
    .filter((clip) => clip.placement === placement)
    .map((clip) => `${image(clip, from)}\n\n${clip.caption}\n`)
    .join('\n');
  return {
    manifest: { version: 1, clips },
    tracked: ['README.md', 'docs/showcase.md', 'tools/showcase/manifest.json', ...Object.keys(media)],
    media,
    documents: {
      'README.md': `# Tanks!\n\n${shown('readme', '.')}\nA browser arena shooter.\n`,
      'docs/showcase.md': `# Showcase\n\n${shown('docs', 'docs')}`,
    },
  };
}

const README_CLIP: Clip = {
  id: 'campaign-round',
  recipe: 'flow.campaign-round.docs',
  output: 'docs/media/showcase/campaign-round.gif',
  placement: 'readme',
  caption: 'A campaign round on level 1',
  alt: 'A tan player tank banks a shell off a wall into a brown enemy tank.',
  maxBytes: 2_000_000,
  order: 1,
};

const DOCS_CLIP: Clip = {
  id: 'versus-round',
  recipe: 'flow.versus-round.docs',
  output: 'docs/media/showcase/versus-round.gif',
  placement: 'docs',
  caption: 'A four-player versus round',
  alt: 'Four tanks in different colours trade shells across a symmetric board.',
  maxBytes: 2_000_000,
  order: 2,
};

const CONFORMING = world([README_CLIP, DOCS_CLIP]);

// Four clips, each at a limit: 640 px wide, exactly 15 fps less one centisecond (3 frames in
// 19 cs: 19 >= 3 / 15 s - 1 cs), 8.01 s displayed, a 500-character alt, a file exactly its
// maxBytes, a maxBytes of exactly 2 MiB, and a set of exactly 6 MiB (4 x 1,572,864 = 6,291,456).
// The builder's GIFs are about a hundred bytes, so the sizes are stated: `bytes` is the measured
// file length, and the validator judges the number it is given.
const BOUNDARY_CLIPS: Clip[] = [
  { ...README_CLIP, maxBytes: 2_097_152 },
  { ...DOCS_CLIP, alt: 'A'.repeat(500) },
  { ...DOCS_CLIP, id: 'mine-chain', output: 'docs/media/showcase/mine-chain.gif', order: 3,
    caption: 'A mine chain', alt: 'Three mines detonate in sequence along a corridor.' },
  { ...DOCS_CLIP, id: 'ricochet', output: 'docs/media/showcase/ricochet.gif', order: 4,
    caption: 'A ricochet', alt: 'A shell rebounds twice before it reaches a tank.',
    maxBytes: 1_572_864 },
];
const BOUNDARY_GIFS = [
  { width: 640 },
  { delays: [7, 6, 6] },
  { delays: Array(9).fill(89) }, // 801 cs
  {},
];
const BOUNDARY = world(
  BOUNDARY_CLIPS,
  (index) => ({ ...gifFacts(buildGif(BOUNDARY_GIFS[index])), bytes: 1_572_864 }),
);

describe('showcase validator (issue #1062)', () => {
  describe('positive controls', () => {
    it('passes a conforming manifest with no clips', () => {
      const empty = world([]);
      expect(empty.documents['README.md']).not.toMatch(/\.gif/);
      expect(validate(empty)).toEqual([]);
    });

    it('passes a conforming manifest with one readme clip and one docs clip', () => {
      // Non-vacuity: the fixture does hold both clips, tracked, measured and referenced.
      expect(CONFORMING.manifest.clips.map((clip) => clip.placement)).toEqual(['readme', 'docs']);
      expect(CONFORMING.documents['README.md']).toContain('](docs/media/showcase/campaign-round.gif)');
      expect(CONFORMING.documents['docs/showcase.md']).toContain('](media/showcase/versus-round.gif)');
      expect(validate(CONFORMING)).toEqual([]);
    });

    it('passes four clips each at a limit: 640 px, 15 fps, 8.01 s, 500-character alt, 6 MiB set', () => {
      const facts = BOUNDARY.media as Record<string, Facts>;
      expect(Object.values(facts).map((fact) => fact.width)).toEqual([640, 320, 320, 320]);
      expect(Object.values(facts).map((fact) => [fact.frameCount, fact.durationCentiseconds]))
        .toEqual([[3, 20], [3, 19], [9, 801], [3, 20]]);
      expect(validate(BOUNDARY)).toEqual([]);
    });

    it('ignores an image reference that is not a GIF', () => {
      const inputs = structuredClone(CONFORMING);
      inputs.documents['README.md'] += '\n![The Tanks! icon](public/icon.png)\n';
      expect(validate(inputs)).toEqual([]);
    });
  });
});
