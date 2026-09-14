// The gallery workbench's terminal commands (issue #731), as strings. That the gallery runner
// reads them back as the same selection is tools/gallery/command-roundtrip.test.ts; this file
// pins what is written and when a recipe is named.
import { describe, it, expect } from 'vitest';
import {
  GALLERY_CAPTURE_STILLS,
  captureCommand,
  galleryAnimArgs,
  galleryCommand,
  galleryCommandArgs,
  matchingCaptureStill,
  shellWord,
  stillFileName,
  type GalleryCommandInput,
} from './gallery-command';

const SIZE = { width: 640, height: 400, dpr: 1 };
const FIRE: GalleryCommandInput = {
  subject: { kind: 'moment', id: 'fire' },
  view: 'game',
  skin: 'solid',
  hull: null,
  accent: null,
  spawnAnim: 'warp',
  mineWarn: null,
  reach: false,
  timer: false,
  frame: 10,
};

describe('galleryCommandArgs (issue #731)', () => {
  it('writes a moment at its frame, at the size it is given', () => {
    expect(galleryCommandArgs(FIRE, SIZE)).toEqual([
      '--scene', 'fire', '--view', 'game', '--skin', 'solid',
      '--w', '640', '--h', '400', '--dpr', '1', '--age', '10',
    ]);
  });

  it('writes a posed element with --elements, and no --age at frame 0', () => {
    const args = galleryCommandArgs({ ...FIRE, subject: { kind: 'element', id: 'tank' }, frame: 0 }, SIZE);
    expect(args.slice(0, 2)).toEqual(['--elements', 'tank']);
    expect(args).not.toContain('--age');
  });

  it('states a spawn animation only when it is not the default', () => {
    expect(galleryCommandArgs(FIRE, SIZE)).not.toContain('--spawn-anim');
    const rise = galleryCommandArgs({ ...FIRE, spawnAnim: 'rise' }, SIZE);
    expect(rise.slice(rise.indexOf('--spawn-anim'))).toContain('rise');
  });

  it('writes hull, accent and mine warning when set', () => {
    const args = galleryCommandArgs({ ...FIRE, hull: '#3d7bd6', accent: '#101010', mineWarn: 'lance' }, SIZE);
    expect(args.join(' ')).toContain('--hull #3d7bd6 --accent #101010 --mineWarn lance');
  });

  it('writes the mine overlays for a posed element and never for a moment', () => {
    const posed = galleryCommandArgs({ ...FIRE, subject: { kind: 'element', id: 'mine' }, reach: true, timer: true }, SIZE);
    expect([posed.includes('--reach'), posed.includes('--timer')]).toEqual([true, true]);
    const moment = galleryCommandArgs({ ...FIRE, reach: true, timer: true }, SIZE);
    expect([moment.includes('--reach'), moment.includes('--timer')]).toEqual([false, false]);
  });

  it('writes the animated form from frame 0 with --anim', () => {
    const args = galleryAnimArgs(FIRE, SIZE);
    expect(args).not.toContain('--age');
    expect(args.at(-1)).toBe('--anim');
  });
});

describe('shell words (issue #731)', () => {
  it('leaves a plain word bare and single-quotes one a shell would read differently', () => {
    expect(shellWord('--elements')).toBe('--elements');
    expect(shellWord('#3d7bd6')).toBe(`'#3d7bd6'`);
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });

  it('prefixes the gallery and capture runners', () => {
    expect(galleryCommand(['--hull', '#3d7bd6'])).toBe(`npm run gallery -- --hull '#3d7bd6'`);
    expect(captureCommand('gallery.fire.still')).toBe('npm run capture -- --recipe gallery.fire.still');
  });
});

describe('matchingCaptureStill (issue #731)', () => {
  it('names the registered still a selection reproduces exactly', () => {
    expect(matchingCaptureStill(FIRE)?.id).toBe('gallery.fire.still');
    const ricochet = GALLERY_CAPTURE_STILLS.find((s) => s.moment === 'ricochet')!;
    expect(matchingCaptureStill({ ...FIRE, subject: { kind: 'moment', id: 'ricochet' }, frame: ricochet.tick })?.id)
      .toBe('gallery.ricochet.still');
  });

  it('names none for a selection one field away -- population: every compared field', () => {
    const nearMisses: [string, GalleryCommandInput][] = [
      ['frame', { ...FIRE, frame: 11 }],
      ['view', { ...FIRE, view: 'top' }],
      ['skin', { ...FIRE, skin: 'camo' }],
      ['hull', { ...FIRE, hull: '#3d7bd6' }],
      ['accent', { ...FIRE, accent: '#101010' }],
      ['spawn animation', { ...FIRE, spawnAnim: 'rise' }],
      ['mine warning', { ...FIRE, mineWarn: 'lance' }],
      ['subject kind', { ...FIRE, subject: { kind: 'element', id: 'fire' } }],
      ['subject', { ...FIRE, subject: { kind: 'moment', id: 'destroyed' } }],
    ];
    for (const [field, input] of nearMisses) expect(matchingCaptureStill(input), field).toBeNull();
  });
});

describe('stillFileName (issue #731)', () => {
  it('carries the subject, frame, pixel size and device pixel ratio', () => {
    expect(stillFileName(FIRE, SIZE)).toBe('gallery-fire-frame10-640x400@1x.png');
  });
});
