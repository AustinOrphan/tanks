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

const README_GIF = README_CLIP.output;

/** A structuredClone of a conforming fixture with one field flipped. */
function flip(edit: (inputs: Inputs) => void, base: Inputs = CONFORMING): () => Inputs {
  return () => {
    const inputs = structuredClone(base);
    edit(inputs);
    return inputs;
  };
}

/** The conforming clips with one field flipped, and the repository they imply (see `world`). */
function rebuilt(edit: (clips: Clip[]) => void): () => Inputs {
  return () => {
    const clips = structuredClone([README_CLIP, DOCS_CLIP]);
    edit(clips);
    return world(clips);
  };
}

function measured(inputs: Inputs, output: string): Facts {
  return inputs.media[output] as Facts;
}

interface Control {
  rule: number;
  title: string;
  make: () => Inputs;
  expected: string;
}

// Each rule's controls, and the one message each must produce. Listed literally, rule by rule.
const CONTROLS: Control[] = [
  {
    rule: 1,
    title: 'an unknown clip key',
    make: flip((inputs) => {
      Object.assign(inputs.manifest.clips[0], { viewport: { width: 640, height: 360 } });
    }),
    expected: "clip 'campaign-round': unknown key 'viewport'",
  },
  {
    rule: 1,
    title: 'an unknown manifest key',
    make: flip((inputs) => {
      inputs.manifest.notes = 'regenerate weekly';
    }),
    expected: "manifest: unknown key 'notes'",
  },
  {
    rule: 1,
    title: 'a missing clip key',
    make: flip((inputs) => {
      delete (inputs.manifest.clips[1] as Partial<Clip>).caption;
    }),
    expected: "clip 'versus-round': missing key 'caption'",
  },
  {
    rule: 1,
    title: 'a wrong version',
    make: flip((inputs) => {
      inputs.manifest.version = 2;
    }),
    expected: 'manifest: version must be 1, got 2',
  },
  {
    rule: 1,
    title: 'a placement outside readme and docs',
    make: flip((inputs) => {
      inputs.manifest.clips[1].placement = 'sidebar';
    }),
    expected: `clip 'versus-round': placement must be 'readme' or 'docs', got "sidebar"`,
  },
  {
    rule: 2,
    title: 'two clips sharing an id',
    make: flip((inputs) => {
      inputs.manifest.clips[1].id = 'campaign-round';
    }),
    expected: 'id "campaign-round" is shared by 2 clips',
  },
  {
    rule: 2,
    title: 'two clips sharing an output',
    make: rebuilt((clips) => {
      clips[1].output = README_GIF;
    }),
    expected: 'output "docs/media/showcase/campaign-round.gif" is shared by 2 clips',
  },
  {
    rule: 2,
    title: 'two clips sharing an order',
    make: flip((inputs) => {
      inputs.manifest.clips[1].order = 1;
    }),
    expected: 'order 1 is shared by 2 clips',
  },
  {
    rule: 3,
    title: 'a recipe the capture registry does not have',
    make: flip((inputs) => {
      inputs.manifest.clips[1].recipe = 'flow.versus-round.typo';
    }),
    expected: "clip 'versus-round': recipe 'flow.versus-round.typo' is not in the capture registry",
  },
  {
    rule: 3,
    title: 'a recipe with no gif artifact',
    make: flip((inputs) => {
      inputs.manifest.clips[1].recipe = 'screen.levels';
    }),
    expected: "clip 'versus-round': recipe 'screen.levels' declares no gif artifact (it declares png)",
  },
  {
    rule: 4,
    title: 'an output outside docs/media/showcase/',
    make: rebuilt((clips) => {
      clips[1].output = 'docs/media/other/versus-round.gif';
    }),
    expected: "clip 'versus-round': output 'docs/media/other/versus-round.gif' is not of the form "
      + 'docs/media/showcase/<name>.gif',
  },
  {
    rule: 4,
    title: 'an output with a .. segment',
    make: rebuilt((clips) => {
      clips[1].output = 'docs/media/showcase/../versus-round.gif';
    }),
    expected: "clip 'versus-round': output 'docs/media/showcase/../versus-round.gif' is not of the "
      + 'form docs/media/showcase/<name>.gif',
  },
  {
    rule: 4,
    title: 'an absolute URL output',
    make: rebuilt((clips) => {
      clips[1].output = 'https://example.com/versus-round.gif';
    }),
    expected: "clip 'versus-round': output 'https://example.com/versus-round.gif' is not of the form "
      + 'docs/media/showcase/<name>.gif',
  },
  {
    rule: 5,
    title: 'a caption that is only whitespace',
    make: flip((inputs) => {
      inputs.manifest.clips[0].caption = '   ';
    }),
    expected: "clip 'campaign-round': caption is empty",
  },
  {
    rule: 5,
    title: 'an alt that is only whitespace',
    make: rebuilt((clips) => {
      clips[0].alt = ' \t ';
    }),
    expected: "clip 'campaign-round': alt is empty",
  },
  {
    rule: 5,
    title: 'an alt of 501 characters',
    make: rebuilt((clips) => {
      clips[0].alt = 'A'.repeat(501);
    }),
    expected: "clip 'campaign-round': alt is 501 characters; at most 500",
  },
  {
    rule: 5,
    title: 'an alt that repeats the caption',
    make: rebuilt((clips) => {
      clips[0].alt = 'A campaign round on level 1 ';
    }),
    expected: "clip 'campaign-round': alt repeats the caption; it must describe the clip instead",
  },
  {
    rule: 6,
    title: 'five clips',
    make: rebuilt((clips) => {
      for (const name of ['mine-chain', 'ricochet', 'roster']) {
        clips.push({ ...DOCS_CLIP, id: name, output: `docs/media/showcase/${name}.gif`,
          order: clips.length + 1, caption: `The ${name} clip`, alt: `What the ${name} clip shows.` });
      }
    }),
    expected: 'manifest: 5 clips; at most 4',
  },
  {
    rule: 6,
    title: 'two clips placed in the README',
    make: rebuilt((clips) => {
      clips[1].placement = 'readme';
    }),
    expected: 'manifest: 2 clips are placed in README.md; at most 1',
  },
  {
    rule: 7,
    title: 'a maxBytes one byte over 2 MiB',
    make: flip((inputs) => {
      inputs.manifest.clips[0].maxBytes = 2_097_153;
    }),
    expected: "clip 'campaign-round': maxBytes 2097153 exceeds 2097152",
  },
  {
    rule: 8,
    title: 'an output that is not tracked',
    make: flip((inputs) => {
      inputs.tracked = inputs.tracked.filter((file) => file !== README_GIF);
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif is not a tracked file",
  },
  {
    rule: 8,
    title: 'a file one byte larger than its maxBytes',
    make: flip((inputs) => {
      measured(inputs, README_GIF).bytes = 2_000_001;
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif is 2000001 bytes; its "
      + 'maxBytes is 2000000',
  },
  {
    rule: 8,
    title: 'a file that could not be measured',
    make: flip((inputs) => {
      inputs.media[README_GIF] = { error: 'GIF has no trailer' };
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif cannot be measured: GIF "
      + 'has no trailer',
  },
  {
    rule: 9,
    title: 'a GIF 641 px wide',
    make: flip((inputs) => {
      measured(inputs, README_GIF).width = 641;
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif is 641 px wide; at most 640",
  },
  {
    rule: 10,
    title: 'a GIF one centisecond faster than 15 fps allows',
    make: flip((inputs) => {
      // 3 frames need at least 3 / 15 s less 1 cs, which is 19 cs; three 6 cs delays are 18.
      measured(inputs, README_GIF).durationCentiseconds = 18;
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif shows 3 frames in 0.18 s, "
      + 'faster than 15 fps',
  },
  {
    rule: 11,
    title: 'a GIF displayed one centisecond past 8.01 s',
    make: flip((inputs) => {
      measured(inputs, README_GIF).durationCentiseconds = 802;
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif displays for 8.02 s; at "
      + 'most 8 s',
  },
  {
    rule: 12,
    title: 'a GIF that loops once',
    make: flip((inputs) => {
      measured(inputs, README_GIF).loopCount = 1;
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif has loop count 1; it must "
      + 'loop forever (loop count 0)',
  },
  {
    rule: 12,
    title: 'a GIF with no loop extension',
    make: flip((inputs) => {
      measured(inputs, README_GIF).loopCount = null;
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif has no loop extension; it "
      + 'must loop forever (loop count 0)',
  },
  {
    rule: 13,
    title: 'a set one byte over 6 MiB',
    make: flip((inputs) => {
      // The mine chain's maxBytes, 2,000,000, still covers one more byte; only the set is over.
      measured(inputs, 'docs/media/showcase/mine-chain.gif').bytes += 1;
    }, BOUNDARY),
    expected: 'showcase set: 6291457 bytes; at most 6291456',
  },
  {
    rule: 14,
    title: 'a stray MP4 beside the clips',
    make: flip((inputs) => {
      inputs.tracked.push('docs/media/showcase/campaign-round.mp4');
    }),
    expected: 'docs/media/showcase/campaign-round.mp4 is tracked under docs/media/showcase/ but is not '
      + 'a manifest output',
  },
  {
    rule: 14,
    title: 'a second GIF that no clip names',
    make: flip((inputs) => {
      inputs.tracked.push('docs/media/showcase/campaign-round-take-2.gif');
    }),
    expected: 'docs/media/showcase/campaign-round-take-2.gif is tracked under docs/media/showcase/ but '
      + 'is not a manifest output',
  },
  {
    rule: 15,
    title: 'a second GIF reference in README.md',
    make: flip((inputs) => {
      inputs.documents['README.md'] += `\n![${DOCS_CLIP.alt}](docs/media/showcase/versus-round.gif)\n`;
    }),
    expected: 'README.md: 2 GIF references; at most 1',
  },
  {
    rule: 15,
    title: 'an absolute URL GIF reference',
    make: flip((inputs) => {
      inputs.documents['docs/showcase.md']
        += '\n![A clip](https://raw.githubusercontent.com/example/tanks/pr-media/clip.gif)\n';
    }),
    expected: "docs/showcase.md: GIF reference 'https://raw.githubusercontent.com/example/tanks/"
      + "pr-media/clip.gif' is not a relative path to a manifest output",
  },
  {
    rule: 15,
    title: 'a relative link into the pr-media branch',
    make: flip((inputs) => {
      inputs.documents['docs/showcase.md'] += '\n![A clip](../../blob/pr-media/clip.gif?raw=true)\n';
    }),
    expected: "docs/showcase.md: GIF reference '../../blob/pr-media/clip.gif?raw=true' is not a "
      + 'relative path to a manifest output',
  },
  {
    rule: 15,
    title: 'a root-relative GIF reference',
    make: flip((inputs) => {
      // Joined naively to docs/, this would resolve to the docs clip's own output.
      inputs.documents['docs/showcase.md'] += `\n![${DOCS_CLIP.alt}](/media/showcase/versus-round.gif)\n`;
    }),
    expected: "docs/showcase.md: GIF reference '/media/showcase/versus-round.gif' is not a relative "
      + 'path to a manifest output',
  },
  {
    rule: 15,
    title: 'an img tag pointing at a pr-media URL',
    make: flip((inputs) => {
      inputs.documents['docs/showcase.md']
        += '\n<img src="https://github.com/example/tanks/blob/pr-media/clip.gif?raw=true" alt="A clip">\n';
    }),
    expected: "docs/showcase.md: GIF reference 'https://github.com/example/tanks/blob/pr-media/clip.gif"
      + "?raw=true' is not a relative path to a manifest output",
  },
  {
    rule: 15,
    title: 'a reference-style image pointing at a pr-media URL',
    make: flip((inputs) => {
      inputs.documents['docs/showcase.md'] += '\n![A clip][clip]\n\n'
        + '[clip]: https://raw.githubusercontent.com/example/tanks/pr-media/clip.gif\n';
    }),
    expected: "docs/showcase.md: GIF reference 'https://raw.githubusercontent.com/example/tanks/"
      + "pr-media/clip.gif' is not a relative path to a manifest output",
  },
  {
    rule: 15,
    title: 'a clip not referenced from its placement document',
    make: flip((inputs) => {
      inputs.documents['docs/showcase.md'] = '# Showcase\n';
    }),
    expected: "clip 'versus-round': docs/media/showcase/versus-round.gif is not referenced from "
      + 'docs/showcase.md',
  },
  {
    rule: 15,
    title: 'the README clip referenced only from docs/showcase.md',
    make: flip((inputs) => {
      inputs.documents['README.md'] = '# Tanks!\n';
      inputs.documents['docs/showcase.md'] += `\n${image(README_CLIP, 'docs')}\n`;
    }),
    expected: "clip 'campaign-round': docs/media/showcase/campaign-round.gif is not referenced from "
      + 'README.md',
  },
  {
    rule: 15,
    title: 'a reference whose alt text differs from the manifest',
    make: flip((inputs) => {
      inputs.documents['README.md'] = inputs.documents['README.md'].replace(README_CLIP.alt, 'A tank.');
    }),
    expected: "README.md: GIF reference 'docs/media/showcase/campaign-round.gif' has alt text "
      + `"A tank."; the manifest alt is "${README_CLIP.alt}"`,
  },
  {
    rule: 15,
    title: 'an img tag with no alt text',
    make: flip((inputs) => {
      inputs.documents['README.md'] = inputs.documents['README.md']
        .replace(image(README_CLIP, '.'), '<img src="docs/media/showcase/campaign-round.gif" width="640">');
    }),
    expected: "README.md: GIF reference 'docs/media/showcase/campaign-round.gif' has alt text null; "
      + `the manifest alt is "${README_CLIP.alt}"`,
  },
];

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

  describe('negative controls', () => {
    it('covers each of the 15 rules', () => {
      expect([...new Set(CONTROLS.map((control) => control.rule))])
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    });

    // A loop rather than it.each: it.each truncates an interpolated title near 40 characters,
    // and these full names are what the mutation entries' killedBy lists pin.
    for (const { rule, title, make, expected } of CONTROLS) {
      it(`rule ${rule}: ${title}`, () => {
        expect(validate(make())).toEqual([expected]);
      });
    }

    it('leaves the shared fixture conforming after every control has run', () => {
      // A control that edited CONFORMING in place instead of a clone would pass by accident.
      expect(validate(CONFORMING)).toEqual([]);
      expect(validate(BOUNDARY)).toEqual([]);
    });
  });
});

describe('showcase gifFacts (issue #1062)', () => {
  it('measures size, logical screen, frames, displayed centiseconds and loop count from generated bytes', () => {
    // 640 x 360: both above 255, so each needs both header bytes, and unequal, so a swap shows.
    const bytes = buildGif({ width: 640, height: 360, delays: [7, 7, 6, 7], loop: 0 });
    // 6 signature + 7 logical screen + 6 colour table + 19 loop extension + 4 x 23 frame + 1 trailer.
    expect(bytes.length).toBe(131);
    expect(gifFacts(bytes)).toEqual({
      bytes: 131,
      width: 640,
      height: 360,
      frameCount: 4,
      durationCentiseconds: 27,
      loopCount: 0,
    });
    expect(gifFacts(buildGif({ loop: 3 })).loopCount).toBe(3);
  });

  it('reports a GIF with no loop extension as loop count null, not as looping', () => {
    expect(gifFacts(buildGif({ loop: null })).loopCount).toBeNull();
  });

  it('throws on a truncated GIF rather than reporting zeros', () => {
    const whole = buildGif();
    expect(gifFacts(whole).frameCount).toBe(3);
    expect(() => gifFacts(whole.subarray(0, whole.length - 1))).toThrow(/no trailer/);
    expect(() => gifFacts(whole.subarray(0, 10))).toThrow(/shorter than its logical screen/);
    expect(() => gifFacts(Buffer.from('PNG...'))).toThrow(/invalid GIF signature/);
  });
});
