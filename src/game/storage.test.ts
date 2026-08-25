import { describe, it, expect } from 'vitest';
import { createMemoryStorage, resolveStorage, createStores, type GameStores } from './storage';
import { PROGRESS_KEY } from './progress';
import { STATS_KEY } from './stats';
import { CUSTOM_KEY } from './customization';
import { SETTINGS_KEY } from './settings';
import { ACHIEVEMENTS_KEY } from './achievements';
import { RUN_KEY } from './run';
import { CAMPAIGN_LEVELS } from '../sim/arena';

/** Every key the six stores own, as the wire strings the browser sees. */
const ALL_KEYS = [PROGRESS_KEY, STATS_KEY, CUSTOM_KEY, SETTINGS_KEY, ACHIEVEMENTS_KEY, RUN_KEY];

/** Make each of the six stores write, so their keys have to appear somewhere. */
function writeThroughEveryStore(stores: GameStores): void {
  stores.progress.recordCleared(CAMPAIGN_LEVELS[1]);
  stores.stats.resetLifetime();
  stores.customization.setHull('red');
  stores.settings.setTouchScheme('point');
  stores.achievements.reset();
  stores.run.startNewRun('level-01');
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
  it('puts all six stores on the storage it was handed, and no others', () => {
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
