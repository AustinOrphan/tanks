import { CAMPAIGN_LEVELS, type CampaignLevel } from '../sim/arena';

/**
 * The game's first persistent state: the highest level the player has cleared.
 *
 * Game layer only -- the sim never reads this, so replays stay exact functions of
 * their inputs. Injected through GameDeps like every other collaborator: tests hand it
 * a fake Storage, the browser hands it localStorage.
 *
 * Paranoid by design: localStorage can be missing a value, hold junk, or THROW on
 * every call (Safari private mode). A throwing storage degrades to in-memory for the
 * session -- the game keeps working, only persistence is lost.
 *
 * KEY STAYS `tanks.progress.v1` (issue #154 does not bump it): the stored VALUE shape
 * changes in place instead, from a bare ordinal to a `CampaignLevel` id. That is safe
 * here in a way `run.ts`'s equivalent bump was not, for two reasons together: (1) the
 * old and new shapes are structurally unconfusable -- `JSON.parse` of a legacy value
 * ("3") yields a `number`, the new shape is always an object -- and (2) a legacy value
 * is translated EAGERLY, the moment it is first read, and never re-interpreted after.
 */
export const PROGRESS_KEY = 'tanks.progress.v1';

/**
 * A snapshot of what ordinal position N named, in ARENA identity, at the commit that
 * added campaign.json (issue #154). NEVER re-derived from `campaignLevels`, which is
 * free to reorder after this ships -- that is the whole point of this table. Without
 * it, a legacy value translated after a future reorder would resolve against the
 * WRONG position, silently unlocking or re-locking the wrong level; this table lets
 * legacy ordinal N always mean the same ARENA, whatever campaign.json looks like by
 * the time anyone reads it. Verified: this is arenas.json's real id order at adoption,
 * via `grep '"id"' src/sim/config/data/arenas.json`.
 */
const LEGACY_ORDINAL_ARENA_IDS: readonly string[] =
  ['arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05'];

/** The v2 stored VALUE shape -- an object, which is what makes it unconfusable with
 *  a legacy bare-number value at parse time. `levelId: null` is an explicit "nothing
 *  cleared" record (written by `reset()`), distinct from the key being altogether
 *  absent (never written to at all). */
interface StoredProgressV2 {
  levelId: string | null;
}

function isStoredProgressV2(v: unknown): v is StoredProgressV2 {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const levelId = (v as Record<string, unknown>).levelId;
  return levelId === null || typeof levelId === 'string';
}

export interface ProgressStore {
  /** Highest 1-based level cleared; 0 when nothing is. */
  highestCleared(): number;
  /** Record a clear. Keeps the maximum: replaying level 1 cannot re-lock level 3. */
  recordCleared(level: CampaignLevel): void;
  /** The two-click-confirmed reset: everything re-locks, persisted. */
  reset(): void;
}

export function createProgressStore(
  storage: Storage,
  campaignLevels: readonly CampaignLevel[] = CAMPAIGN_LEVELS,
): ProgressStore {
  /**
   * A level's position in `campaignLevels`, 1-based -- or -1 for `null` (nothing
   * cleared) or an id that names no level `campaignLevels` currently holds (a legacy
   * arena removed from the campaign entirely, or a stale/foreign id). -1 rather than
   * 0 so it never wins a "sits latest" comparison against a real position 0.
   */
  function ordinalOf(levelId: string | null): number {
    if (levelId === null) return -1;
    return campaignLevels.findIndex((l) => l.id === levelId);
  }

  /**
   * Translate a legacy bare-ordinal value into a level id, through the FROZEN
   * arena-identity table -- never through live `campaignLevels` position (see the
   * table's own doc comment). Returns null if the ordinal is out of the table's
   * range, or the arena it names has since been removed from `campaignLevels`
   * entirely: both read as "never cleared", matching every other store's convention
   * that corrupt or unresolvable data reads as reset rather than as a crash.
   */
  function translateLegacyOrdinal(n: number): string | null {
    const arenaId = LEGACY_ORDINAL_ARENA_IDS[n - 1];
    if (arenaId === undefined) return null;
    return campaignLevels.find((l) => l.arenaId === arenaId)?.id ?? null;
  }

  // Flips to false the first time writeRaw() catches an exception, and never
  // flips back. Guards resync() below -- same convention as run.ts's
  // storageIsWritable and achievements.ts's identical fix, for the same reason:
  // a storage that has already failed to persist THIS instance's own writes
  // must not be trusted to answer "what does disk actually hold" (Safari
  // private mode: setItem throws, getItem still works, reading back whatever it
  // always read -- never this instance's own writes).
  let storageIsWritable = true;

  function writeRaw(levelId: string | null): void {
    try {
      storage.setItem(PROGRESS_KEY, JSON.stringify({ levelId } satisfies StoredProgressV2));
    } catch {
      // Private mode or quota: the shadow carries the session; nothing persists.
      storageIsWritable = false;
    }
  }

  /**
   * A single storage read, returning the highest-cleared level's id (or null).
   *
   * A legacy bare-number value is translated through the frozen table and WRITTEN
   * BACK in the v2 shape immediately -- eagerly, permanently, once per browser --
   * so it is never re-interpreted against a later, possibly-reordered campaign. A
   * legacy 0 ("nothing cleared") needs no write-back: it has no position-dependent
   * meaning to preserve, so leaving the raw value alone is harmless and one fewer
   * write on every read of a fresh save.
   */
  function read(): string | null {
    let raw: string | null = null;
    try {
      raw = storage.getItem(PROGRESS_KEY);
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
    if (isStoredProgressV2(parsed)) return parsed.levelId;
    if (typeof parsed === 'number' && Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0) {
      if (parsed === 0) return null;
      const levelId = translateLegacyOrdinal(parsed);
      writeRaw(levelId);
      return levelId;
    }
    return null;
  }

  // In-memory shadow: the truth when storage throws, a cache when it works. Holds a
  // LEVEL ID (or null), not a bare ordinal -- an id anchors to WHAT was cleared, and
  // its numeric position (highestCleared) is recomputed fresh on every call, which is
  // what keeps it correct after a future campaign reorder.
  let shadow = read();

  /**
   * Resync the shadow to disk before recordCleared decides what the current
   * best is, so DISK -- not the shadow's own history -- is the base a newly
   * cleared level's ordinal is compared against. This is progress.ts's half of
   * PR #62's defect class: the old three-way max (shadow, newly-cleared level,
   * disk) let a stale shadow's higher ordinal keep winning even after Reset
   * progress wrote null to disk elsewhere -- a reset in another tab never stuck
   * once this tab cleared anything again, however early. Resyncing first makes
   * disk-null adoptable as "a reset happened": the max collapses to (disk,
   * newly-cleared level), so a stale shadow can no longer outrank either.
   *
   * Gated on storageIsWritable, exactly like the achievements.ts and run.ts
   * fixes: once this instance's own write has failed, a later getItem can keep
   * succeeding while reporting nothing this instance ever wrote, and treating
   * that as "someone else reset it" would erase the shadow -- the one copy of
   * this session's progress this degrade path exists to protect.
   */
  function resync(): void {
    if (!storageIsWritable) return;
    shadow = read();
  }

  return {
    highestCleared(): number {
      const ord = ordinalOf(shadow);
      return ord === -1 ? 0 : ord + 1;
    },
    recordCleared(level: CampaignLevel): void {
      // An unrecognized level -- not a member of `campaignLevels` -- is a no-op,
      // matching the old guard's style (`!Number.isInteger(level) || level <= 0`):
      // there is no safe position to record it at.
      if (ordinalOf(level.id) === -1) return;
      resync();
      // Keep whichever of {disk, as just resynced, and the newly-cleared level}
      // sits LATEST in the CURRENT campaign order -- another tab may have
      // cleared further since this instance's shadow was last set, and a blind
      // write would clobber its unlock.
      if (ordinalOf(level.id) > ordinalOf(shadow)) shadow = level.id;
      writeRaw(shadow);
    },
    reset(): void {
      // Deliberately does NOT call resync(): reset is the one explicit action
      // allowed to replace whatever disk currently holds, the same way run.ts's
      // startNewRun skips refreshShadowIfEnded -- see resync's doc comment.
      shadow = null;
      writeRaw(null);
    },
  };
}
