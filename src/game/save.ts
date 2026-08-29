import { PROGRESS_KEY } from './progress';
import { STATS_KEY } from './stats';
import { CUSTOM_KEY } from './customization';
import { TOUCH_SETTINGS_KEY } from './touch-settings';
import { SETTINGS_KEY } from './settings';
import { ACHIEVEMENTS_KEY } from './achievements';
import { RUN_KEY } from './run';
import type { StorageNamespace } from './storage';

/**
 * Serialise and restore the whole save: the six `tanks.*` keys an export carries, as one
 * blob -- plus one seventh key the IMPORTER still accepts for backward compatibility.
 *
 * localStorage is ORIGIN-scoped. The web game lives at `austinorphan.com`; a
 * wrapped mobile build lives at `capacitor://localhost` or `https://localhost`.
 * Those are different origins, so a player with web progress starts a wrapped
 * build at zero -- no progress, no achievements, no stats, no paint -- and until
 * now nothing in the tree could serialise that state or take it back.
 *
 * It is also the only backup a player has: the origin is SHARED with every other
 * project page on austinorphan.com (CLAUDE.md), so anything that clears storage
 * for that origin takes the save with it.
 *
 * Deliberately at the RAW key/value layer, not through the typed stores.
 * The stores validate on read and drop what they do not recognise, so a
 * store-level round trip would silently discard a field written by a newer
 * version of the game -- exactly the data an export exists to preserve. Junk is
 * still safe: each store already validates whatever it is handed at boot, so an
 * imported blob cannot produce an invalid game, only a defaulted one. An imported
 * `tanks.settings.v1` from a FUTURE schema is the one case that is neither: the settings
 * store recognises it, refuses to reinterpret or overwrite it, and runs the session on
 * defaults (settings.ts).
 */

/** The wire discriminator. Present so a pasted blob of some other JSON is rejected loudly. */
export const SAVE_FORMAT = 'tanks.save';

/**
 * The blob SCHEMA's version -- the shape below, not the shape of any key's value.
 * Each key's contents are versioned by its own key name (`tanks.progress.v1`).
 */
export const SAVE_VERSION = 1;

/**
 * Every key an export carries, in a fixed order.
 *
 * Sourced from the six store modules rather than retyped, so a renamed key
 * cannot leave this list pointing at a key nothing writes. The order is fixed so
 * two exports of the same state are byte-identical and diffable.
 *
 * `tanks.touch.v1` was here until issue #320; `tanks.settings.v1` takes its slot. A new
 * export must not keep emitting the legacy key, because no current build WRITES it -- an
 * export that carried it would be shipping whatever bytes happened to survive migration
 * on that device, and re-importing them elsewhere would resurrect settings the player had
 * already changed. See `SAVE_IMPORT_KEYS` for the other half of that decision.
 */
export const SAVE_KEYS: readonly string[] = Object.freeze([
  PROGRESS_KEY,
  STATS_KEY,
  CUSTOM_KEY,
  SETTINGS_KEY,
  ACHIEVEMENTS_KEY,
  RUN_KEY,
]);

/**
 * The IMPORT allow-list: every export key, plus `tanks.touch.v1` as a deliberate
 * compatibility key.
 *
 * Two lists rather than one, and this is the wider of the two on purpose. A save exported
 * before issue #320 carries `tanks.touch.v1` and nothing else about settings; refusing it
 * would silently drop that player's scheme, fire mode and haptics on restore. Widening
 * `SAVE_KEYS` instead would have made every NEW export emit a key nothing writes.
 *
 * This is a superset by EXACTLY one key, and it is still an allow-list -- the security
 * property is unchanged. The origin is shared with every other project page on
 * austinorphan.com, so a blob a player was talked into pasting still cannot set
 * `some-other-app.session`; it can only set keys this game already owns.
 *
 * A blob carrying BOTH keys applies both raw values, and the canonical one wins on the
 * next construction: `createPlayerSettingsStore` migrates from the legacy key only when
 * there is no usable canonical payload, then clears the legacy key (settings.ts).
 */
export const SAVE_IMPORT_KEYS: readonly string[] = Object.freeze([...SAVE_KEYS, TOUCH_SETTINGS_KEY]);

export interface SaveBlob {
  format: string;
  version: number;
  /**
   * Which namespace this data was read from (issue #250).
   *
   * OPTIONAL, and its absence is meaningful: a blob written before this field existed
   * cannot say. That is not the same as "production" -- the namespaced adapter shipped in
   * #245 on 2026-08-25 while `save.ts` was last touched earlier the same day, so
   * `?dev=1&saveIo=1` has been exporting DEVELOPER data into unlabelled blobs ever since.
   * An absent field therefore means genuinely unknown, and `importSave` treats it as
   * foreign rather than guessing. See `ImportOptions.allowForeignNamespace`.
   *
   * Adding it does NOT bump `SAVE_VERSION`, on the precedent already recorded in
   * `importSave`'s comment for `tanks.settings.v1`: the blob SCHEMA gains an optional
   * field, and an old build reading a new export ignores what it does not know.
   */
  namespace?: StorageNamespace;
  /** Only keys from SAVE_KEYS, each holding the RAW string the browser stored. */
  keys: Record<string, string>;
}

export interface ImportOptions {
  /**
   * Import a blob whose namespace is not this session's -- or which does not state one.
   *
   * The deliberate, warned action issue #250 requires. Default false: without it, the
   * only imports that proceed are the ones provably taken from the namespace they are
   * going back into.
   */
  readonly allowForeignNamespace?: boolean;
}

export interface ImportResult {
  /** Was the blob a well-formed save this build understands? */
  ok: boolean;
  /** Why not. `null` when ok. */
  reason: string | null;
  /** Keys written. */
  applied: string[];
  /** Keys the blob carried that this build will not write: unknown, or not a string. */
  ignored: string[];
  /** Keys whose write THREW -- a full or read-only storage. Distinct from ignored. */
  failed: string[];
  /**
   * The namespace the blob declared, or `null` for a blob written before issue #250.
   * Reported even when the import is refused, so a caller can say WHICH namespace the
   * player would be crossing into.
   */
  sourceNamespace: StorageNamespace | null;
  /**
   * Keys restored to their previous value after a failed write, so a partial import does
   * not survive. See `importSave` for the residual: a restore can itself throw.
   */
  rolledBack: string[];
}

/**
 * Read every save key that exists, as a JSON blob.
 *
 * An ABSENT key is omitted rather than exported as null: importing a blob taken
 * before a store existed must not blank that store, and "absent" and "empty" are
 * different states to every one of the six readers.
 */
export function exportSave(storage: Storage, namespace: StorageNamespace): string {
  const keys: Record<string, string> = {};
  for (const key of SAVE_KEYS) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      // A throwing storage exports what it can rather than failing the whole dump.
      continue;
    }
    if (raw !== null) keys[key] = raw;
  }
  // `namespace` before `keys`: the provenance is the first thing a human reading a
  // pasted blob should see, and the field order is what makes two exports of the same
  // state byte-identical (see SAVE_KEYS on why the key order is fixed).
  const blob: SaveBlob = { format: SAVE_FORMAT, version: SAVE_VERSION, namespace, keys };
  return JSON.stringify(blob, null, 2);
}

/**
 * Write a blob back over the six keys.
 *
 * Unknown keys are IGNORED, not written. That is a security property, not
 * tidiness: this origin's localStorage namespace is shared with every other
 * project page on austinorphan.com, so a blob a player was talked into pasting
 * must not be able to set `some-other-app.session`. The allow-list is SAVE_IMPORT_KEYS --
 * SAVE_KEYS plus the legacy touch key, and nothing else.
 *
 * A key the blob omits is left ALONE rather than cleared -- an import is a
 * restore, and there is no way to tell "this save has no achievements" from
 * "this export predates achievements".
 *
 * Adding `tanks.settings.v1` did NOT bump SAVE_VERSION. The blob SCHEMA is unchanged --
 * same three fields, same raw-string map -- and an old build reading a new export ignores
 * the unknown key exactly as its own allow-list already required. Bumping would have made
 * every new export unreadable by an old build for no wire-format reason.
 */
export function importSave(
  storage: Storage,
  text: string,
  active: StorageNamespace,
  opts: ImportOptions = {},
): ImportResult {
  const empty = {
    applied: [] as string[],
    ignored: [] as string[],
    failed: [] as string[],
    sourceNamespace: null as StorageNamespace | null,
    rolledBack: [] as string[],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON', ...empty };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not a save object', ...empty };
  }
  const blob = parsed as Partial<SaveBlob>;
  if (blob.format !== SAVE_FORMAT) {
    return { ok: false, reason: `not a ${SAVE_FORMAT} blob`, ...empty };
  }
  // A NEWER blob is refused; an older one would be accepted the day a version 2
  // exists, which is why this is `>` and not `!==`.
  if (typeof blob.version !== 'number' || !Number.isInteger(blob.version) || blob.version < 1) {
    return { ok: false, reason: 'missing or invalid version', ...empty };
  }
  if (blob.version > SAVE_VERSION) {
    return { ok: false, reason: `save version ${blob.version} is newer than ${SAVE_VERSION}`, ...empty };
  }
  const keys = blob.keys;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
    return { ok: false, reason: 'missing keys object', ...empty };
  }

  // Provenance, resolved BEFORE anything is written. An unrecognised string is treated as
  // unknown rather than rejected outright: a future namespace this build has never heard
  // of is exactly as foreign as a missing field, and refusing on that basis alone would
  // report "malformed" for a blob that is merely newer.
  const declared = blob.namespace;
  const source: StorageNamespace | null =
    declared === 'production' || declared === 'developer' ? declared : null;
  const withSource = { ...empty, sourceNamespace: source };
  if (source !== active && opts.allowForeignNamespace !== true) {
    // Two distinct reasons, because they are two distinct situations for the player: one
    // is a save from the OTHER namespace, the other is a save that cannot say. Both are
    // refused by the same opt-in, and neither writes anything.
    const reason =
      source === null
        ? 'save does not state its namespace; pass allowForeignNamespace to import it anyway'
        : `save came from the ${source} namespace, not ${active}; pass allowForeignNamespace to import it anyway`;
    return { ok: false, reason, ...withSource };
  }

  const applied: string[] = [];
  const ignored: string[] = [];
  const failed: string[] = [];
  const rolledBack: string[] = [];
  /**
   * What each key held before this import, captured as it is written.
   *
   * `Storage` has no transaction, so "failed imports leave the namespace unchanged"
   * (issue #250) is implemented as snapshot-and-restore. Captured per key immediately
   * before its write rather than all up front, because a `getItem` can throw too and a
   * blob whose first key writes fine should not be refused by a read of its last.
   */
  const previous = new Map<string, string | null>();
  for (const key of Object.keys(keys)) {
    const value = (keys as Record<string, unknown>)[key];
    if (!SAVE_IMPORT_KEYS.includes(key) || typeof value !== 'string') {
      ignored.push(key);
      continue;
    }
    try {
      previous.set(key, storage.getItem(key));
    } catch {
      previous.set(key, null);
    }
    try {
      storage.setItem(key, value);
      applied.push(key);
    } catch {
      failed.push(key);
    }
  }

  if (failed.length > 0) {
    // Roll back in TWO passes, and the order is the whole point.
    //
    // The overwhelmingly likely reason a write threw is that the storage is full, so a
    // rollback that simply wrote each previous value back would attempt the very
    // operation that just failed, on a storage no emptier than when it failed. Removing
    // every applied key FIRST frees at least as much space as the import consumed, which
    // is what makes the restore pass able to succeed at all. Written the obvious
    // one-key-at-a-time way, this rolled back nothing on a full storage and reported it
    // honestly -- which is a guarantee not worth having.
    for (const key of applied) {
      try {
        storage.removeItem(key);
      } catch {
        // Nothing to do: the restore below will simply overwrite it if it can.
      }
    }
    for (const key of applied) {
      const before = previous.get(key) ?? null;
      // An absent key is restored by staying absent -- the removal above already did it.
      if (before === null) {
        rolledBack.push(key);
        continue;
      }
      try {
        storage.setItem(key, before);
        rolledBack.push(key);
      } catch {
        // A restore can still throw -- see this function's own residual note. The key is
        // absent from `rolledBack`, so the caller can see exactly what was not restored.
      }
    }
    return {
      ok: false,
      reason: 'storage refused a write',
      applied,
      ignored,
      failed,
      sourceNamespace: source,
      rolledBack,
    };
  }

  return { ok: true, reason: null, applied, ignored, failed, sourceNamespace: source, rolledBack };
}

/**
 * The console-level affordance, behind `?dev=1&saveIo=1`.
 *
 * Console-level on purpose: whether this earns a permanent HUD affordance is a
 * product call (issue #110 says so), and shipping a button now would decide it by
 * accident. Built here rather than in loop.ts so the thing the player actually
 * calls is the thing tests call.
 *
 * The reload note is not decoration. Every store snapshots its key into an
 * in-memory shadow at CONSTRUCTION and writes back from that shadow, so an import
 * mid-session is invisible until the page reloads -- and worse, the next write
 * from a live store would overwrite what was just imported.
 */
export interface SaveApi {
  /** The whole save as pretty JSON, ready to copy out of the console. */
  export(): string;
  /**
   * Restore a blob. Reload the page afterwards: see the note above.
   *
   * Refuses a blob from another namespace, or one that does not state its namespace,
   * unless `allowForeignNamespace` is passed -- the deliberate action issue #250 requires
   * before developer data can land on a production save or the reverse.
   */
  import(text: string, opts?: ImportOptions): ImportResult;
  /** Which namespace this session reads and writes. Shown by the console alongside `keys`. */
  namespace: StorageNamespace;
  /** The keys an export covers, so the console can show them. */
  keys: readonly string[];
  /** The wider set an import will accept -- `keys` plus the legacy compatibility key. */
  importKeys: readonly string[];
}

export function createSaveApi(storage: Storage, namespace: StorageNamespace): SaveApi {
  return {
    export: () => exportSave(storage, namespace),
    import: (text: string, opts?: ImportOptions) => importSave(storage, text, namespace, opts),
    namespace,
    keys: SAVE_KEYS,
    importKeys: SAVE_IMPORT_KEYS,
  };
}
