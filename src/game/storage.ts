import { createProgressStore, type ProgressStore } from './progress';
import { createStatsStore, type StatsStore } from './stats';
import { createCustomizationStore, type CustomizationStore } from './customization';
import {
  createPlayerSettingsStore,
  type PlayerSettingsStore,
  type StorageAvailability,
} from './settings';
import { createAchievementsStore, type AchievementsStore } from './achievements';
import { createRunStore, type RunStore } from './run';

/**
 * The ONE place the game decides where persisted state lives.
 *
 * Every store already takes an injected `Storage` -- progress, stats,
 * customization, player settings, achievements and the active run -- and loop.ts
 * resolved the real one inline, five times over. That inline resolver was untestable (it read
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
  return resolveStorageWithStatus(host).storage;
}

/**
 * What `resolveStorage` found, plus WHICH of the two it was.
 *
 * The fallback above is deliberately silent -- the game boots and plays either way -- and
 * that silence is exactly what issue #320 objects to: nothing downstream could tell a
 * session whose settings will be saved from one whose settings die with the page, so the
 * player was never told either. This is the smallest seam that distinguishes them.
 *
 * Still NOT a write probe. A probe would put a key in a namespace this origin SHARES with
 * the rest of austinorphan.com (CLAUDE.md), so `'persistent'` here means "a real Storage
 * object exists", not "writes succeed". Safari private mode -- a real `localStorage`
 * whose `setItem` throws -- reports `'persistent'` here and is caught on the first failed
 * write instead (settings.ts's `SettingsStatus.persistence`). The two facts are kept
 * apart on purpose: folding them together is what would make private mode claim to save.
 */
export interface ResolvedStorage {
  readonly storage: Storage;
  readonly availability: StorageAvailability;
}

export function resolveStorageWithStatus(
  host: StorageHost = globalThis as StorageHost,
): ResolvedStorage {
  try {
    if (host.localStorage) return { storage: host.localStorage, availability: 'persistent' };
  } catch {
    // Access threw: fall through to the shim.
  }
  return { storage: createMemoryStorage(), availability: 'memory' };
}

export interface GameStores {
  progress: ProgressStore;
  stats: StatsStore;
  customization: CustomizationStore;
  /**
   * Every durable player preference: mute, volume, touch scheme, fire mode, device
   * haptics, controller rumble, motion policy and UI scale (settings.ts). Replaces the
   * old `touchSettings` store, whose three fields it absorbed -- there is exactly one
   * writable settings source, and `tanks.touch.v1` is now a migration read only.
   */
  settings: PlayerSettingsStore;
  achievements: AchievementsStore;
  /** The active campaign run -- see run.ts. Distinct from `progress`, per the spec. */
  run: RunStore;
}

/**
 * All six stores on ONE storage, by signature.
 *
 * loop.ts used to call the resolver once per store. With a real localStorage that
 * was harmless (the same object comes back every time); with the shim it would
 * hand each store its OWN private Map, so the six keys would live in six
 * namespaces and an export of "the save" would see one of them. Taking a single
 * `Storage` makes that structural rather than a rule someone has to remember.
 *
 * @param availability what `resolveStorageWithStatus` found. Only the settings store
 * reads it, and only to report status: it is the difference between "your settings are
 * saved" and "they die with this page", which no store can work out from a `Storage`
 * object alone. Defaults to `'persistent'` so a caller handing over a real localStorage
 * (or a test's memory storage standing in for one) says nothing extra.
 */
export function createStores(
  storage: Storage,
  availability: StorageAvailability = 'persistent',
): GameStores {
  return {
    progress: createProgressStore(storage),
    stats: createStatsStore(storage),
    customization: createCustomizationStore(storage),
    settings: createPlayerSettingsStore(storage, { availability }),
    achievements: createAchievementsStore(storage),
    run: createRunStore(storage),
  };
}
