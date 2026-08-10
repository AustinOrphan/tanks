import { createProgressStore, type ProgressStore } from './progress';
import { createStatsStore, type StatsStore } from './stats';
import { createCustomizationStore, type CustomizationStore } from './customization';
import { createTouchSettingsStore, type TouchSettingsStore } from './touch-settings';
import { createAchievementsStore, type AchievementsStore } from './achievements';

/**
 * The ONE place the game decides where persisted state lives.
 *
 * Every store already takes an injected `Storage` -- progress, stats,
 * customization, touch settings and achievements -- and loop.ts resolved the
 * real one inline, five times over. That inline resolver was untestable (it read
 * `globalThis` directly from a function nothing could call with a fake host) and
 * it made pointing the game at a different backend an edit inside 868 lines of
 * wiring rather than a one-file change.
 *
 * Moving it here makes the swap a one-file change WITH a test that can fail:
 * a Capacitor Preferences shim, a file-backed shim for a desktop shell, or the
 * in-memory shim below for a WebView that blocks storage all arrive by changing
 * what `resolveStorage` returns.
 *
 * Game layer only. `src/sim/` never persists anything -- a replay has to stay an
 * exact function of its inputs.
 */

/** Only what resolution needs from the global object, so a test can hand over a fake. */
export interface StorageHost {
  /** A getter that THROWS is the case that motivates the try/catch below. */
  readonly localStorage?: Storage;
}

/**
 * A complete, spec-shaped `Storage` backed by a Map.
 *
 * The stand-in this replaces was `{ getItem: () => null, setItem: () => {} }`
 * cast through `unknown as Storage`: it satisfied no other member, so any caller
 * reaching for `removeItem`, `clear`, `key` or `length` got a TypeError rather
 * than a degraded save. It also could not READ BACK what it was handed, which
 * matters now that save.ts round-trips the raw key/value layer -- an export
 * taken from the inert stand-in would always be empty.
 *
 * This is session-scoped and deliberately NOT persistent: it is the honest
 * behaviour for a context that refuses storage, and every store already treats
 * "nothing was saved" as a valid starting state.
 */
export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      // Insertion order, which is what Map iteration and the Storage spec agree on.
      // No range guard: an index outside 0..size-1 (including a negative or a
      // fraction) simply never matches, and the loop already answers null. A guard
      // here would be a branch no test could kill.
      let i = 0;
      for (const k of map.keys()) {
        if (i === index) return k;
        i += 1;
      }
      return null;
    },
    getItem(key: string): string | null {
      // `?? null`, never undefined: every store tests `raw === null` for "absent".
      return map.get(String(key)) ?? null;
    },
    setItem(key: string, value: string): void {
      // String(), like the real thing: `setItem('k', 1)` stores "1", and a store
      // reading a number back where it expected a string is a defect the browser
      // never produces.
      map.set(String(key), String(value));
    },
    removeItem(key: string): void {
      map.delete(String(key));
    },
    clear(): void {
      map.clear();
    },
  };
}

/**
 * The browser's localStorage when there is one, an in-memory shim when there is not.
 *
 * The try/catch guards the PROPERTY ACCESS, which is the failure mode a
 * locked-down context produces (the access itself throws). Throwing METHODS --
 * Safari private mode's `setItem` -- are handled by each store instead, because
 * only they know what degrading means for their own data.
 *
 * Deliberately does NOT write-probe. A probe would put a key in a namespace this
 * origin SHARES with the rest of austinorphan.com (see CLAUDE.md), and the stores
 * already survive a storage that accepts writes and drops them.
 */
export function resolveStorage(host: StorageHost = globalThis as StorageHost): Storage {
  try {
    if (host.localStorage) return host.localStorage;
  } catch {
    // Access threw: fall through to the shim.
  }
  return createMemoryStorage();
}

export interface GameStores {
  progress: ProgressStore;
  stats: StatsStore;
  customization: CustomizationStore;
  touchSettings: TouchSettingsStore;
  achievements: AchievementsStore;
}

/**
 * All five stores on ONE storage, by signature.
 *
 * loop.ts used to call the resolver once per store. With a real localStorage that
 * was harmless (the same object comes back every time); with the shim it would
 * hand each store its OWN private Map, so the five keys would live in five
 * namespaces and an export of "the save" would see one of them. Taking a single
 * `Storage` makes that structural rather than a rule someone has to remember.
 */
export function createStores(storage: Storage): GameStores {
  return {
    progress: createProgressStore(storage),
    stats: createStatsStore(storage),
    customization: createCustomizationStore(storage),
    touchSettings: createTouchSettingsStore(storage),
    achievements: createAchievementsStore(storage),
  };
}
