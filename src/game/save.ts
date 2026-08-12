import { PROGRESS_KEY } from './progress';
import { STATS_KEY } from './stats';
import { CUSTOM_KEY } from './customization';
import { TOUCH_SETTINGS_KEY } from './touch-settings';
import { ACHIEVEMENTS_KEY } from './achievements';
import { RUN_KEY } from './run';

/**
 * Serialise and restore the whole save: the six `tanks.*` keys as one blob.
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
 * Deliberately at the RAW key/value layer, not through the six typed stores.
 * The stores validate on read and drop what they do not recognise, so a
 * store-level round trip would silently discard a field written by a newer
 * version of the game -- exactly the data an export exists to preserve. Junk is
 * still safe: each store already validates whatever it is handed at boot, so an
 * imported blob cannot produce an invalid game, only a defaulted one.
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
 */
export const SAVE_KEYS: readonly string[] = Object.freeze([
  PROGRESS_KEY,
  STATS_KEY,
  CUSTOM_KEY,
  TOUCH_SETTINGS_KEY,
  ACHIEVEMENTS_KEY,
  RUN_KEY,
]);

export interface SaveBlob {
  format: string;
  version: number;
  /** Only keys from SAVE_KEYS, each holding the RAW string the browser stored. */
  keys: Record<string, string>;
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
}

/**
 * Read every save key that exists, as a JSON blob.
 *
 * An ABSENT key is omitted rather than exported as null: importing a blob taken
 * before a store existed must not blank that store, and "absent" and "empty" are
 * different states to every one of the six readers.
 */
export function exportSave(storage: Storage): string {
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
  const blob: SaveBlob = { format: SAVE_FORMAT, version: SAVE_VERSION, keys };
  return JSON.stringify(blob, null, 2);
}

/**
 * Write a blob back over the six keys.
 *
 * Unknown keys are IGNORED, not written. That is a security property, not
 * tidiness: this origin's localStorage namespace is shared with every other
 * project page on austinorphan.com, so a blob a player was talked into pasting
 * must not be able to set `some-other-app.session`. The allow-list is SAVE_KEYS.
 *
 * A key the blob omits is left ALONE rather than cleared -- an import is a
 * restore, and there is no way to tell "this save has no achievements" from
 * "this export predates achievements".
 */
export function importSave(storage: Storage, text: string): ImportResult {
  const empty = { applied: [] as string[], ignored: [] as string[], failed: [] as string[] };
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

  const applied: string[] = [];
  const ignored: string[] = [];
  const failed: string[] = [];
  for (const key of Object.keys(keys)) {
    const value = (keys as Record<string, unknown>)[key];
    if (!SAVE_KEYS.includes(key) || typeof value !== 'string') {
      ignored.push(key);
      continue;
    }
    try {
      storage.setItem(key, value);
      applied.push(key);
    } catch {
      failed.push(key);
    }
  }
  return { ok: failed.length === 0, reason: failed.length === 0 ? null : 'storage refused a write', applied, ignored, failed };
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
  /** Restore a blob. Reload the page afterwards: see the note above. */
  import(text: string): ImportResult;
  /** The keys an export covers, so the console can show them. */
  keys: readonly string[];
}

export function createSaveApi(storage: Storage): SaveApi {
  return {
    export: () => exportSave(storage),
    import: (text: string) => importSave(storage, text),
    keys: SAVE_KEYS,
  };
}
