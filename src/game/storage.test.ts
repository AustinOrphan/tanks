import { describe, it, expect } from 'vitest';
import {
  createMemoryStorage,
  createNamespacedStorage,
  createStores,
  namespacedKey,
  resolveStorage,
  selectStorageNamespace,
  DEVELOPER_KEY_PREFIX,
  STORAGE_NAMESPACES,
  type GameStores,
  type StorageNamespace,
} from './storage';
import { TOUCH_SETTINGS_KEY } from './touch-settings';
import { exportSave, importSave, SAVE_FORMAT, SAVE_VERSION } from './save';
import { PROGRESS_KEY } from './progress';
import { STATS_KEY } from './stats';
import { CUSTOM_KEY } from './customization';
import { SETTINGS_KEY } from './settings';
import { ACHIEVEMENTS_KEY } from './achievements';
import { RUN_KEY } from './run';
import { VERSUS_SETUP_KEY } from './versus-setup-store';
import { CAMPAIGN_LEVELS } from '../sim/arena';

/** Every key the six stores own, as the wire strings the browser sees. */
const ALL_KEYS = [PROGRESS_KEY, STATS_KEY, CUSTOM_KEY, SETTINGS_KEY, ACHIEVEMENTS_KEY, RUN_KEY, VERSUS_SETUP_KEY];

/**
 * One write per store in `GameStores`, keyed by that store's own field name.
 *
 * A keyed record rather than a flat function body so `Object.keys` is an INVENTORY.
 * Adding an eighth store to `GameStores` without adding a driver here fails
 * `covers every store in GameStores` below -- which is the only thing standing between a
 * new store and a silent bypass of the developer namespace (issue #245). A flat function
 * cannot fail that way: it just quietly stops covering the new store.
 */
const STORE_WRITES: Record<keyof GameStores, (stores: GameStores) => void> = {
  progress: (s) => s.progress.recordCleared(CAMPAIGN_LEVELS[1]),
  stats: (s) => s.stats.resetLifetime(),
  customization: (s) => s.customization.setHull('red'),
  settings: (s) => s.settings.setTouchScheme('point'),
  achievements: (s) => s.achievements.reset(),
  run: (s) => s.run.startNewRun('level-01'),
  versusSetup: (s) => s.versusSetup.set({ ...s.versusSetup.get(), players: 4 }),
};

/** Make each of the seven stores write, so their keys have to appear somewhere. */
function writeThroughEveryStore(stores: GameStores): void {
  for (const write of Object.values(STORE_WRITES)) write(stores);
}

/** Every key in the base storage, in insertion order. */
function rawKeys(storage: Storage): string[] {
  const seen: string[] = [];
  for (let i = 0; i < storage.length; i++) seen.push(storage.key(i)!);
  return seen;
}

describe('createMemoryStorage', () => {
  it('round-trips a value', () => {
    const s = createMemoryStorage();
    s.setItem('a', 'one');
    expect(s.getItem('a')).toBe('one');
  });

  it('answers null -- not undefined -- for a key it never saw', () => {
    // Every store tests `raw === null` for "nothing saved". `undefined` would fall
    // through those guards into JSON.parse(undefined).
    const s = createMemoryStorage();
    expect(s.getItem('missing')).toBeNull();
    expect(s.getItem('missing')).not.toBeUndefined();
  });

  it('removes and clears', () => {
    const s = createMemoryStorage();
    s.setItem('a', '1');
    s.setItem('b', '2');
    s.removeItem('a');
    expect(s.getItem('a')).toBeNull();
    expect(s.getItem('b')).toBe('2');
    s.clear();
    expect(s.getItem('b')).toBeNull();
    expect(s.length).toBe(0);
  });

  it('reports length and enumerates keys in insertion order', () => {
    const s = createMemoryStorage();
    expect(s.length).toBe(0);
    s.setItem('first', '1');
    s.setItem('second', '2');
    expect(s.length).toBe(2);
    expect(s.key(0)).toBe('first');
    expect(s.key(1)).toBe('second');
    // Out of range is null, not undefined and not a throw -- same contract as the
    // browser's, and save.ts enumerates by index.
    expect(s.key(2)).toBeNull();
    expect(s.key(-1)).toBeNull();
  });

  it('overwrites rather than appending', () => {
    const s = createMemoryStorage();
    s.setItem('a', '1');
    s.setItem('a', '2');
    expect(s.getItem('a')).toBe('2');
    expect(s.length).toBe(1);
  });

  it('coerces a non-string value to a string, exactly as the browser does', () => {
    const s = createMemoryStorage();
    // The cast is the point: this is what untyped JS reaching the shim looks like,
    // and a store that read a number back where the browser would have given it "1"
    // would behave differently in the two environments.
    (s as unknown as { setItem(k: string, v: unknown): void }).setItem('n', 1);
    expect(s.getItem('n')).toBe('1');
  });
});

describe('resolveStorage', () => {
  it('returns the host storage ITSELF when there is one', () => {
    // Identity, not "some storage": handing back a shim when a real localStorage
    // exists would silently stop persisting anything, and a round-trip assertion
    // would pass on the shim.
    const real = createMemoryStorage();
    expect(resolveStorage({ localStorage: real })).toBe(real);
  });

  it('falls back to a WORKING storage when the host has none', () => {
    const s = resolveStorage({});
    expect(s).toBeDefined();
    // Round-tripped, not merely non-null: the fallback used to be an inert
    // stand-in whose setItem dropped everything, and `expect(s).toBeTruthy()`
    // passes on that too.
    s.setItem('k', 'v');
    expect(s.getItem('k')).toBe('v');
  });

  it('falls back when the property ACCESS throws', () => {
    // The locked-down-context case: reading `localStorage` is itself a SecurityError.
    // Without the try/catch this test throws rather than fails, which is still red.
    const host = {
      get localStorage(): Storage {
        throw new Error('SecurityError');
      },
    };
    const s = resolveStorage(host);
    s.setItem('k', 'v');
    expect(s.getItem('k')).toBe('v');
  });

  it('gives each caller its OWN shim, so two resolutions do not alias', () => {
    // Not a preference: it is what makes createStores' single-storage signature
    // load-bearing rather than decorative. If the shim were a module-level
    // singleton, five separate resolutions would accidentally agree and the
    // five-namespace defect createStores prevents could not be demonstrated.
    const a = resolveStorage({});
    const b = resolveStorage({});
    a.setItem('k', 'v');
    expect(b.getItem('k')).toBeNull();
  });
});

describe('createStores', () => {
  it('puts all seven stores on the storage it was handed, and no others', () => {
    // Population: all six stores in GameStores, each driven through a write.
    // The exact-set assertion is what catches a store wired to its own private
    // storage (its key would be missing) as well as one writing a stray key.
    const storage = createMemoryStorage();
    writeThroughEveryStore(createStores(storage));
    const seen: string[] = [];
    for (let i = 0; i < storage.length; i++) seen.push(storage.key(i)!);
    expect(seen.slice().sort()).toEqual(ALL_KEYS.slice().sort());
  });

  it('reads through that same storage too, not just writes', () => {
    // A store handed the wrong storage on READ boots at its default and looks
    // perfectly healthy -- the failure only shows as "my save vanished".
    const storage = createMemoryStorage();
    storage.setItem(PROGRESS_KEY, '3');
    storage.setItem(CUSTOM_KEY, JSON.stringify({ hull: 'green', skin: 'camo', accent: 'gold' }));
    const stores = createStores(storage);
    expect(stores.progress.highestCleared()).toBe(3);
    expect(stores.customization.hull()).toBe('green');
    expect(stores.customization.skin()).toBe('camo');
  });

  it('survives a storage whose every method throws', () => {
    // Safari private mode. Construction must not throw -- the game boots at
    // defaults and loses only persistence.
    const hostile = {
      get length(): number {
        throw new Error('nope');
      },
      key: (): string | null => {
        throw new Error('nope');
      },
      getItem: (): string | null => {
        throw new Error('nope');
      },
      setItem: (): void => {
        throw new Error('nope');
      },
      removeItem: (): void => {
        throw new Error('nope');
      },
      clear: (): void => {
        throw new Error('nope');
      },
    } as Storage;
    const stores = createStores(hostile);
    expect(stores.progress.highestCleared()).toBe(0);
    expect(() => writeThroughEveryStore(stores)).not.toThrow();
  });
});

describe('selectStorageNamespace', () => {
  it.each([
    ['', 'production'],
    ['?level=2', 'production'],
    ['?dev=0', 'production'],
    ['?dev=1', 'developer'],
    ['?dev', 'developer'],
    ['?dev=1&aimRay=1', 'developer'],
  ])('reads %o as the %s namespace', (search, expected) => {
    expect(selectStorageNamespace(search)).toBe(expected);
  });

  it('is the `dev` GATE, not any individual flag', () => {
    // `?aimRay=1` without `dev` turns nothing on (devflags.ts), so it must not move a
    // session off the production keys either.
    expect(selectStorageNamespace('?aimRay=1')).toBe('production');
  });
});

describe('createNamespacedStorage: production', () => {
  it('hands back the SAME object, so production keys stay byte-for-byte untouched', () => {
    // Identity, not an equivalent wrapper. It is what makes "ordinary URLs retain current
    // key names and behavior" (issue #245) provable rather than argued: there is no code
    // between the stores and the browser to get it wrong.
    const base = createMemoryStorage();
    expect(createNamespacedStorage(base, 'production')).toBe(base);
  });

  it('maps every key to itself', () => {
    for (const key of [...ALL_KEYS, TOUCH_SETTINGS_KEY]) {
      expect(namespacedKey('production', key)).toBe(key);
    }
  });
});

describe('createNamespacedStorage: developer', () => {
  function dev(): { base: Storage; storage: Storage } {
    const base = createMemoryStorage();
    return { base, storage: createNamespacedStorage(base, 'developer') };
  }

  it('writes under the developer prefix and leaves the production key absent', () => {
    const { base, storage } = dev();
    storage.setItem(PROGRESS_KEY, '3');

    expect(base.getItem(`${DEVELOPER_KEY_PREFIX}${PROGRESS_KEY}`)).toBe('3');
    expect(base.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('reads back its own writes', () => {
    const { storage } = dev();
    storage.setItem(PROGRESS_KEY, '3');
    expect(storage.getItem(PROGRESS_KEY)).toBe('3');
  });

  it('cannot see a production key, however it was written', () => {
    const { base, storage } = dev();
    base.setItem(PROGRESS_KEY, 'production');
    expect(storage.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('removes only its own key', () => {
    const { base, storage } = dev();
    base.setItem(PROGRESS_KEY, 'production');
    storage.setItem(PROGRESS_KEY, 'developer');
    storage.removeItem(PROGRESS_KEY);

    expect(storage.getItem(PROGRESS_KEY)).toBeNull();
    expect(base.getItem(PROGRESS_KEY)).toBe('production');
  });

  it('clears only its own namespace', () => {
    const { base, storage } = dev();
    base.setItem(PROGRESS_KEY, 'production');
    base.setItem('some-other-app.session', 'not ours');
    storage.setItem(PROGRESS_KEY, 'developer');
    storage.setItem(STATS_KEY, 'developer');
    storage.clear();

    expect(storage.length).toBe(0);
    expect(rawKeys(base).sort()).toEqual([PROGRESS_KEY, 'some-other-app.session'].sort());
  });

  it('enumerates store-facing names, scoped to the namespace', () => {
    const { base, storage } = dev();
    base.setItem(PROGRESS_KEY, 'production');
    storage.setItem(STATS_KEY, 'developer');
    storage.setItem(CUSTOM_KEY, 'developer');

    expect(storage.length).toBe(2);
    expect(rawKeys(storage).sort()).toEqual([STATS_KEY, CUSTOM_KEY].sort());
  });

  it('answers null for an index outside the namespace', () => {
    const { storage } = dev();
    storage.setItem(STATS_KEY, 'developer');
    expect(storage.key(1)).toBeNull();
    expect(storage.key(-1)).toBeNull();
  });

  it('maps distinct store keys to distinct underlying keys, and inverts', () => {
    // Injectivity is the property that makes the developer namespace behave like the
    // production one. A mapping that collapsed two store keys onto one would let two
    // stores clobber each other in developer sessions and nowhere else, which is a
    // divergence no store-level test would attribute to the adapter.
    const keys = [...ALL_KEYS, TOUCH_SETTINGS_KEY];
    const mapped = keys.map((key) => namespacedKey('developer', key));
    expect(new Set(mapped).size).toBe(keys.length);

    const { storage } = dev();
    for (const key of keys) storage.setItem(key, key);
    expect(rawKeys(storage).sort()).toEqual(keys.slice().sort());
  });

  it('lets a throwing base storage throw, so a store degrade path still runs', () => {
    // The adapter must not catch. Every store wraps its own getItem/setItem and degrades
    // (progress.ts, achievements.ts); swallowing here would turn Safari private mode into
    // a silent no-op the stores never learn about.
    const hostile = {
      get length(): number {
        throw new Error('nope');
      },
      key: (): string | null => {
        throw new Error('nope');
      },
      getItem: (): string | null => {
        throw new Error('nope');
      },
      setItem: (): void => {
        throw new Error('nope');
      },
      removeItem: (): void => {
        throw new Error('nope');
      },
      clear: (): void => {
        throw new Error('nope');
      },
    } as Storage;
    const storage = createNamespacedStorage(hostile, 'developer');

    expect(() => storage.getItem(PROGRESS_KEY)).toThrow();
    expect(() => storage.setItem(PROGRESS_KEY, '3')).toThrow();
  });
});

describe('the developer namespace over the whole store inventory', () => {
  it('covers every store in GameStores', () => {
    // The inventory guard issue #245 asks for. Adding a store to `GameStores` and to
    // `createStores` without adding a driver to STORE_WRITES fails here, which is what
    // stops the namespace assertions below from quietly under-reporting.
    const stores = createStores(createMemoryStorage());
    expect(Object.keys(STORE_WRITES).slice().sort()).toEqual(Object.keys(stores).slice().sort());
  });

  it('leaves ZERO production keys behind when every store writes', () => {
    const base = createMemoryStorage();
    const storage = createNamespacedStorage(base, 'developer');
    writeThroughEveryStore(createStores(storage));

    const written = rawKeys(base);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith(DEVELOPER_KEY_PREFIX), `${key} escaped the namespace`).toBe(true);
    }
    expect(written.slice().sort()).toEqual(
      ALL_KEYS.map((key) => namespacedKey('developer', key)).slice().sort(),
    );
  });

  it('does not disturb production data a previous session wrote', () => {
    const base = createMemoryStorage();
    for (const key of ALL_KEYS) base.setItem(key, `production:${key}`);
    const before = ALL_KEYS.map((key) => base.getItem(key));

    writeThroughEveryStore(createStores(createNamespacedStorage(base, 'developer')));

    expect(ALL_KEYS.map((key) => base.getItem(key))).toEqual(before);
  });

  it('persists across a reload: a second store bundle reads the first one back', () => {
    const base = createMemoryStorage();
    const first = createStores(createNamespacedStorage(base, 'developer'));
    first.progress.recordCleared(CAMPAIGN_LEVELS[1]);
    const cleared = first.progress.highestCleared();
    expect(cleared).toBeGreaterThan(0);

    const second = createStores(createNamespacedStorage(base, 'developer'));
    expect(second.progress.highestCleared()).toBe(cleared);
  });

  it.each(STORAGE_NAMESPACES)('degrades the same way in the %s namespace', (namespace) => {
    const hostile = {
      get length(): number {
        throw new Error('nope');
      },
      key: (): string | null => {
        throw new Error('nope');
      },
      getItem: (): string | null => {
        throw new Error('nope');
      },
      setItem: (): void => {
        throw new Error('nope');
      },
      removeItem: (): void => {
        throw new Error('nope');
      },
      clear: (): void => {
        throw new Error('nope');
      },
    } as Storage;
    const stores = createStores(createNamespacedStorage(hostile, namespace as StorageNamespace));

    expect(stores.progress.highestCleared()).toBe(0);
    expect(() => writeThroughEveryStore(stores)).not.toThrow();
  });
});

describe('a developer session cannot reach production data', () => {
  /** run.ts deletes this at construction; it is not exported, so the control below pins it. */
  const LEGACY_RUN_KEY = 'tanks.run.v1';

  it('leaves a production legacy run record alone -- and the control proves the key is live', () => {
    // Control first: on the BASE storage, constructing the stores DOES delete it. Without
    // this the developer assertion below would keep passing if run.ts renamed the key, and
    // would then be pinning nothing.
    const control = createMemoryStorage();
    control.setItem(LEGACY_RUN_KEY, 'a real run record');
    createStores(control);
    expect(control.getItem(LEGACY_RUN_KEY)).toBeNull();

    const base = createMemoryStorage();
    base.setItem(LEGACY_RUN_KEY, 'a real run record');
    createStores(createNamespacedStorage(base, 'developer'));
    expect(base.getItem(LEGACY_RUN_KEY)).toBe('a real run record');
  });

  it('neither adopts nor deletes the production legacy touch settings', () => {
    const legacy = JSON.stringify({ scheme: 'point', fireMode: 'tap', haptics: false });

    // Control: on the base storage the settings store migrates and then clears the key.
    const control = createMemoryStorage();
    control.setItem(TOUCH_SETTINGS_KEY, legacy);
    expect(createStores(control).settings.snapshot().input.touchScheme).toBe('point');
    expect(control.getItem(TOUCH_SETTINGS_KEY)).toBeNull();

    const base = createMemoryStorage();
    base.setItem(TOUCH_SETTINGS_KEY, legacy);
    const stores = createStores(createNamespacedStorage(base, 'developer'));
    expect(stores.settings.snapshot().input.touchScheme).not.toBe('point');
    expect(base.getItem(TOUCH_SETTINGS_KEY)).toBe(legacy);
  });

  it('exports and imports through save.ts inside its own namespace', () => {
    // save.ts is the one path that reads and writes raw keys without going through a
    // store. It gets `AppSettings.storage`, so it inherits the namespace -- this pins that
    // the adapter is what scopes the KEYS. Since issue #250 save.ts also carries the
    // namespace as data, because the adapter cannot be asked which one it is: the keys it
    // exposes are the store-facing names either way, so a blob taken through it would
    // otherwise carry no trace of where it came from.
    const base = createMemoryStorage();
    for (const key of ALL_KEYS) base.setItem(key, `production:${key}`);
    const storage = createNamespacedStorage(base, 'developer');
    writeThroughEveryStore(createStores(storage));

    expect(exportSave(storage, 'developer')).not.toContain('production:');
    expect(exportSave(base, 'production')).toContain('production:');

    importSave(
      storage,
      JSON.stringify({
        format: SAVE_FORMAT,
        version: SAVE_VERSION,
        namespace: 'developer',
        keys: { [PROGRESS_KEY]: 'imported' },
      }),
      'developer',
    );
    expect(storage.getItem(PROGRESS_KEY)).toBe('imported');
    expect(base.getItem(PROGRESS_KEY)).toBe(`production:${PROGRESS_KEY}`);
  });
});
