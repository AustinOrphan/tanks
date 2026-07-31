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
 */
export const PROGRESS_KEY = 'tanks.progress.v1';

export interface ProgressStore {
  /** Highest 1-based level cleared; 0 when nothing is. */
  highestCleared(): number;
  /** Record a clear. Keeps the maximum: replaying level 1 cannot re-lock level 3. */
  recordCleared(level: number): void;
}

export function createProgressStore(storage: Storage): ProgressStore {
  // In-memory shadow: the truth when storage throws, a cache when it works.
  let shadow = read();

  function read(): number {
    let raw: string | null = null;
    try {
      raw = storage.getItem(PROGRESS_KEY);
    } catch {
      return 0;
    }
    if (raw === null || raw === '') return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
    return n;
  }

  return {
    highestCleared(): number {
      return shadow;
    },
    recordCleared(level: number): void {
      if (!Number.isInteger(level) || level <= 0) return;
      // Max against CURRENT storage, not the construction-time shadow: another tab
      // may have cleared further since this one booted, and a blind write would
      // clobber its unlock. read() returns 0 when storage throws, so the shadow
      // still carries a private-mode session.
      shadow = Math.max(shadow, level, read());
      try {
        storage.setItem(PROGRESS_KEY, String(shadow));
      } catch {
        // Private mode or quota: the shadow carries the session; nothing persists.
      }
    },
  };
}
