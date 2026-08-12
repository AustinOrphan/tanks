import { LIVES } from '../sim/constants';

/**
 * The active CAMPAIGN RUN: the persisted state issue #153 and the spec
 * (docs/superpowers/specs/2026-08-11-campaign-run-model.md) call for -- distinct from
 * `progress.ts`'s permanent, monotonic `highestCleared`. A run is one attempt through
 * the campaign from its first level to its last; it owns a life pool that survives
 * refresh, menu exit and reopening, and ends only on completion, on losing every life,
 * or on an explicit New Run.
 *
 * Same seam, same paranoia as every other store on this key/value layer: one
 * localStorage key, an injected Storage, an in-memory shadow that is the truth when
 * storage throws (Safari private mode) and a cache when it works, corrupt data reads
 * as "no active run" rather than a crash.
 *
 * Unlike progress.ts and stats.ts, a write here does NOT max-merge against current
 * storage before persisting. Those stores hold monotonic/additive counters, where two
 * tabs' writes can be combined losslessly by taking the larger one. An ActiveRun is a
 * single mutable position -- level and lives at once -- and there is no lossless way to
 * combine two tabs' independent positions in the same campaign run. This is a plain
 * last-write-wins document, the same as any other single-writer save slot.
 */
export const RUN_KEY = 'tanks.run.v1';

/**
 * The one campaign this build ships. A placeholder identity: #154 is the tracked
 * decoupling that gives campaigns and levels real ids (see the spec's "Campaign levels
 * and arenas" section). Until then, a stored run is checked against this constant so a
 * record from some other campaign -- reachable only by hand-editing storage today --
 * reads as corrupt rather than being silently adopted.
 */
export const DEFAULT_CAMPAIGN_ID = 'main';

export interface ActiveRun {
  campaignId: string;
  /**
   * A stringified 0-based level index -- ARENAS' own array position, which is what
   * every other module in the tree already uses to name a level. The spec's shape
   * calls for `currentLevelId: string`; a real `CampaignLevel` id does not exist yet
   * (#154), so this is the minimal string that satisfies the shape without inventing
   * that infrastructure early. See levelIdFromIndex/levelIndexFromId below.
   */
  currentLevelId: string;
  livesRemaining: number;
  /**
   * Only ever `'active'`: an ended run is not a record with a different status, it is
   * the ABSENCE of a record (`active()` returns null). The spec's own `ActiveRun` type
   * carries no other status literal, which is the tell that this is the intended
   * reading, not an omission to fill in later.
   */
  status: 'active';
}

export interface RunStore {
  /** The active run, or null: none has ever started, or the last one ended. */
  active(): ActiveRun | null;
  /**
   * New Run: explicitly replaces whatever was active with a fresh run at
   * `startLevel`, full campaign starting lives (LIVES). The spec requires this to be
   * a deliberate action, "not... an accident as a side effect of menu navigation" --
   * callers must not reach this from anywhere but a dedicated New Game affordance.
   */
  startNewRun(startLevel: number): ActiveRun;
  /**
   * Level clear: advance to `level`, carrying `livesRemaining` forward unchanged
   * from what the run already had. No-op if no run is active -- practice and any
   * other non-campaign session must not be able to conjure one into existence by
   * calling this.
   */
  advanceLevel(level: number, livesRemaining: number): void;
  /**
   * Player death: persist the reduced life count before the player can escape it by
   * refreshing or leaving gameplay (issue #152). No-op if no run is active.
   */
  setLivesRemaining(lives: number): void;
  /** Game over or campaign completion: the run stops existing. No-op if none is active. */
  endRun(): void;
}

/** `currentLevelId` -> the 0-based level index every other module uses. */
export function levelIdFromIndex(index: number): string {
  return String(index);
}

/**
 * The inverse. A garbage id (never written by this module, only reachable by hand-
 * editing storage) defaults to 0 rather than propagating NaN into a level lookup.
 */
export function levelIndexFromId(id: string): number {
  const n = Number(id);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : 0;
}

function isActiveRun(v: unknown): v is ActiveRun {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.campaignId === DEFAULT_CAMPAIGN_ID &&
    typeof r.currentLevelId === 'string' &&
    r.currentLevelId !== '' &&
    typeof r.livesRemaining === 'number' &&
    Number.isFinite(r.livesRemaining) &&
    Number.isInteger(r.livesRemaining) &&
    r.livesRemaining >= 0 &&
    r.status === 'active'
  );
}

export function createRunStore(storage: Storage): RunStore {
  // In-memory shadow: the truth when storage throws, a cache when it works. Same
  // convention as progress.ts and stats.ts.
  let shadow = read();

  function read(): ActiveRun | null {
    let raw: string | null = null;
    try {
      raw = storage.getItem(RUN_KEY);
    } catch {
      return null;
    }
    if (raw === null || raw === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return isActiveRun(parsed) ? parsed : null;
  }

  function write(run: ActiveRun | null): void {
    shadow = run;
    try {
      // A cleared run is removed, not written as some other status -- see the
      // ActiveRun doc comment on why "ended" is absence, not a status value.
      if (run === null) storage.removeItem(RUN_KEY);
      else storage.setItem(RUN_KEY, JSON.stringify(run));
    } catch {
      // Private mode or quota: the shadow carries the session; nothing persists.
    }
  }

  return {
    active(): ActiveRun | null {
      return shadow;
    },
    startNewRun(startLevel: number): ActiveRun {
      const level = Number.isInteger(startLevel) && startLevel >= 0 ? startLevel : 0;
      const fresh: ActiveRun = {
        campaignId: DEFAULT_CAMPAIGN_ID,
        currentLevelId: levelIdFromIndex(level),
        livesRemaining: LIVES,
        status: 'active',
      };
      write(fresh);
      return fresh;
    },
    advanceLevel(level: number, livesRemaining: number): void {
      if (shadow === null) return;
      if (!Number.isInteger(level) || level < 0) return;
      if (!Number.isInteger(livesRemaining) || livesRemaining < 0) return;
      write({ ...shadow, currentLevelId: levelIdFromIndex(level), livesRemaining });
    },
    setLivesRemaining(lives: number): void {
      if (shadow === null) return;
      if (!Number.isInteger(lives) || lives < 0) return;
      write({ ...shadow, livesRemaining: lives });
    },
    endRun(): void {
      if (shadow === null) return;
      write(null);
    },
  };
}
