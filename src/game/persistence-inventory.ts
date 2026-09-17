/**
 * What the game keeps on the player's device, classified once (issue #764).
 *
 * The keys themselves are NOT retyped here: each comes from the store module that owns it.
 * What this adds is only what another surface needs and the store cannot say about itself --
 * which store writes it, whether a save export carries it, and the sentence the privacy
 * policy uses for it. `persistence-inventory.test.ts` holds the surfaces to it:
 *
 * - the keys the seven stores actually write (by running them, not by reading a list);
 * - `SAVE_KEYS` and `SAVE_IMPORT_KEYS` in save.ts, which stays the authority on what an
 *   export and an import do;
 * - the data table in PRIVACY.md (and so the generated Legal page) and in
 *   public/privacy.html.
 *
 * Developer sessions are not listed: the namespaced storage adapter prefixes every key
 * generically (storage.ts), so one inventory describes both namespaces.
 */
import type { GameStores } from './storage';
import { ACHIEVEMENTS_KEY } from './achievements';
import { CUSTOM_KEY } from './customization';
import { PROGRESS_KEY } from './progress';
import { LEGACY_RUN_KEY_V1, RUN_KEY } from './run';
import { SETTINGS_KEY } from './settings';
import { RUN_STATS_KEY, STATS_KEY } from './stats';
import { TOUCH_SETTINGS_KEY } from './touch-settings';
import { VERSUS_SETUP_KEY } from './versus-setup-store';

export interface PersistedDatum {
  readonly key: string;
  /** The store that writes it. */
  readonly store: keyof GameStores;
  /** Whether a save export carries it (`SAVE_KEYS`). */
  readonly exported: boolean;
  /** The privacy policy's description, verbatim. */
  readonly contents: string;
}

/** Every key a current build writes, in the order the privacy policy lists them. */
export const PERSISTED_DATA: readonly PersistedDatum[] = Object.freeze([
  { key: PROGRESS_KEY, store: 'progress', exported: true, contents: 'Highest level cleared in the campaign' },
  { key: STATS_KEY, store: 'stats', exported: true, contents: 'Lifetime and per-attempt game statistics' },
  {
    key: RUN_STATS_KEY,
    store: 'stats',
    exported: true,
    contents: 'Game statistics for the campaign run in progress',
  },
  { key: RUN_KEY, store: 'run', exported: true, contents: 'Active campaign run: current level, remaining lives' },
  { key: CUSTOM_KEY, store: 'customization', exported: true, contents: 'Chosen tank color and paint customization' },
  {
    key: SETTINGS_KEY,
    store: 'settings',
    exported: true,
    contents:
      'Player settings: sound mute and volume, touch control scheme and fire mode, device vibration and controller rumble preferences, motion/flash preference, interface scale',
  },
  { key: ACHIEVEMENTS_KEY, store: 'achievements', exported: true, contents: 'Earned achievements' },
  {
    key: VERSUS_SETUP_KEY,
    store: 'versusSetup',
    exported: false,
    contents:
      'Versus match setup: mode, player count, lives, friendly fire, arena, and which player slots are people or computer players (never which controller anyone uses)',
  },
]);

export interface LegacyKey {
  readonly key: string;
  /** Whether a save import still accepts it (`SAVE_IMPORT_KEYS`). No build writes either. */
  readonly importable: boolean;
}

/** Keys an older build wrote. Read once to migrate or deleted on load; never written. */
export const LEGACY_KEYS: readonly LegacyKey[] = Object.freeze([
  // Migrated into tanks.settings.v1, then deleted; still accepted by import (save.ts).
  { key: TOUCH_SETTINGS_KEY, importable: true },
  // Deleted when the run store is created (run.ts); never read.
  { key: LEGACY_RUN_KEY_V1, importable: false },
]);
