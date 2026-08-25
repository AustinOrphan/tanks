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
import { parseDeveloperMode } from './devflags';

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

/**
 * Which key namespace a session persists into (issue #245).
 *
 * `production` is what every ordinary URL gets and what every build shipped before this
 * existed. `developer` is what a `?dev=1` session gets, so that dev level jumps, sandbox
 * events and achievement checks cannot reach the keys holding a real player's campaign.
 */
export const STORAGE_NAMESPACES = ['production', 'developer'] as const;
export type StorageNamespace = (typeof STORAGE_NAMESPACES)[number];

/**
 * The prefix a developer session's keys carry.
 *
 * Applied to the WHOLE key, so `tanks.progress.v1` becomes
 * `tanks.dev.tanks.progress.v1` rather than the tidier `tanks.dev.progress.v1`. That
 * redundancy buys a property the tidier form cannot have: the mapping is INJECTIVE with
 * one code path and no branch. Stripping a leading `tanks.` and re-prefixing would send
 * `tanks.progress.v1` and a hypothetical `progress.v1` to the SAME underlying key, so two
 * stores could clobber each other in developer sessions and nowhere else -- and `key(i)`
 * would have no inverse. Guarding that with a fallback branch instead would add a branch
 * no test can kill, the thing `createMemoryStorage.key` above declines to do.
 *
 * It stays inside the `tanks.` prefix deliberately: this origin is SHARED with the rest of
 * austinorphan.com (see save.ts), so a developer namespace must not colonise a new
 * top-level prefix there.
 */
export const DEVELOPER_KEY_PREFIX = 'tanks.dev.';

/** The underlying key a store-facing key lands on. Identity in `production`. */
export function namespacedKey(namespace: StorageNamespace, key: string): string {
  return namespace === 'developer' ? `${DEVELOPER_KEY_PREFIX}${key}` : key;
}

/**
 * The namespace a query string selects.
 *
 * Keyed to the `dev` GATE (`parseDeveloperMode`), not to any individual flag: `?aimRay=1`
 * alone turns nothing on, so it must not move the session off the production keys either.
 * Pure, so the whole table is assertable without a browser -- the same reason
 * `parseDevFlags` takes a string.
 */
export function selectStorageNamespace(search: string): StorageNamespace {
  return parseDeveloperMode(search) ? 'developer' : 'production';
}

/**
 * A `Storage` that reads and writes inside one namespace.
 *
 * `production` returns the base object ITSELF, not an equivalent wrapper. That is what
 * makes "ordinary URLs retain current key names and behavior" provable rather than
 * argued: on a production session there is no code between the stores and the browser.
 *
 * `length`, `key(i)` and `clear()` are scoped too, not just the three key-addressed
 * methods. Nothing in `src/` enumerates a `Storage` today -- save.ts works from the
 * explicit `SAVE_KEYS` allow-list -- but an unscoped `clear()` on a developer session
 * would wipe the player's real save, which is the single most damaging thing this
 * adapter could do, and the scoping is what stops it being one line away.
 *
 * Deliberately does NOT catch. Every store already wraps its own reads and writes and
 * degrades (progress.ts, achievements.ts); swallowing here would turn Safari private mode
 * into a silent no-op the stores never learn about.
 */
export function createNamespacedStorage(base: Storage, namespace: StorageNamespace): Storage {
  if (namespace === 'production') return base;

  const underlying = (key: string): string => namespacedKey(namespace, String(key));

  /** The store-facing names currently present, in the base storage's own order. */
  function names(): string[] {
    const out: string[] = [];
    for (let index = 0; index < base.length; index += 1) {
      const key = base.key(index);
      if (key !== null && key.startsWith(DEVELOPER_KEY_PREFIX)) {
        out.push(key.slice(DEVELOPER_KEY_PREFIX.length));
      }
    }
    return out;
  }

  return {
    get length(): number {
      return names().length;
    },
    key(index: number): string | null {
      // `?? null` covers a negative, fractional or out-of-range index the same way
      // createMemoryStorage does: it simply never matches.
      return names()[index] ?? null;
    },
    getItem(key: string): string | null {
      return base.getItem(underlying(key));
    },
    setItem(key: string, value: string): void {
      base.setItem(underlying(key), value);
    },
    removeItem(key: string): void {
      base.removeItem(underlying(key));
    },
    clear(): void {
      for (const name of names()) base.removeItem(underlying(name));
    },
  };
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
