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
  const life = read(storage);
  let attempt: StatCounts = { ...ZERO_STATS };

  function persist(): void {
    // Max-merge against CURRENT storage before writing: a second tab persists too,
    // and a blind write of this tab's copy erased whatever the other tab had counted
    // since we booted (found in review -- the progress store had the same clobber).
    // Max is the no-loss choice for monotonic counters, not exact cross-tab addition;
    // KNOWN RESIDUAL: a tab still open across a Reset stats can resurrect pre-reset
    // numbers with its next write. Accepted for a local single-player tally.
    const stored = read(storage);
    for (const key of Object.keys(ZERO_STATS) as Array<keyof StatCounts>) {
      life[key] = Math.max(life[key], stored[key]);
    }
    try {
      storage.setItem(STATS_KEY, JSON.stringify(life));
    } catch {
      // Private mode or quota: the in-memory tally carries the session.
    }
  }

  function bump(key: keyof StatCounts): void {
    life[key] += 1;
    attempt[key] += 1;
  }

  return {
    lifetime: () => ({ ...life }),
    attempt: () => ({ ...attempt }),
    startAttempt(): void {
      attempt = { ...ZERO_STATS };
    },
    resetLifetime(): void {
      for (const key of Object.keys(ZERO_STATS) as Array<keyof StatCounts>) life[key] = 0;
      // A direct write, NOT persist(): the max-merge would instantly resurrect the
      // numbers the player just asked to erase.
      try {
        storage.setItem(STATS_KEY, JSON.stringify(life));
      } catch {
        // The in-memory zeros still hold for this session.
      }
    },
    record(events: SimEvent[], playerId: number): void {
      let changed = false;
      for (const e of events) {
        switch (e.type) {
          case 'fire':
            if (e.ownerId === playerId) {
              bump('shotsFired');
              changed = true;
            }
            break;
          case 'ricochet':
            if (e.ownerId === playerId) {
              bump('ricochets');
              changed = true;
            }
            break;
          case 'mine-dropped':
            if (e.ownerId === playerId) {
              bump('minesLaid');
              changed = true;
            }
            break;
          case 'wall-destroyed':
            if (e.ownerId === playerId) {
              bump('wallsDestroyed');
              changed = true;
            }
            break;
          case 'tank-destroyed':
            if (e.kind === 'player') {
              bump('deaths');
              // Dying to your OWN ricochet or mine is additionally a self kill.
              if (e.by.ownerId === playerId) bump('selfKills');
              changed = true;
            } else if (e.by.ownerId === playerId) {
              bump(e.by.source === 'shell' ? 'shellKills' : 'mineKills');
              changed = true;
            } else {
              // An enemy destroyed by a non-player owner: the AI shot its own side.
              bump('friendlyFireKills');
              changed = true;
            }
            break;
          default:
            break;
        }
      }
      if (changed) persist();
    },
  };
}
