// @vitest-environment jsdom
// The game's first persistent state: which levels the player has cleared. Small on
// purpose, and paranoid on purpose -- localStorage lies in more ways than it works
// (missing, corrupt, quota-full, or throwing outright in Safari private mode).
import { describe, it, expect, beforeEach } from 'vitest';
import { createProgressStore, PROGRESS_KEY } from './progress';
import { CAMPAIGN_LEVELS, type CampaignLevel } from '../sim/arena';

beforeEach(() => {
  localStorage.clear();
});

describe('createProgressStore', () => {
  it('starts with nothing cleared', () => {
    expect(createProgressStore(localStorage).highestCleared()).toBe(0);
  });

  it('records a clear and reads it back across store instances', () => {
    createProgressStore(localStorage).recordCleared(CAMPAIGN_LEVELS[0]);
    // A NEW store over the same storage: this is the reload case, the whole point.
    expect(createProgressStore(localStorage).highestCleared()).toBe(1);
  });

  it('keeps the highest clear, so replaying level 1 cannot re-lock level 3', () => {
    const p = createProgressStore(localStorage);
    p.recordCleared(CAMPAIGN_LEVELS[1]);
    p.recordCleared(CAMPAIGN_LEVELS[0]);
    expect(p.highestCleared()).toBe(2);
  });

  it('ignores a level not present in the injected campaign, rather than corrupting the record', () => {
    // Would fail if: recordCleared wrote an id it could not resolve a position for.
    const foreign: CampaignLevel = { id: 'not-a-real-level', arenaId: 'arena-01' };
    const p = createProgressStore(localStorage);
    p.recordCleared(CAMPAIGN_LEVELS[0]);
    p.recordCleared(foreign);
    expect(p.highestCleared()).toBe(1); // unchanged
  });

  it('treats corrupt or absurd stored values as nothing cleared', () => {
    // Population: the 5 corrupt forms below.
    for (const junk of ['banana', '-3', '2.5', '', 'NaN']) {
      localStorage.setItem(PROGRESS_KEY, junk);
      expect(createProgressStore(localStorage).highestCleared(), junk).toBe(0);
    }
  });

  it('an out-of-range legacy ordinal reads as nothing cleared, not a crash', () => {
    // '0' is handled before the frozen table is even consulted (no position-dependent
    // meaning to preserve); '9' exercises the table itself missing. Population: both
    // branches translateLegacyOrdinal/read can take to "nothing cleared".
    for (const junk of ['0', '9']) {
      localStorage.clear();
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
    p.recordCleared(CAMPAIGN_LEVELS[0]); // must not throw
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
    tabA.recordCleared(CAMPAIGN_LEVELS[1]);
    tabB.recordCleared(CAMPAIGN_LEVELS[0]);
    expect(createProgressStore(localStorage).highestCleared()).toBe(2);
  });
});

describe('reset', () => {
  it('re-locks everything, persisted: a reload after reset starts fresh', () => {
    const p = createProgressStore(localStorage);
    p.recordCleared(CAMPAIGN_LEVELS[1]);
    p.reset();
    expect(p.highestCleared()).toBe(0);
    expect(createProgressStore(localStorage).highestCleared()).toBe(0);
  });
});

describe('a tab left open across reset (PR #62\'s sibling defect)', () => {
  it('does not resurrect a pre-reset clear on its next write', () => {
    // achievements.ts's exact repro, adapted to progress's max-by-ordinal merge:
    // tabB constructs while disk already holds a clear through level 3,
    // snapshotting it into its own shadow. tabA then runs the two-click-confirmed
    // reset -- disk now holds nothing cleared. tabB never saw that write; its
    // shadow still believes level 3 is the highest clear. tabB's next mutating
    // call (replaying level 1, an EARLIER level) must not spread that stale
    // shadow's higher ordinal back onto disk merely because the three-way max
    // used to compare against it.
    const tabA = createProgressStore(localStorage);
    tabA.recordCleared(CAMPAIGN_LEVELS[2]); // tabA clears through level 3
    const tabB = createProgressStore(localStorage); // boots with level 3 in its shadow
    expect(tabB.highestCleared()).toBe(3);

    tabA.reset();
    expect(createProgressStore(localStorage).highestCleared()).toBe(0); // disk really is reset

    tabB.recordCleared(CAMPAIGN_LEVELS[0]); // tabB replays level 1, unaware of the reset

    expect(tabB.highestCleared(), 'the reset must stick even from a stale tab').toBe(1);
    expect(createProgressStore(localStorage).highestCleared()).toBe(1);
  });
});

describe('a storage whose writes never land (PR #62\'s sibling: the latch)', () => {
  it('keeps the shadow as the session truth: resync must never erase it', () => {
    // Mirrors achievements.ts's equivalent test. getItem keeps working off a real
    // backing map (so it is NOT the read-throws case already covered above), but
    // setItem always throws, so nothing this instance writes ever actually lands
    // and getItem reads back empty forever. Once a write has failed, resync must
    // stop trusting that empty read as "another tab reset it" -- otherwise the
    // second recordCleared call below would regress highestCleared from 3 to 1
    // even though no reset ever happened.
    const map = new Map<string, string>();
    const s = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (): void => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const p = createProgressStore(s);
    p.recordCleared(CAMPAIGN_LEVELS[2]); // write() catches the throw -- storage is now known broken
    expect(p.highestCleared()).toBe(3);
    p.recordCleared(CAMPAIGN_LEVELS[0]); // a second mutating call, an earlier level
    expect(p.highestCleared(), 'the shadow remains the truth, not wiped by the always-empty read').toBe(3);
  });
});

describe('legacy migration: eager write-back (issue #154)', () => {
  it('translates a legacy bare-ordinal value once, immediately, and reports the right position', () => {
    // Day-one campaign.json mirrors arenas.json 1:1, so legacy "3" (cleared through
    // arena-03 under the pre-#154 numbering) still reports position 3 here.
    localStorage.setItem(PROGRESS_KEY, '3');
    expect(createProgressStore(localStorage).highestCleared()).toBe(3);
  });

  it('writes the translated value back in the v2 shape -- read back, not inferred from a zero exit', () => {
    // CLAUDE.md: read back what a write actually wrote, don't trust that a call
    // returning normally means it wrote what was intended.
    localStorage.setItem(PROGRESS_KEY, '3');
    createProgressStore(localStorage);
    const raw = localStorage.getItem(PROGRESS_KEY);
    expect(raw).not.toBeNull();
    const parsed: unknown = JSON.parse(raw!);
    // The tell that this is now the v2 object shape, not the legacy bare number a
    // later campaign reorder would misresolve if left untranslated.
    expect(typeof parsed).not.toBe('number');
    expect(parsed).toEqual({ levelId: 'level-03' });
  });

  it('a legacy "0" (nothing cleared) needs no write-back -- no position-dependent meaning to preserve', () => {
    localStorage.setItem(PROGRESS_KEY, '0');
    createProgressStore(localStorage);
    expect(localStorage.getItem(PROGRESS_KEY)).toBe('0'); // untouched
  });
});

describe('legacy migration: the frozen ordinal -> arena table survives a reorder (issue #154)', () => {
  // arena-03 moved to position 1 (0-based, ordinal 2) -- everything else shifted to
  // make room. A hand-built fixture, not CAMPAIGN_LEVELS itself: the property under
  // test is "this resolves through ARENA IDENTITY, not campaign POSITION," which the
  // shipped 1:1 campaign can never distinguish (today, ordinal 3 and arena-03's
  // position agree by construction).
  const REORDERED_FIXTURE: readonly CampaignLevel[] = [
    { id: 'level-x', arenaId: 'arena-01' },
    { id: 'level-y', arenaId: 'arena-03' },
    { id: 'level-z', arenaId: 'arena-02' },
    { id: 'level-w', arenaId: 'arena-04' },
    { id: 'level-v', arenaId: 'arena-05' },
  ];

  it('resolves a legacy ordinal through arena identity, and reports its CURRENT position after the reorder', () => {
    // Legacy "3" means "cleared through arena-03" (LEGACY_ORDINAL_ARENA_IDS[2]) under
    // the ORIGINAL order. Against REORDERED_FIXTURE, arena-03 now sits at ordinal 2 --
    // the frozen table must report 2, not "3" (arena-03's old position, which a naive
    // pass-through would keep) and not 3 (REORDERED_FIXTURE[2]'s OCCUPANT, arena-02 --
    // the bug a live-position translation produces, proven below by actually reverting
    // to it). Different numbers, not a differently-reasoned same one, which is what
    // makes this assertion able to fail.
    localStorage.setItem(PROGRESS_KEY, '3');
    const p = createProgressStore(localStorage, REORDERED_FIXTURE);
    expect(p.highestCleared()).toBe(2);
  });
});
