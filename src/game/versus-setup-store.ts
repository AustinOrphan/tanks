import { sanitizeSetup, defaultSlots, RANDOM_ARENA, type VersusSetup } from './versus-setup';
import { EVERY_BOARD_UNLOCKED, versusMapChoices, type BoardUnlock } from './versus-config';
import { VERSUS_CATALOG } from '../sim/config/versus-catalog';

/**
 * The retained VS setup (issue #260).
 *
 * THIS REVERSES A PREVIOUS DECISION, deliberately, and the superseded comments are updated
 * in the same change rather than left to mislead: `VersusConfig` used to say "Deliberately
 * NOT persisted (spec: 'no new store, no persistence')" and `Assignment` said "Session-only:
 * never written to Storage". Issue #260 supersedes both -- "the last valid role pattern and
 * bot choices should survive reload as part of the retained VS setup".
 *
 * What is stored is the ROLE PATTERN and the match rules, never a device binding. See
 * versus-setup.ts for why that split is what lets "survives reload" and "never silently
 * binds a different physical controller" both hold.
 */
export const VERSUS_SETUP_KEY = 'tanks.versus.v1';

/** The setup a player who has never opened the pane gets. */
export function defaultVersusSetup(): VersusSetup {
  return {
    mode: 'ffa',
    players: 2,
    stock: 3,
    friendlyFire: false,
    arenaId: RANDOM_ARENA,
    slots: defaultSlots(2),
  };
}

export interface VersusSetupStore {
  /** The retained setup, already sanitized. Never throws, never returns a partial. */
  get(): VersusSetup;
  /**
   * Replace the retained setup. Sanitized on the way IN as well as out, so a caller
   * cannot persist a shape that `get` would then have to repair.
   */
  set(setup: VersusSetup): void;
  /** Forget the retained setup (used by the save-reset path, like every other store). */
  clear(): void;
}

/**
 * @param unlocked which boards this player has unlocked (issue #983), read at every check
 * rather than once, because progress changes while the page lives. `createStores` binds it to
 * the progress store; absent, every board the catalog declares is allowed.
 */
export function createVersusSetupStore(
  storage: Storage,
  unlocked: () => BoardUnlock = () => EVERY_BOARD_UNLOCKED,
): VersusSetupStore {
  const fallback = defaultVersusSetup();

  /**
   * The catalog-backed arena check the model is handed. Kept here, at the boundary, so
   * versus-setup.ts needs no catalog import. The offerable set stopped being a pure function
   * of (players, mode) with issue #983, and this is where that lands: a stored board this
   * player has not unlocked falls back to Random through `sanitizeSetup`'s existing path.
   *
   * The shadow is checked when it is read (construction) and on every `set`, so a progress
   * reset reaches it on the next page load or the next write. Within one page the pane
   * re-checks its own copy on every open (hud.ts's `seedAndRenderVersus`) and writes the
   * fallback back through `set`.
   */
  const arenaAllowed = (id: string, players: number, mode: 'ffa' | 'teams'): boolean =>
    versusMapChoices(players, mode, VERSUS_CATALOG, unlocked()).includes(id);

  function read(): VersusSetup {
    let raw: string | null = null;
    try {
      raw = storage.getItem(VERSUS_SETUP_KEY);
    } catch {
      // Private mode / disabled storage: the shadow carries the session.
      return fallback;
    }
    if (raw === null || raw === '') return fallback;
    try {
      return sanitizeSetup(JSON.parse(raw), fallback, arenaAllowed);
    } catch {
      // Unparseable JSON is the one case sanitizeSetup cannot see, because it never gets
      // the chance. Everything PAST the parse is that function's job, field by field.
      return fallback;
    }
  }

  let shadow = read();

  function persist(): void {
    try {
      storage.setItem(VERSUS_SETUP_KEY, JSON.stringify(shadow));
    } catch {
      // Quota or private mode: the shadow still carries this session's choices.
    }
  }

  return {
    get() {
      return shadow;
    },
    set(setup) {
      // Sanitized on the way in too. A caller that hands over a slots array out of step
      // with `players` -- easy to do while the pane is mid-edit -- would otherwise write a
      // shape that only `get` repairs, so the two would disagree until the next reload.
      shadow = sanitizeSetup(setup, fallback, arenaAllowed);
      persist();
    },
    clear() {
      shadow = defaultVersusSetup();
      try {
        storage.removeItem(VERSUS_SETUP_KEY);
      } catch {
        // Same posture as persist(): the shadow is already back to defaults.
      }
    },
  };
}
