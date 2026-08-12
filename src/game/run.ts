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
  // Flips to false the first time write() catches an exception, and never flips
  // back. Guards refreshShadowIfEnded below -- see its doc comment for why a
  // storage that has already failed to persist THIS instance's own writes must
  // not be trusted to answer "did someone else end the run".
  let storageIsWritable = true;

  /**
   * A single storage read, distinguishing "storage could not be consulted at all"
   * (getItem threw) from "storage was consulted and holds no active run" (empty,
   * corrupt, or foreign data) -- read() below collapses both to null, which is
   * right for its callers but wrong for refreshShadowIfEnded, which must never
   * treat a THROW as "the run is gone".
   */
  function readStorage(): { ok: true; run: ActiveRun | null } | { ok: false } {
    let raw: string | null = null;
    try {
      raw = storage.getItem(RUN_KEY);
    } catch {
      return { ok: false };
    }
    if (raw === null || raw === '') return { ok: true, run: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: true, run: null };
    }
    return { ok: true, run: isActiveRun(parsed) ? parsed : null };
  }

  function read(): ActiveRun | null {
    const r = readStorage();
    return r.ok ? r.run : null;
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
      storageIsWritable = false;
    }
  }

  /**
   * The two-tab LWW-resurrection guard: two store instances over the same
   * storage, each with its own shadow, is exactly the persistence model's
   * documented trade-off (see the module doc comment) -- but that trade-off was
   * only ever meant to cover two tabs disagreeing about a run's POSITION, not one
   * tab bringing an ENDED run back from the dead. tabA starting a run, tabB
   * constructing alongside it (snapshotting the same run into its own shadow),
   * then tabA advancing and ending it, leaves tabB's shadow believing a run is
   * still active when storage now holds nothing. tabB's next mutating call would
   * otherwise spread that stale shadow over the gap and persist a brand-new
   * 'active' record where an ended one belongs.
   *
   * Called at the top of every mutating method (advanceLevel, setLivesRemaining,
   * endRun) before it looks at `shadow`. Deliberately NOT called from
   * startNewRun, which is the one explicit action allowed to replace whatever is
   * active regardless of what storage currently holds.
   *
   * Only the "storage holds no active run" case is adopted here -- see the
   * module doc comment on why storage that still holds SOME active run
   * (advanced by another tab, say) is left to the existing last-write-wins
   * behaviour rather than folded in as a second, partial merge.
   *
   * Gated on `storageIsWritable`: once this instance has seen a write fail, a
   * later getItem can keep succeeding while reporting nothing, because nothing
   * this instance wrote ever actually landed (Safari private mode: setItem
   * throws, getItem still works, so it reads back empty regardless of what this
   * tab believes). Treating that empty read as "another tab ended it" would
   * erase the shadow -- the one copy of the run this degrade path exists to
   * protect -- on a session that may never have had a second tab at all. So a
   * known-broken storage is excluded, and the shadow stays the truth for the
   * rest of the session, exactly as before this guard existed.
   */
  function refreshShadowIfEnded(): void {
    if (shadow === null || !storageIsWritable) return;
    const r = readStorage();
    if (r.ok && r.run === null) shadow = null;
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
      refreshShadowIfEnded();
      if (shadow === null) return;
      if (!Number.isInteger(level) || level < 0) return;
      if (!Number.isInteger(livesRemaining) || livesRemaining < 0) return;
      write({ ...shadow, currentLevelId: levelIdFromIndex(level), livesRemaining });
    },
    setLivesRemaining(lives: number): void {
      refreshShadowIfEnded();
      if (shadow === null) return;
      if (!Number.isInteger(lives) || lives < 0) return;
      write({ ...shadow, livesRemaining: lives });
    },
    endRun(): void {
      refreshShadowIfEnded();
      if (shadow === null) return;
      write(null);
    },
  };
}
