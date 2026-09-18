// The persistence inventory against the surfaces that describe it (issue #764). The keys the
// stores really write are checked against the inventory in storage.test.ts, by running
// every store; this file holds save.ts and the two privacy policies to the same inventory.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LEGACY_KEYS, PERSISTED_DATA } from './persistence-inventory';
import { SAVE_IMPORT_KEYS, SAVE_KEYS } from './save';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  type AudioSettings,
  type InputSettings,
  type PresentationSettings,
} from './settings';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const CURRENT = PERSISTED_DATA.map((datum) => datum.key);
const LEGACY = LEGACY_KEYS.map((legacy) => legacy.key);

/** Every `tanks.*.vN` key a text names. */
const keysNamedIn = (text: string): string[] => [...new Set(text.match(/\btanks\.[a-z][\w.]*\.v\d+\b/g) ?? [])];

/** PRIVACY.md's data table as [key, contents] rows. */
function markdownRows(markdown: string): [string, string][] {
  return [...markdown.matchAll(/^\| `(tanks\.[^`]+)` \| (.+?) \|$/gm)].map((m) => [m[1], m[2]]);
}

/** public/privacy.html's data table as [key, contents] rows, entities decoded. */
function htmlRows(html: string): [string, string][] {
  const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return [...html.matchAll(/<tr><td><code>(tanks\.[^<]+)<\/code><\/td><td>(.+?)<\/td><\/tr>/g)]
    .map((m) => [m[1], decode(m[2])]);
}

describe('persistence inventory: shape', () => {
  it('names each key once, and never a key as both current and legacy', () => {
    expect(new Set(CURRENT).size).toBe(CURRENT.length);
    expect(new Set(LEGACY).size).toBe(LEGACY.length);
    expect(CURRENT.filter((key) => LEGACY.includes(key))).toEqual([]);
    expect(PERSISTED_DATA.every((datum) => datum.contents.trim().length > 10)).toBe(true);
  });
});

describe('persistence inventory: save export and import', () => {
  it('exports exactly the current keys the inventory marks exported, in save.ts order', () => {
    // save.ts stays the authority for order and semantics; this proves its list is the
    // inventory's exported set rather than a second list that can drift from it.
    const exported = PERSISTED_DATA.filter((datum) => datum.exported).map((datum) => datum.key);
    expect([...SAVE_KEYS].sort()).toEqual([...exported].sort());
    expect(SAVE_KEYS).toHaveLength(new Set(SAVE_KEYS).size);
  });

  it('imports the exported keys plus exactly the importable legacy keys, and never exports a legacy key', () => {
    const importable = LEGACY_KEYS.filter((legacy) => legacy.importable).map((legacy) => legacy.key);
    expect([...SAVE_IMPORT_KEYS].sort()).toEqual([...SAVE_KEYS, ...importable].sort());
    expect(SAVE_KEYS.filter((key) => LEGACY.includes(key))).toEqual([]);
  });
});

describe('persistence inventory: the privacy policies', () => {
  const surfaces = [
    { name: 'PRIVACY.md', text: read('PRIVACY.md'), rows: markdownRows },
    { name: 'public/privacy.html', text: read('public/privacy.html'), rows: htmlRows },
  ];

  for (const { name, text, rows } of surfaces) {
    it(`${name} lists every current key with the inventory's description, in inventory order`, () => {
      expect(rows(text)).toEqual(PERSISTED_DATA.map((datum) => [datum.key, datum.contents]));
    });

    it(`${name} says which listed keys a save file leaves out, and no others`, () => {
      // Both policies promise an export of "the keys above"; the inventory is what says
      // which of them an export does not carry.
      const left = PERSISTED_DATA.filter((datum) => !datum.exported).map((datum) => datum.key);
      const code = name.endsWith('.html') ? (k: string) => `<code>${k}</code>` : (k: string) => `\`${k}\``;
      const flat = text.replace(/\s+/g, ' ');
      const except = left.length === 0 ? '' : ` except ${left.map(code).join(', ')}`;
      const clause = `all of the keys above${except} as a single file`;
      expect(flat).toContain(`You can export and import ${clause}`);
    });

    it(`${name} names no key that is neither current nor classified legacy`, () => {
      const named = keysNamedIn(text);
      expect(named.length, 'no keys found; the checks above would pass vacuously').toBeGreaterThan(0);
      expect(named.filter((key) => !CURRENT.includes(key) && !LEGACY.includes(key))).toEqual([]);
    });
  }
});

describe('persistence inventory: the settings description', () => {
  /**
   * One phrase per field the settings store writes under its key. A field added to
   * `PlayerSettings` fails the typecheck until it is named here, and fails the test below
   * until the policy's sentence names it too -- which is how the controller layouts of
   * issue #754 and the quality preset of issue #540 were both stored for a while under a
   * sentence that did not mention them.
   */
  const NAMED_AS: Record<keyof AudioSettings | keyof InputSettings | keyof PresentationSettings, RegExp> = {
    muted: /sound mute/,
    volume: /\bvolume\b/,
    touchScheme: /touch control scheme/,
    fireMode: /fire mode/,
    deviceHaptics: /device vibration/,
    controllerRumble: /controller rumble/,
    controllerLayouts: /controller layout/,
    motion: /motion\/flash/,
    uiScale: /interface scale/,
    quality: /render quality/,
  };

  it('names every field the settings store writes', () => {
    const settings = PERSISTED_DATA.find((datum) => datum.key === SETTINGS_KEY);
    expect(settings).toBeDefined();
    // The runtime shape too, so an optional field the type lets `NAMED_AS` omit still counts.
    const fields = [DEFAULT_SETTINGS.audio, DEFAULT_SETTINGS.input, DEFAULT_SETTINGS.presentation]
      .flatMap((group) => Object.keys(group))
      .sort();
    expect(fields).toEqual(Object.keys(NAMED_AS).sort());
    for (const field of fields) {
      expect(settings?.contents, field).toMatch(NAMED_AS[field as keyof typeof NAMED_AS]);
    }
  });
});
