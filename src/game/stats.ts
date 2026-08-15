import type { SimEvent } from '../sim/events';

/**
 * The lifetime tally and the per-attempt tally, fed by the attributed event stream.
 *
 * "Attempt", not "run": issue #153 gives `run` one meaning across the codebase (one
 * try through the whole campaign, see run.ts), and what this tracks -- a tally zeroed
 * on every level switch, quit or retry by the loop's switchTo -- is level/attempt-sized,
 * exactly the "current ambiguous use of `run` for level-sized statistics" the spec
 * calls out to rename. It counts attempts at BOTH campaign play and practice; nothing
 * here knows which.
 *
 * Game layer only, like progress.ts, and paranoid the same way: one localStorage key,
 * corrupt data reads as zeros, a throwing storage (Safari private mode) degrades to
 * in-memory for the session. The sim never reads any of this.
 */
export const STATS_KEY = 'tanks.stats.v1';

export interface StatCounts {
  shotsFired: number;
  shellKills: number;
  mineKills: number;
  deaths: number;
  selfKills: number;
  friendlyFireKills: number;
  minesLaid: number;
  wallsDestroyed: number;
  ricochets: number;
}

export const ZERO_STATS: StatCounts = Object.freeze({
  shotsFired: 0,
  shellKills: 0,
  mineKills: 0,
  deaths: 0,
  selfKills: 0,
  friendlyFireKills: 0,
  minesLaid: 0,
  wallsDestroyed: 0,
  ricochets: 0,
});

export interface StatsStore {
  lifetime(): StatCounts;
  attempt(): StatCounts;
  /** Fold one frame's events in, attributed against the CURRENT world's player id. */
  record(events: SimEvent[], playerId: number): void;
  /** A new attempt begins (level switch, quit, retry): zero the attempt tally only. */
  startAttempt(): void;
  /** The two-click-confirmed reset. Lifetime only; the attempt tally is already ephemeral. */
  resetLifetime(): void;
}

function read(storage: Storage): StatCounts {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STATS_KEY);
  } catch {
    return { ...ZERO_STATS };
  }
  if (raw === null || raw === '') return { ...ZERO_STATS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...ZERO_STATS };
    }
    const out = { ...ZERO_STATS };
    for (const key of Object.keys(ZERO_STATS) as Array<keyof StatCounts>) {
      const v = (parsed as Record<string, unknown>)[key];
      // Each counter individually validated: one corrupt field must not poison the
      // rest, and "many" is not a number of shots.
      if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0) {
        out[key] = v;
      }
    }
    return out;
  } catch {
    return { ...ZERO_STATS };
  }
}

export function createStatsStore(storage: Storage): StatsStore {
  let life = read(storage);
  let attempt: StatCounts = { ...ZERO_STATS };

  // Flips to false the first time a write catches an exception, and never flips
  // back. Guards resync() below -- same convention as run.ts's storageIsWritable
  // and the identical fix in achievements.ts/progress.ts, for the same reason:
  // a storage that has already failed to persist THIS instance's own writes
  // must not be trusted to answer "what does disk actually hold" (Safari
  // private mode: setItem throws, getItem still works, reading back whatever it
  // always read -- never this instance's own writes).
  let storageIsWritable = true;

  function writeRaw(counts: StatCounts): void {
    try {
      storage.setItem(STATS_KEY, JSON.stringify(counts));
    } catch {
      // Private mode or quota: the in-memory tally carries the session.
      storageIsWritable = false;
    }
  }

  /**
   * Resync the lifetime tally to disk before this call's deltas are applied, so
   * DISK -- not this instance's own running total -- is the base a Reset stats
   * must survive. This is stats.ts's half of PR #62's defect class: the old
   * per-key `Math.max(life[key], stored[key])` let a stale shadow's higher
   * count keep winning that max forever, so a tab left open across Reset stats
   * never stayed reset once this tab recorded anything at all, however
   * unrelated the field. Resyncing first and adding only this call's deltas on
   * top makes the write (disk + this-call's-increments), not
   * max(shadow, disk) -- a reset elsewhere stays reset.
   *
   * Gated on storageIsWritable, exactly like the sibling fixes: once this
   * instance's own write has failed, a later getItem can keep succeeding while
   * reporting nothing this instance ever wrote, and treating that as "someone
   * else reset it" would erase the shadow -- the one copy of this session's
   * tally this degrade path exists to protect.
   */
  function resync(): void {
    if (!storageIsWritable) return;
    life = read(storage);
  }

  return {
    lifetime: () => ({ ...life }),
    attempt: () => ({ ...attempt }),
    startAttempt(): void {
      attempt = { ...ZERO_STATS };
    },
    resetLifetime(): void {
      // Deliberately does NOT call resync(): reset is the one explicit action
      // allowed to replace whatever disk currently holds, the same way run.ts's
      // startNewRun skips refreshShadowIfEnded -- see resync's doc comment.
      for (const key of Object.keys(ZERO_STATS) as Array<keyof StatCounts>) life[key] = 0;
      writeRaw(life); // a direct write, NOT resync+persist: that would instantly resurrect the numbers just erased
    },
    record(events: SimEvent[], playerId: number): void {
      // Deltas accumulate here, NOT directly into `life`: resync() below must
      // replace `life` with a fresh disk read before this call's increments are
      // added on top, and it can only do that if `life` was never mutated
      // mid-loop.
      const delta: Partial<Record<keyof StatCounts, number>> = {};
      let changed = false;
      const bump = (key: keyof StatCounts): void => {
        delta[key] = (delta[key] ?? 0) + 1;
        attempt[key] += 1; // purely in-memory per attempt; never persisted, never resynced
        changed = true;
      };
      for (const e of events) {
        switch (e.type) {
          case 'fire':
            if (e.ownerId === playerId) bump('shotsFired');
            break;
          case 'ricochet':
            if (e.ownerId === playerId) bump('ricochets');
            break;
          case 'mine-dropped':
            if (e.ownerId === playerId) bump('minesLaid');
            break;
          case 'wall-destroyed':
            if (e.ownerId === playerId) bump('wallsDestroyed');
            break;
          case 'tank-destroyed':
            // e.tankId, not e.kind === 'player': at playerCount > 1 a second
            // player-kind tank exists, and kind alone can no longer tell "the
            // TRACKED player died" apart from "some OTHER player-kind tank died".
            // tank-destroyed already carries tankId (events.ts), so this is the
            // exact identity check. Zero behavior change at N=1 -- the only
            // player-kind tank's id IS playerId. A co-op teammate's death still
            // falls into the branches below (scored as a kill/friendly-fire, same
            // as any other non-tracked tank) -- correct per-player attribution for
            // a SECOND human is deferred, unreached by any runtime call site today.
            if (e.tankId === playerId) {
              bump('deaths');
              // Dying to your OWN ricochet or mine is additionally a self kill.
              if (e.by.ownerId === playerId) bump('selfKills');
            } else if (e.by.ownerId === playerId) {
              bump(e.by.source === 'shell' ? 'shellKills' : 'mineKills');
            } else {
              // An enemy destroyed by a non-player owner: the AI shot its own side.
              bump('friendlyFireKills');
            }
            break;
          default:
            break;
        }
      }
      if (!changed) return;
      resync();
      for (const key of Object.keys(delta) as Array<keyof StatCounts>) {
        life[key] += delta[key] ?? 0;
      }
      writeRaw(life);
    },
  };
}
