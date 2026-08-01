// @vitest-environment jsdom
// The game's first persistent state: which levels the player has cleared. Small on
// purpose, and paranoid on purpose -- localStorage lies in more ways than it works
// (missing, corrupt, quota-full, or throwing outright in Safari private mode).
import { describe, it, expect, beforeEach } from 'vitest';
import { createProgressStore, PROGRESS_KEY } from './progress';

beforeEach(() => {
  localStorage.clear();
});

describe('createProgressStore', () => {
  it('starts with nothing cleared', () => {
    expect(createProgressStore(localStorage).highestCleared()).toBe(0);
  });

  it('records a clear and reads it back across store instances', () => {
    createProgressStore(localStorage).recordCleared(1);
    // A NEW store over the same storage: this is the reload case, the whole point.
    expect(createProgressStore(localStorage).highestCleared()).toBe(1);
  });

  it('keeps the highest clear, so replaying level 1 cannot re-lock level 3', () => {
    const p = createProgressStore(localStorage);
    p.recordCleared(2);
    p.recordCleared(1);
    expect(p.highestCleared()).toBe(2);
  });

  it('treats corrupt or absurd stored values as nothing cleared', () => {
    // Population: the 5 corrupt forms below.
    for (const junk of ['banana', '-3', '2.5', '', 'NaN']) {
      localStorage.setItem(PROGRESS_KEY, junk);
      expect(createProgressStore(localStorage).highestCleared(), junk).toBe(0);
    }
  });

  it('survives a storage that throws, falling back to in-memory for the session', () => {
    // Safari private mode: setItem throws QuotaExceededError. The game must keep
    // working; only persistence degrades.
    const throwing = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const p = createProgressStore(throwing);
    expect(p.highestCleared()).toBe(0);
    p.recordCleared(1); // must not throw
    expect(p.highestCleared()).toBe(1); // remembered in-memory for this session
  });
});

describe('two stores over one storage (the second-tab case)', () => {
  it('never regresses a higher clear persisted by another instance', () => {
    // Found in review: recordCleared wrote the stale shadow blindly. Tab A clears
    // level 2; tab B, booted earlier at 0, clears level 1 -- and clobbered A's
    // unlock. The write must max against CURRENT storage, not construction-time.
    const tabA = createProgressStore(localStorage);
    const tabB = createProgressStore(localStorage);
    tabA.recordCleared(2);
    tabB.recordCleared(1);
    expect(createProgressStore(localStorage).highestCleared()).toBe(2);
  });
});

describe('reset', () => {
  it('re-locks everything, persisted: a reload after reset starts fresh', () => {
    const p = createProgressStore(localStorage);
    p.recordCleared(2);
    p.reset();
    expect(p.highestCleared()).toBe(0);
    expect(createProgressStore(localStorage).highestCleared()).toBe(0);
  });
});
