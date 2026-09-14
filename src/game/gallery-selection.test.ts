// The gallery workbench's link codec (issue #730). A synthetic catalog stands in for the
// render registries so each case can name its own ids; the real catalog's round trip is
// pinned where it is wired (route-ui.test.ts).
import { describe, it, expect } from 'vitest';
import {
  defaultGallerySelection,
  formatGallerySelection,
  gallerySearch,
  parseGallerySelection,
  type GalleryCatalog,
  type GallerySelection,
} from './gallery-selection';

const CATALOG: GalleryCatalog = {
  elements: ['mine', 'tank', 'wall'],
  moments: ['fire', 'destroyed'],
  views: ['close', 'game', 'low'],
  mineWarnStyles: ['lance', 'slump'],
};

const parse = (raw: string) => parseGallerySelection(raw, CATALOG);

describe('parseGallerySelection (issue #730)', () => {
  it('reads every setting it offers', () => {
    const { selection, problems } = parse(
      'scene:destroyed,view:low,skin:camo,hull:red,accent:gold,spawn-anim:rise,mineWarn:lance,reach,timer,age:24',
    );
    expect(problems).toEqual([]);
    expect(selection).toEqual({
      subject: { kind: 'moment', id: 'destroyed' },
      view: 'low',
      skin: 'camo',
      hull: 'red',
      accent: 'gold',
      spawnAnim: 'rise',
      mineWarn: 'lance',
      reach: true,
      timer: true,
      frame: 24,
    } satisfies GallerySelection);
  });

  it('draws the defaults from an empty value, and says nothing about it', () => {
    expect(parse('')).toEqual({ selection: defaultGallerySelection(CATALOG), problems: [] });
    expect(defaultGallerySelection(CATALOG).subject).toEqual({ kind: 'element', id: 'mine' });
    expect(defaultGallerySelection(CATALOG).view).toBe('game');
  });

  // Each row: a link with ONE part wrong, the field that must stay at its default, and a
  // fragment the report must contain. The report is the criterion; the default is only what
  // draws meanwhile.
  const refused: [string, keyof GallerySelection, string][] = [
    ['scene:explode', 'subject', '"explode" is not a registered moment'],
    ['elements:tree', 'subject', '"tree" is not a registered element'],
    ['view:sideways', 'view', '"sideways" is not a registered view'],
    ['skin:plaid', 'skin', '"plaid" is not a registered skin'],
    ['hull:#3d7bd6', 'hull', '"#3d7bd6" is not a registered hull colour'],
    ['accent:bronze', 'accent', '"bronze" is not a registered accent'],
    ['spawn-anim:teleport', 'spawnAnim', '"teleport" is not a registered spawn animation'],
    ['mineWarn:spike', 'mineWarn', '"spike" is not a registered mine warning'],
    ['age:-3', 'frame', '"-3" is not a frame number'],
    ['age:2.5', 'frame', '"2.5" is not a frame number'],
    ['reach:1', 'reach', '"reach" takes no value'],
    ['view', 'view', '"view" needs a value'],
    ['view:', 'view', '"view" needs a value'],
  ];
  for (const [raw, field, fragment] of refused) {
    it(`reports "${raw}" and leaves ${field} at its default`, () => {
      const { selection, problems } = parse(raw);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(fragment);
      expect(selection[field]).toEqual(defaultGallerySelection(CATALOG)[field]);
    });
  }

  it('reports a part that names no setting, and keeps reading the rest', () => {
    const { selection, problems } = parse('zoom:2,view:low');
    expect(problems).toEqual(['"zoom:2" is not a gallery setting, so it was ignored.']);
    expect(selection.view).toBe('low');
  });

  it('keeps the first of a repeated setting and the first of two subjects, and reports the other', () => {
    const { selection, problems } = parse('view:low,view:close,scene:fire,elements:tank');
    expect(selection.view).toBe('low');
    expect(selection.subject).toEqual({ kind: 'moment', id: 'fire' });
    expect(problems).toEqual([
      '"view" is given more than once; only the first one is used.',
      '"elements:tank" is a second subject; only the first one is shown.',
    ]);
  });

  it('ignores empty parts and surrounding space', () => {
    expect(parse(' view:low ,, skin:camo ,')).toEqual({
      selection: { ...defaultGallerySelection(CATALOG), view: 'low', skin: 'camo' },
      problems: [],
    });
  });
});

describe('formatGallerySelection (issue #730)', () => {
  it('writes the subject and only what differs from the default', () => {
    const base = defaultGallerySelection(CATALOG);
    expect(formatGallerySelection(base, CATALOG)).toBe('elements:mine');
    expect(formatGallerySelection({ ...base, subject: { kind: 'moment', id: 'fire' }, frame: 7 }, CATALOG)).toBe(
      'scene:fire,age:7',
    );
  });

  it('round-trips every subject and every non-default value through the parser unchanged', () => {
    const base = defaultGallerySelection(CATALOG);
    const selections: GallerySelection[] = [
      ...CATALOG.elements.map((id) => ({ ...base, subject: { kind: 'element' as const, id } })),
      ...CATALOG.moments.map((id) => ({ ...base, subject: { kind: 'moment' as const, id } })),
      {
        subject: { kind: 'moment', id: 'destroyed' },
        view: 'close',
        skin: 'two-tone',
        hull: 'white',
        accent: 'silver',
        spawnAnim: 'beacon',
        mineWarn: 'slump',
        reach: true,
        timer: true,
        frame: 199,
      },
    ];
    for (const selection of selections) {
      const raw = formatGallerySelection(selection, CATALOG);
      expect(parse(raw), raw).toEqual({ selection, problems: [] });
    }
  });
});

describe('gallerySearch (issue #730)', () => {
  it('sets the gallery parameter with the gate on, keeping every other parameter', () => {
    expect(gallerySearch('', 'scene:fire,age:3')).toBe('?dev=1&gallery=scene:fire,age:3');
    expect(gallerySearch('?seed=7&dev=1&gallery=elements:tank', 'scene:fire')).toBe(
      '?seed=7&dev=1&gallery=scene:fire',
    );
    expect(gallerySearch('dev=0&tag=x', 'elements:mine')).toBe('?tag=x&dev=1&gallery=elements:mine');
  });

  it('writes a link the browser reads back as the same value', () => {
    const raw = 'scene:destroyed,view:low,spawn-anim:rise,reach';
    expect(new URLSearchParams(gallerySearch('?a=b', raw)).get('gallery')).toBe(raw);
  });
});
