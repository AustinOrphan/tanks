import { describe, it, expect } from 'vitest';
import { createMemoryStorage, createStores } from './storage';
import {
  exportSave,
  importSave,
  createSaveApi,
  SAVE_KEYS,
  SAVE_FORMAT,
  SAVE_VERSION,
  type SaveBlob,
} from './save';

function seeded(): Storage {
  const s = createMemoryStorage();
  s.setItem('tanks.progress.v1', '3');
  s.setItem('tanks.stats.v1', JSON.stringify({ shotsFired: 12, shellKills: 4 }));
  s.setItem('tanks.custom.v1', JSON.stringify({ hull: 'green', skin: 'camo', accent: 'gold' }));
  s.setItem('tanks.touch.v1', JSON.stringify({ scheme: 'point', fireMode: 'button' }));
  s.setItem('tanks.achievements.v1', JSON.stringify({ earned: ['first-blood'] }));
  return s;
}

function parse(text: string): SaveBlob {
  return JSON.parse(text) as SaveBlob;
}

describe('SAVE_KEYS', () => {
  it('is exactly the five tanks.* keys, in a fixed order', () => {
    // Pinned as LITERALS, not derived from the store modules: this is the wire
    // format. Renaming a store's key is a save-compatibility break and should
    // fail here rather than silently produce blobs an older build cannot read.
    // Population: all five keys an export carries.
    expect(SAVE_KEYS).toEqual([
      'tanks.progress.v1',
      'tanks.stats.v1',
      'tanks.custom.v1',
      'tanks.touch.v1',
      'tanks.achievements.v1',
    ]);
  });

  it('covers every key the five stores actually write', () => {
    // The other direction, measured rather than asserted: drive all five stores
    // and check the keys that appear are the keys an export would carry. A sixth
    // store added without a SAVE_KEYS entry fails here -- which is the way this
    // list rots.
    const storage = createMemoryStorage();
    const stores = createStores(storage);
    stores.progress.recordCleared(1);
    stores.stats.resetLifetime();
    stores.customization.setHull('red');
    stores.touchSettings.setScheme('point');
    stores.achievements.reset();
    const written: string[] = [];
    for (let i = 0; i < storage.length; i++) written.push(storage.key(i)!);
    expect(written.slice().sort()).toEqual(SAVE_KEYS.slice().sort());
  });
});

describe('exportSave', () => {
  it('carries every present key, with the raw stored strings', () => {
    const blob = parse(exportSave(seeded()));
    expect(blob.format).toBe(SAVE_FORMAT);
    expect(blob.version).toBe(SAVE_VERSION);
    expect(Object.keys(blob.keys).sort()).toEqual(SAVE_KEYS.slice().sort());
    // The RAW string, not a re-serialisation: an export that re-encoded through a
    // store's validator would drop fields a newer build wrote.
    expect(blob.keys['tanks.progress.v1']).toBe('3');
    expect(blob.keys['tanks.achievements.v1']).toBe('{"earned":["first-blood"]}');
  });

  it('omits a key that is absent, rather than exporting null', () => {
    const s = seeded();
    s.removeItem('tanks.achievements.v1');
    const blob = parse(exportSave(s));
    expect('tanks.achievements.v1' in blob.keys).toBe(false);
    expect(Object.keys(blob.keys)).toHaveLength(4);
  });

  it('never exports a key belonging to another app on the shared origin', () => {
    // austinorphan.com's localStorage namespace is shared with every other project
    // page there (CLAUDE.md). An export that dumped the whole namespace would put a
    // neighbouring app's data in a blob the player pastes into a bug report.
    const s = seeded();
    s.setItem('portfolio.session', 'secret');
    const blob = parse(exportSave(s));
    expect('portfolio.session' in blob.keys).toBe(false);
  });

  it('exports what it can from a storage whose getItem throws', () => {
    const s = createMemoryStorage();
    s.setItem('tanks.progress.v1', '2');
    let calls = 0;
    const flaky: Storage = {
      ...s,
      getItem(key: string): string | null {
        calls += 1;
        if (key === 'tanks.stats.v1') throw new Error('nope');
        return s.getItem(key);
      },
    } as Storage;
    const blob = parse(exportSave(flaky));
    expect(calls).toBe(SAVE_KEYS.length); // it kept going rather than bailing out
    expect(blob.keys['tanks.progress.v1']).toBe('2');
    expect('tanks.stats.v1' in blob.keys).toBe(false);
  });

  it('is stable: the same state exports byte-identically twice', () => {
    // Fixed key order, so two exports are diffable. Object.keys order would follow
    // insertion order into the storage otherwise.
    const a = exportSave(seeded());
    const b = exportSave(seeded());
    expect(a).toBe(b);
  });
});

describe('importSave', () => {
  it('round-trips the whole save into an empty storage', () => {
    const from = seeded();
    const to = createMemoryStorage();
    const result = importSave(to, exportSave(from));
    expect(result.ok).toBe(true);
    expect(result.applied.slice().sort()).toEqual(SAVE_KEYS.slice().sort());
    for (const key of SAVE_KEYS) expect(to.getItem(key)).toBe(from.getItem(key));
  });

  it('produces a save the real stores read back correctly', () => {
    // The round trip that matters: not "the strings match" but "the game comes up
    // with the imported progress and paint". Reads through the real stores, which
    // is the only thing that proves the blob is still valid to THEM.
    const to = createMemoryStorage();
    importSave(to, exportSave(seeded()));
    const stores = createStores(to);
    expect(stores.progress.highestCleared()).toBe(3);
    expect(stores.customization.hull()).toBe('green');
    expect(stores.customization.skin()).toBe('camo');
    expect(stores.touchSettings.scheme()).toBe('point');
    expect(stores.touchSettings.fireMode()).toBe('button');
    expect([...stores.achievements.earned()]).toEqual(['first-blood']);
    expect(stores.stats.lifetime().shotsFired).toBe(12);
  });

  it('refuses a blob that is not a save, and writes NOTHING when it does', () => {
    // Population: the 6 rejection branches importSave has -- unparseable, non-object,
    // wrong format, missing/invalid version, newer version, missing keys object.
    const cases: Array<[string, string]> = [
      ['not JSON', '{oops'],
      ['not a save object', '[1,2,3]'],
      ['not a tanks.save blob', JSON.stringify({ format: 'something.else', version: 1, keys: {} })],
      ['missing or invalid version', JSON.stringify({ format: SAVE_FORMAT, keys: {} })],
      ['newer version', JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION + 1, keys: {} })],
      ['missing keys object', JSON.stringify({ format: SAVE_FORMAT, version: 1, keys: 'nope' })],
    ];
    for (const [what, text] of cases) {
      const to = seeded();
      const before = exportSave(to);
      const result = importSave(to, text);
      expect(result.ok, what).toBe(false);
      expect(result.reason, what).not.toBeNull();
      expect(result.applied, what).toEqual([]);
      // and the existing save is untouched
      expect(exportSave(to), what).toBe(before);
    }
  });

  it('accepts an OLDER blob version, since only a newer one can carry a shape we lack', () => {
    const to = createMemoryStorage();
    const result = importSave(
      to,
      JSON.stringify({ format: SAVE_FORMAT, version: 1, keys: { 'tanks.progress.v1': '5' } }),
    );
    expect(result.ok).toBe(true);
    expect(to.getItem('tanks.progress.v1')).toBe('5');
  });

  it('never writes a key outside the allow-list', () => {
    // The security property: this origin's namespace is shared, so a blob a player
    // was talked into pasting must not be able to set another app's key.
    const to = createMemoryStorage();
    const result = importSave(
      to,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: 1,
        keys: { 'tanks.progress.v1': '4', 'portfolio.session': 'stolen', 'tanks.progress.v2': 'x' },
      }),
    );
    expect(result.applied).toEqual(['tanks.progress.v1']);
    expect(result.ignored.sort()).toEqual(['portfolio.session', 'tanks.progress.v2']);
    expect(to.getItem('portfolio.session')).toBeNull();
    expect(to.getItem('tanks.progress.v2')).toBeNull();
    expect(to.length).toBe(1);
  });

  it('ignores a known key whose value is not a string', () => {
    // localStorage holds strings. A number here would make every store's
    // `typeof raw === 'string'` reasoning wrong at the next read.
    const to = createMemoryStorage();
    const result = importSave(
      to,
      JSON.stringify({ format: SAVE_FORMAT, version: 1, keys: { 'tanks.progress.v1': 7 } }),
    );
    expect(result.applied).toEqual([]);
    expect(result.ignored).toEqual(['tanks.progress.v1']);
    expect(to.getItem('tanks.progress.v1')).toBeNull();
  });

  it('leaves a key the blob omits ALONE rather than clearing it', () => {
    // "This export predates achievements" and "this save has no achievements" are
    // indistinguishable, so the safe reading is the non-destructive one.
    const to = seeded();
    const result = importSave(
      to,
      JSON.stringify({ format: SAVE_FORMAT, version: 1, keys: { 'tanks.progress.v1': '9' } }),
    );
    expect(result.ok).toBe(true);
    expect(to.getItem('tanks.progress.v1')).toBe('9');
    expect(to.getItem('tanks.achievements.v1')).toBe('{"earned":["first-blood"]}');
  });

  it('reports a write that throws as failed, not as applied', () => {
    const backing = createMemoryStorage();
    const readOnly: Storage = {
      ...backing,
      getItem: (k: string) => backing.getItem(k),
      setItem(key: string): void {
        if (key === 'tanks.stats.v1') throw new Error('quota');
        // everything else lands
        backing.setItem(key, 'written');
      },
    } as Storage;
    const result = importSave(
      readOnly,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: 1,
        keys: { 'tanks.progress.v1': '1', 'tanks.stats.v1': '{}' },
      }),
    );
    expect(result.applied).toEqual(['tanks.progress.v1']);
    expect(result.failed).toEqual(['tanks.stats.v1']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('storage refused a write');
  });
});

describe('createSaveApi', () => {
  it('exports and imports through the storage it was built with', () => {
    const from = seeded();
    const to = createMemoryStorage();
    const api = createSaveApi(to);
    expect(api.keys).toEqual(SAVE_KEYS);
    // Empty to start: proves `export` reads `to`, not some other storage.
    expect(Object.keys(parse(api.export()).keys)).toEqual([]);
    api.import(createSaveApi(from).export());
    expect(Object.keys(parse(api.export()).keys).sort()).toEqual(SAVE_KEYS.slice().sort());
    expect(to.getItem('tanks.progress.v1')).toBe('3');
  });
});
