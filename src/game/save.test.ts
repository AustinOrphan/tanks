import { describe, it, expect } from 'vitest';
import { createMemoryStorage, createStores } from './storage';
import {
  exportSave,
  importSave,
  createSaveApi,
  SAVE_KEYS,
  SAVE_IMPORT_KEYS,
  SAVE_FORMAT,
  SAVE_VERSION,
  type SaveBlob,
} from './save';
import { CAMPAIGN_LEVELS } from '../sim/arena';
import { SETTINGS_KEY, SETTINGS_SCHEMA_VERSION, serializeSettings, DEFAULT_SETTINGS } from './settings';
import { TOUCH_SETTINGS_KEY } from './touch-settings';

/** The canonical settings payload the seeded save carries. Built through the real serialiser. */
const SEEDED_SETTINGS = serializeSettings({
  ...DEFAULT_SETTINGS,
  input: { ...DEFAULT_SETTINGS.input, touchScheme: 'point', fireMode: 'button' },
});

function seeded(): Storage {
  const s = createMemoryStorage();
  s.setItem('tanks.progress.v1', '3');
  s.setItem('tanks.stats.v1', JSON.stringify({ shotsFired: 12, shellKills: 4 }));
  s.setItem('tanks.custom.v1', JSON.stringify({ hull: 'green', skin: 'camo', accent: 'gold' }));
  s.setItem(SETTINGS_KEY, SEEDED_SETTINGS);
  s.setItem('tanks.achievements.v1', JSON.stringify({ earned: ['first-blood'] }));
  s.setItem(
    'tanks.run.v2',
    JSON.stringify({ campaignId: 'main', currentLevelId: 'level-02', livesRemaining: 2, status: 'active' }),
  );
  return s;
}

function parse(text: string): SaveBlob {
  return JSON.parse(text) as SaveBlob;
}

describe('SAVE_KEYS', () => {
  it('is exactly the six tanks.* keys, in a fixed order', () => {
    // Pinned as LITERALS, not derived from the store modules: this is the wire
    // format. Renaming a store's key is a save-compatibility break and should
    // fail here rather than silently produce blobs an older build cannot read.
    // Population: all six keys an export carries.
    expect(SAVE_KEYS).toEqual([
      'tanks.progress.v1',
      'tanks.stats.v1',
      'tanks.custom.v1',
      'tanks.settings.v1',
      'tanks.achievements.v1',
      'tanks.run.v2',
    ]);
  });

  it('does NOT export the legacy touch key', () => {
    // The half of issue #320 an "importable" assertion cannot cover. Nothing in the
    // tree writes tanks.touch.v1 any more, so an export that still carried it would be
    // shipping whatever bytes happened to survive migration on that one device -- and
    // re-importing them elsewhere would resurrect settings the player had changed.
    expect(SAVE_KEYS).not.toContain(TOUCH_SETTINGS_KEY);
  });
});

describe('SAVE_IMPORT_KEYS', () => {
  it('is exactly SAVE_KEYS plus the legacy touch key -- a superset by ONE', () => {
    // Set equality in BOTH directions, not `toContain`. A one-way check would pass on
    // an allow-list that had been widened with something else as well, which is the
    // failure mode that matters: this list is the security boundary that keeps a pasted
    // blob from writing a neighbouring site's key on this shared origin.
    expect(SAVE_IMPORT_KEYS.slice().sort()).toEqual([...SAVE_KEYS, TOUCH_SETTINGS_KEY].sort());
    expect(SAVE_IMPORT_KEYS.length).toBe(SAVE_KEYS.length + 1);
  });

  it('covers every key the six stores actually write', () => {
    // The other direction, measured rather than asserted: drive all six stores
    // and check the keys that appear are the keys an export would carry. A seventh
    // store added without a SAVE_KEYS entry fails here -- which is the way this
    // list rots.
    const storage = createMemoryStorage();
    const stores = createStores(storage);
    stores.progress.recordCleared(CAMPAIGN_LEVELS[0]);
    stores.stats.resetLifetime();
    stores.customization.setHull('red');
    stores.settings.setTouchScheme('point');
    stores.achievements.reset();
    stores.run.startNewRun('level-01');
    const written: string[] = [];
    for (let i = 0; i < storage.length; i++) written.push(storage.key(i)!);
    expect(written.slice().sort()).toEqual(SAVE_KEYS.slice().sort());
  });
});

describe('exportSave', () => {
  it('carries every present key, with the raw stored strings', () => {
    const blob = parse(exportSave(seeded(), 'production'));
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
    const blob = parse(exportSave(s, 'production'));
    expect('tanks.achievements.v1' in blob.keys).toBe(false);
    expect(Object.keys(blob.keys)).toHaveLength(5);
  });

  it('never exports a key belonging to another app on the shared origin', () => {
    // austinorphan.com's localStorage namespace is shared with every other project
    // page there (CLAUDE.md). An export that dumped the whole namespace would put a
    // neighbouring app's data in a blob the player pastes into a bug report.
    const s = seeded();
    s.setItem('portfolio.session', 'secret');
    const blob = parse(exportSave(s, 'production'));
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
    const blob = parse(exportSave(flaky, 'production'));
    expect(calls).toBe(SAVE_KEYS.length); // it kept going rather than bailing out
    expect(blob.keys['tanks.progress.v1']).toBe('2');
    expect('tanks.stats.v1' in blob.keys).toBe(false);
  });

  it('is stable: the same state exports byte-identically twice', () => {
    // Fixed key order, so two exports are diffable. Object.keys order would follow
    // insertion order into the storage otherwise.
    const a = exportSave(seeded(), 'production');
    const b = exportSave(seeded(), 'production');
    expect(a).toBe(b);
  });
});

describe('importSave', () => {
  it('round-trips the whole save into an empty storage', () => {
    const from = seeded();
    const to = createMemoryStorage();
    const result = importSave(to, exportSave(from, 'production'), 'production');
    expect(result.ok).toBe(true);
    expect(result.applied.slice().sort()).toEqual(SAVE_KEYS.slice().sort());
    for (const key of SAVE_KEYS) expect(to.getItem(key)).toBe(from.getItem(key));
  });

  it('produces a save the real stores read back correctly', () => {
    // The round trip that matters: not "the strings match" but "the game comes up
    // with the imported progress and paint". Reads through the real stores, which
    // is the only thing that proves the blob is still valid to THEM.
    const to = createMemoryStorage();
    importSave(to, exportSave(seeded(), 'production'), 'production');
    const stores = createStores(to);
    expect(stores.progress.highestCleared()).toBe(3);
    expect(stores.customization.hull()).toBe('green');
    expect(stores.customization.skin()).toBe('camo');
    expect(stores.settings.snapshot().input.touchScheme).toBe('point');
    expect(stores.settings.snapshot().input.fireMode).toBe('button');
    expect([...stores.achievements.earned()]).toEqual(['first-blood']);
    expect(stores.stats.lifetime().shotsFired).toBe(12);
    expect(stores.run.active()).toEqual({
      campaignId: 'main',
      currentLevelId: 'level-02',
      livesRemaining: 2,
      status: 'active',
    });
  });

  it('refuses a blob that is not a save, and writes NOTHING when it does', () => {
    // Population: all 6 rejection branches importSave has -- unparseable,
    // non-object, wrong format, invalid version, newer version, missing keys
    // object -- and, INSIDE the version branch, all three of the disjuncts that
    // reach it: absent (fails `typeof === 'number'`), fractional (fails
    // `Number.isInteger`), and zero (fails `>= 1`). Sweeping only the absent case
    // left the other two disjuncts deletable: with the check cut down to
    // `typeof blob.version !== 'number'`, this file passed 16 of 16.
    //
    // ...and, inside the KEYS branch, all three of ITS disjuncts too: a non-object
    // (`'nope'`, fails `typeof === 'object'`), null (`typeof null` IS `'object'`,
    // so only the explicit null check rejects it) and an array (`typeof [] `is
    // `'object'` and it is not null, so only `Array.isArray` rejects it).
    //
    // An earlier version of this comment claimed a null or array `keys` "reaches
    // the same disjunct as a row below". That was FALSE and it hid a live
    // survivor: cutting the guard to `if (typeof keys !== 'object')` passed this
    // file 16 of 16, and under it `keys: []` returns `ok: true` on a malformed
    // blob while `keys: null` throws a TypeError straight out of importSave --
    // neither of which is the `ok: false` the caller is told to expect. Both are
    // rows now.
    //
    // NOT swept, and this list is what is genuinely left: a string or NaN
    // `version`, and a missing `format`. Each of those DOES reach a disjunct a row
    // below already covers -- `typeof blob.version !== 'number'` and
    // `blob.format !== SAVE_FORMAT` respectively -- rather than one of its own.
    //
    // `reason` is pinned as a LITERAL, not rebuilt from SAVE_FORMAT/SAVE_VERSION:
    // rebuilding it would restate the source expression and pass whatever the
    // source produced. It is the string a player sees in the console, so a silent
    // change to it should be a failure here. That makes the `newer version` row
    // fail the day SAVE_VERSION moves off 1, which is intended: bumping the wire
    // version should be a deliberate edit here too.
    const cases: Array<[string, string, string]> = [
      ['not JSON', '{oops', 'not JSON'],
      ['not a save object', '[1,2,3]', 'not a save object'],
      [
        'not a tanks.save blob',
        JSON.stringify({ format: 'something.else', version: 1, keys: {} }),
        'not a tanks.save blob',
      ],
      [
        'version absent',
        JSON.stringify({ format: SAVE_FORMAT, keys: {} }),
        'missing or invalid version',
      ],
      [
        'version 0',
        JSON.stringify({ format: SAVE_FORMAT, version: 0, keys: {} }),
        'missing or invalid version',
      ],
      [
        'version 1.5',
        JSON.stringify({ format: SAVE_FORMAT, version: 1.5, keys: {} }),
        'missing or invalid version',
      ],
      [
        'newer version',
        JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION + 1, keys: {} }),
        'save version 2 is newer than 1',
      ],
      [
        'keys is a string',
        JSON.stringify({ format: SAVE_FORMAT, version: 1, namespace: 'production', keys: 'nope' }),
        'missing keys object',
      ],
      [
        'keys is null',
        JSON.stringify({ format: SAVE_FORMAT, version: 1, namespace: 'production', keys: null }),
        'missing keys object',
      ],
      [
        // Not empty: an array carrying something makes the mutant's behaviour
        // visible as a WRITE attempt rather than as a no-op that happens to be ok.
        'keys is an array',
        JSON.stringify({ format: SAVE_FORMAT, version: 1, namespace: 'production', keys: ['tanks.progress.v1'] }),
        'missing keys object',
      ],
    ];
    for (const [what, text, reason] of cases) {
      const to = seeded();
      const before = exportSave(to, 'production');
      const result = importSave(to, text, 'production');
      expect(result.ok, what).toBe(false);
      expect(result.reason, what).toBe(reason);
      expect(result.applied, what).toEqual([]);
      // and the existing save is untouched
      expect(exportSave(to, 'production'), what).toBe(before);
    }
  });

  it('accepts an OLDER blob version, since only a newer one can carry a shape we lack', () => {
    const to = createMemoryStorage();
    const result = importSave(
      to,
      JSON.stringify({ format: SAVE_FORMAT, version: 1, namespace: 'production', keys: { 'tanks.progress.v1': '5' } }),
      'production',
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
        namespace: 'production',
        keys: { 'tanks.progress.v1': '4', 'portfolio.session': 'stolen', 'tanks.progress.v2': 'x' },
      }),
      'production',
    );
    expect(result.applied).toEqual(['tanks.progress.v1']);
    expect(result.ignored.sort()).toEqual(['portfolio.session', 'tanks.progress.v2']);
    expect(to.getItem('portfolio.session')).toBeNull();
    expect(to.getItem('tanks.progress.v2')).toBeNull();
    expect(to.length).toBe(1);
  });

  it('accepts an OLD export that still carries tanks.touch.v1', () => {
    // Backward compatibility, and the reason the import allow-list is wider than the
    // export list. A save taken before issue #320 has no tanks.settings.v1 at all; its
    // touch preferences are the only settings it carries, and refusing the key would
    // drop them silently on restore.
    const to = createMemoryStorage();
    const result = importSave(
      to,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: 1,
        namespace: 'production',
        keys: {
          'tanks.progress.v1': '4',
          [TOUCH_SETTINGS_KEY]: JSON.stringify({ scheme: 'point', fireMode: 'button', haptics: false }),
        },
      }),
      'production',
    );
    expect(result.ok).toBe(true);
    expect(result.applied.slice().sort()).toEqual([TOUCH_SETTINGS_KEY, 'tanks.progress.v1'].sort());
    expect(result.ignored).toEqual([]);
    // The RAW bytes, unchanged -- an import is a restore at the key/value layer.
    expect(to.getItem(TOUCH_SETTINGS_KEY)).toBe(
      JSON.stringify({ scheme: 'point', fireMode: 'button', haptics: false }),
    );

    // ...and after the project's established reload boundary (a fresh store
    // construction -- see createSaveApi's own note on why an import is invisible until
    // then), the legacy data has become canonical settings.
    const stores = createStores(to);
    const settings = stores.settings.snapshot();
    expect(settings.input.touchScheme).toBe('point');
    expect(settings.input.fireMode).toBe('button');
    expect(settings.input.deviceHaptics).toBe(false);
    expect(stores.settings.status().migratedLegacy).toBe(true);
    expect(to.getItem(TOUCH_SETTINGS_KEY)).toBeNull();
    expect(to.getItem(SETTINGS_KEY)).not.toBeNull();
  });

  it('lets CANONICAL settings win when a blob carries both keys', () => {
    // A hand-merged or partially-upgraded blob. The two disagree on every field they
    // share, so whichever wins is unambiguous -- a fixture where they agreed would pass
    // under either rule.
    const to = createMemoryStorage();
    const canonical = serializeSettings({
      ...DEFAULT_SETTINGS,
      input: {
        ...DEFAULT_SETTINGS.input,
        touchScheme: 'stick',
        fireMode: 'tap',
        deviceHaptics: true,
      },
    });
    const result = importSave(
      to,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: 1,
        namespace: 'production',
        keys: {
          [SETTINGS_KEY]: canonical,
          [TOUCH_SETTINGS_KEY]: JSON.stringify({ scheme: 'point', fireMode: 'button', haptics: false }),
        },
      }),
      'production',
    );
    expect(result.ok).toBe(true);
    const settings = createStores(to).settings.snapshot();
    expect(settings.input.touchScheme).toBe('stick');
    expect(settings.input.fireMode).toBe('tap');
    expect(settings.input.deviceHaptics).toBe(true);
    // The loser is cleared, so there is exactly one settings key afterwards.
    expect(to.getItem(TOUCH_SETTINGS_KEY)).toBeNull();
  });

  it('round-trips a FUTURE-schema settings payload byte for byte', () => {
    // The property the raw key/value layer exists for. This build cannot interpret a
    // version-2 payload and deliberately refuses to overwrite it (settings.ts); an
    // export taken on this build must still carry it back out intact, or a player who
    // downgraded once would lose settings a newer build wrote.
    const from = createMemoryStorage();
    const future = JSON.stringify({
      version: SETTINGS_SCHEMA_VERSION + 1,
      audio: { muted: true, volume: 0.1 },
      somethingNew: { fromTheFuture: true },
    });
    from.setItem(SETTINGS_KEY, future);
    // Constructing the store must not rewrite it, and the export must carry the
    // original bytes.
    createStores(from);
    expect(from.getItem(SETTINGS_KEY)).toBe(future);
    expect(parse(exportSave(from, 'production')).keys[SETTINGS_KEY]).toBe(future);
  });

  it('ignores a known key whose value is not a string', () => {
    // localStorage holds strings. A number here would make every store's
    // `typeof raw === 'string'` reasoning wrong at the next read.
    const to = createMemoryStorage();
    const result = importSave(
      to,
      JSON.stringify({ format: SAVE_FORMAT, version: 1, namespace: 'production', keys: { 'tanks.progress.v1': 7 } }),
      'production',
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
      JSON.stringify({ format: SAVE_FORMAT, version: 1, namespace: 'production', keys: { 'tanks.progress.v1': '9' } }),
      'production',
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
        namespace: 'production',
        keys: { 'tanks.progress.v1': '1', 'tanks.stats.v1': '{}' },
      }),
      'production',
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
    const api = createSaveApi(to, 'production');
    expect(api.keys).toEqual(SAVE_KEYS);
    // Empty to start: proves `export` reads `to`, not some other storage.
    expect(Object.keys(parse(api.export()).keys)).toEqual([]);
    api.import(createSaveApi(from, 'production').export());
    expect(Object.keys(parse(api.export()).keys).sort()).toEqual(SAVE_KEYS.slice().sort());
    expect(to.getItem('tanks.progress.v1')).toBe('3');
  });
});

describe('save namespaces (issue #250)', () => {
  /** A blob exactly as some session would have written it. */
  function blobFrom(namespace: 'production' | 'developer' | undefined, keys: Record<string, string>): string {
    return JSON.stringify(
      namespace === undefined
        ? { format: SAVE_FORMAT, version: SAVE_VERSION, keys }
        : { format: SAVE_FORMAT, version: SAVE_VERSION, namespace, keys },
    );
  }

  it('every export states which namespace it came from', () => {
    // Acceptance criterion 1. The blob's KEYS are identical either way -- the adapter
    // prefixes underneath the store-facing names -- so this field is the only thing that
    // can tell two otherwise byte-identical exports apart.
    const dev = JSON.parse(exportSave(seeded(), 'developer')) as SaveBlob;
    const prod = JSON.parse(exportSave(seeded(), 'production')) as SaveBlob;
    expect(dev.namespace).toBe('developer');
    expect(prod.namespace).toBe('production');
    expect(Object.keys(dev.keys)).toEqual(Object.keys(prod.keys));
  });

  it('a matching namespace imports with no ceremony', () => {
    // Acceptance criterion 2, and the control for every refusal below: the gate must not
    // be refusing everything.
    const to = createMemoryStorage();
    const r = importSave(to, blobFrom('developer', { 'tanks.progress.v1': '5' }), 'developer');
    expect(r.ok).toBe(true);
    expect(r.sourceNamespace).toBe('developer');
    expect(to.getItem('tanks.progress.v1')).toBe('5');
  });

  it('a developer save is refused by a production session, and writes NOTHING', () => {
    // The defect itself: this is the import that used to silently overwrite the player's
    // real save with developer junk.
    const to = createMemoryStorage();
    to.setItem('tanks.progress.v1', 'REAL');
    const r = importSave(to, blobFrom('developer', { 'tanks.progress.v1': '5' }), 'production');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('developer');
    expect(r.sourceNamespace).toBe('developer');
    expect(r.applied).toEqual([]);
    expect(to.getItem('tanks.progress.v1'), 'the refused import still wrote').toBe('REAL');
  });

  it('...and a production save is refused by a developer session, the other direction', () => {
    const to = createMemoryStorage();
    const r = importSave(to, blobFrom('production', { 'tanks.progress.v1': '5' }), 'developer');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('production');
    expect(to.getItem('tanks.progress.v1')).toBeNull();
  });

  it('a blob with NO namespace is foreign, not assumed production', () => {
    // Acceptance criterion 5. `?dev=1&saveIo=1` has been exporting developer data into
    // unlabelled blobs since #245 landed after save.ts's last change on the same day, so
    // "no field" cannot be read as "production" -- it is genuinely unknown.
    const to = createMemoryStorage();
    to.setItem('tanks.progress.v1', 'REAL');
    const r = importSave(to, blobFrom(undefined, { 'tanks.progress.v1': '5' }), 'production');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not state its namespace');
    expect(r.sourceNamespace).toBeNull();
    expect(to.getItem('tanks.progress.v1')).toBe('REAL');
  });

  it('allowForeignNamespace is the explicit action that lets either through', () => {
    // Acceptance criterion 3: possible, but never by accident.
    const cross = createMemoryStorage();
    const crossResult = importSave(
      cross,
      blobFrom('developer', { 'tanks.progress.v1': '5' }),
      'production',
      { allowForeignNamespace: true },
    );
    expect(crossResult.ok).toBe(true);
    expect(crossResult.sourceNamespace, 'the provenance is still reported').toBe('developer');
    expect(cross.getItem('tanks.progress.v1')).toBe('5');

    const legacy = createMemoryStorage();
    const legacyResult = importSave(
      legacy,
      blobFrom(undefined, { 'tanks.progress.v1': '7' }),
      'production',
      { allowForeignNamespace: true },
    );
    expect(legacyResult.ok).toBe(true);
    expect(legacyResult.sourceNamespace).toBeNull();
    expect(legacy.getItem('tanks.progress.v1')).toBe('7');
  });

  it('an unrecognised namespace string is unknown, not malformed', () => {
    // A namespace a future build adds is exactly as foreign as a missing field, and
    // reporting it as a malformed blob would be a wrong diagnosis for a newer save.
    const to = createMemoryStorage();
    const r = importSave(
      to,
      JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION, namespace: 'staging', keys: { 'tanks.progress.v1': '5' } }),
      'production',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not state its namespace');
    expect(r.sourceNamespace).toBeNull();
  });
});

describe('importSave atomicity (issue #250)', () => {
  /**
   * A storage with a real BYTE QUOTA, seeded past nothing and capped at `capacity`.
   *
   * Modelled on how `localStorage` actually fails rather than as "throw after N writes":
   * a write that would exceed the cap throws, and a removal frees its bytes. That
   * distinction is load-bearing here — a throw-after-N fixture can never accept the
   * rollback's restore write either, so it reports a failed rollback for a reason no real
   * storage has, and it cannot tell a rollback that frees space first from one that does
   * not. `initial` is seeded through the underlying store so it cannot overflow the cap.
   */
  function quotaCapped(capacity: number, initial: Record<string, string> = {}): Storage {
    const real = createMemoryStorage();
    for (const [k, v] of Object.entries(initial)) real.setItem(k, v);
    const used = (): number => {
      let n = 0;
      for (let i = 0; i < real.length; i++) {
        const k = real.key(i)!;
        n += k.length + (real.getItem(k)?.length ?? 0);
      }
      return n;
    };
    return {
      get length(): number { return real.length; },
      key: (i: number) => real.key(i),
      getItem: (k: string) => real.getItem(k),
      removeItem: (k: string) => real.removeItem(k),
      clear: () => real.clear(),
      setItem: (k: string, v: string) => {
        const replacing = real.getItem(k);
        const after = used() - (replacing === null ? 0 : k.length + replacing.length) + k.length + v.length;
        if (after > capacity) throw new Error('quota exceeded');
        real.setItem(k, v);
      },
    } as Storage;
  }

  it('a write that throws part-way rolls the earlier keys back to what they held', () => {
    // Acceptance criterion 4. Before this, a failed import left the storage holding some
    // of the incoming save and some of the outgoing one -- a state neither export
    // describes, and the one thing a restore must never produce.
    // Cap admits the first replacement but not the second, which GROWS: 'tanks.stats.v1'
    // (14) + 'NEW-STATS-THAT-IS-LONGER' (24) needs 38 where the old value needed 23.
    const to = quotaCapped(55, { 'tanks.progress.v1': 'OLD-PROGRESS', 'tanks.stats.v1': 'OLD-STATS' });
    const r = importSave(
      to,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: SAVE_VERSION,
        namespace: 'production',
        keys: { 'tanks.progress.v1': 'NEW-PROGRESS', 'tanks.stats.v1': 'NEW-STATS-THAT-IS-LONGER' },
      }),
      'production',
    );
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(['tanks.stats.v1']);
    expect(r.rolledBack).toEqual(['tanks.progress.v1']);
    expect(to.getItem('tanks.progress.v1'), 'the first key kept the failed import').toBe('OLD-PROGRESS');
    expect(to.getItem('tanks.stats.v1')).toBe('OLD-STATS');
  });

  it('a key that had NO previous value is removed rather than left behind', () => {
    // The other half of "unchanged": restoring absent keys to their old value means
    // deleting them, not writing an empty string.
    const to = quotaCapped(55, { 'tanks.stats.v1': 'OLD-STATS' });
    const r = importSave(
      to,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: SAVE_VERSION,
        namespace: 'production',
        keys: { 'tanks.progress.v1': 'NEW-PROGRESS', 'tanks.stats.v1': 'NEW-STATS-THAT-IS-LONGER' },
      }),
      'production',
    );
    expect(r.ok).toBe(false);
    expect(to.getItem('tanks.progress.v1'), 'a key the save never had survived the rollback').toBeNull();
    expect(to.getItem('tanks.stats.v1')).toBe('OLD-STATS');
  });

  it('frees the space the failed import consumed, so a LONGER previous value fits again', () => {
    // The reason the rollback removes every applied key before restoring any of them.
    // Here the old value is longer than the one that replaced it, and a second key the
    // import added is still occupying the difference -- so restoring in place needs room
    // that only the removal pass creates. Deleting that pass makes this test fail with a
    // quota error, not merely with a key left behind.
    const OLD = 'X'.repeat(30);
    const to = quotaCapped(60, { 'tanks.progress.v1': OLD });
    const r = importSave(
      to,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: SAVE_VERSION,
        namespace: 'production',
        keys: {
          'tanks.progress.v1': 'a',
          'tanks.stats.v1': 'Y'.repeat(25),
          'tanks.custom.v1': 'Z'.repeat(20),
        },
      }),
      'production',
    );
    expect(r.ok).toBe(false);
    expect(r.failed, 'the third key should be the one that overflows').toEqual(['tanks.custom.v1']);
    expect(r.rolledBack.sort()).toEqual(['tanks.progress.v1', 'tanks.stats.v1']);
    expect(to.getItem('tanks.progress.v1'), 'the longer previous value did not fit back').toBe(OLD);
    expect(to.getItem('tanks.stats.v1'), 'a key the import added survived').toBeNull();
  });

  it('a fully successful import rolls nothing back', () => {
    // The negative control: `rolledBack` must be empty on the happy path, or the two
    // assertions above would pass against an implementation that always restores.
    const to = createMemoryStorage();
    const r = importSave(
      to,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: SAVE_VERSION,
        namespace: 'production',
        keys: { 'tanks.progress.v1': '5' },
      }),
      'production',
    );
    expect(r.ok).toBe(true);
    expect(r.rolledBack).toEqual([]);
    expect(to.getItem('tanks.progress.v1')).toBe('5');
  });
});
