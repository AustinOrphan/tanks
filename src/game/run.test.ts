// @vitest-environment jsdom
// The active campaign run: distinct from progress.ts's permanent highestCleared, and
// the store issue #152's refresh exploit is fixed through. Same paranoia as its
// siblings -- corrupt data reads as "no run", a throwing storage degrades in-memory.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRunStore,
  RUN_KEY,
  DEFAULT_CAMPAIGN_ID,
  levelIdFromIndex,
  levelIndexFromId,
  type ActiveRun,
} from './run';
import { LIVES } from '../sim/constants';

beforeEach(() => {
  localStorage.clear();
});

describe('levelIdFromIndex / levelIndexFromId', () => {
  it('round-trips a level index through its stored id', () => {
    for (const i of [0, 1, 7, 42]) {
      expect(levelIndexFromId(levelIdFromIndex(i))).toBe(i);
    }
  });

  it('defaults a garbage id to level 0 rather than propagating NaN', () => {
    for (const junk of ['banana', '-3', '2.5', '', 'NaN']) {
      expect(levelIndexFromId(junk), junk).toBe(0);
    }
  });
});

describe('createRunStore: no run yet', () => {
  it('starts with no active run', () => {
    expect(createRunStore(localStorage).active()).toBeNull();
  });

  it('advanceLevel, setLivesRemaining and endRun are no-ops with nothing active', () => {
    const r = createRunStore(localStorage);
    r.advanceLevel(3, 2);
    r.setLivesRemaining(1);
    r.endRun(); // must not throw
    expect(r.active()).toBeNull();
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
  });
});

describe('createRunStore: startNewRun', () => {
  it('creates a fresh run at the given level with the campaign starting lives', () => {
    const r = createRunStore(localStorage);
    const run = r.startNewRun(0);
    expect(run).toEqual({
      campaignId: DEFAULT_CAMPAIGN_ID,
      currentLevelId: '0',
      livesRemaining: LIVES,
      status: 'active',
    });
    expect(r.active()).toEqual(run);
  });

  it('persists across store instances -- the reload case', () => {
    createRunStore(localStorage).startNewRun(2);
    expect(createRunStore(localStorage).active()).toEqual({
      campaignId: DEFAULT_CAMPAIGN_ID,
      currentLevelId: '2',
      livesRemaining: LIVES,
      status: 'active',
    });
  });

  it('explicitly replaces whatever was already active', () => {
    const r = createRunStore(localStorage);
    r.startNewRun(4);
    r.setLivesRemaining(1);
    expect(r.active()?.livesRemaining).toBe(1);
    r.startNewRun(0); // New Game: abandons the in-progress run
    expect(r.active()).toEqual({
      campaignId: DEFAULT_CAMPAIGN_ID,
      currentLevelId: '0',
      livesRemaining: LIVES,
      status: 'active',
    });
  });
});

describe('createRunStore: setLivesRemaining -- the #152 fix', () => {
  it('reduces the persisted life count and survives a fresh store over the same storage', () => {
    // The exact repro from issue #152: start a run, lose a life, "refresh" (a new
    // store instance over the same storage) and the reduced count must still read back.
    const first = createRunStore(localStorage);
    first.startNewRun(0);
    first.setLivesRemaining(2); // one life lost, from the campaign's starting 3

    const reloaded = createRunStore(localStorage);
    expect(reloaded.active()?.livesRemaining).toBe(2);
  });

  it('leaves the current level untouched', () => {
    const r = createRunStore(localStorage);
    r.startNewRun(3);
    r.setLivesRemaining(1);
    expect(r.active()?.currentLevelId).toBe('3');
  });

  it('ignores a negative or non-integer life count rather than corrupting the record', () => {
    const r = createRunStore(localStorage);
    r.startNewRun(0);
    r.setLivesRemaining(-1);
    r.setLivesRemaining(1.5);
    expect(r.active()?.livesRemaining).toBe(LIVES); // unchanged
  });
});

describe('createRunStore: advanceLevel -- level clear', () => {
  it('moves the level and carries the given lives forward', () => {
    const r = createRunStore(localStorage);
    r.startNewRun(0);
    r.setLivesRemaining(2);
    r.advanceLevel(1, 2); // level cleared with 2 lives remaining
    expect(r.active()).toEqual({
      campaignId: DEFAULT_CAMPAIGN_ID,
      currentLevelId: '1',
      livesRemaining: 2,
      status: 'active',
    });
  });

  it('persists across a fresh store instance', () => {
    const r = createRunStore(localStorage);
    r.startNewRun(0);
    r.advanceLevel(5, 3);
    expect(createRunStore(localStorage).active()?.currentLevelId).toBe('5');
  });
});

describe('createRunStore: endRun', () => {
  it('clears the run so a fresh store over the same storage also sees none', () => {
    const r = createRunStore(localStorage);
    r.startNewRun(0);
    r.endRun();
    expect(r.active()).toBeNull();
    expect(createRunStore(localStorage).active()).toBeNull();
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
  });
});

describe('createRunStore: corrupt or foreign data reads as no run', () => {
  const validBase: ActiveRun = {
    campaignId: DEFAULT_CAMPAIGN_ID,
    currentLevelId: '0',
    livesRemaining: 3,
    status: 'active',
  };

  it.each([
    ['not JSON at all', 'banana'],
    ['a JSON array', '[1,2,3]'],
    ['a different campaignId', JSON.stringify({ ...validBase, campaignId: 'other' })],
    ['a wrong status', JSON.stringify({ ...validBase, status: 'ended' })],
    ['a negative livesRemaining', JSON.stringify({ ...validBase, livesRemaining: -1 })],
    ['a non-integer livesRemaining', JSON.stringify({ ...validBase, livesRemaining: 2.5 })],
    ['a missing currentLevelId', JSON.stringify({ campaignId: DEFAULT_CAMPAIGN_ID, livesRemaining: 3, status: 'active' })],
    ['an empty currentLevelId', JSON.stringify({ ...validBase, currentLevelId: '' })],
  ])('%s', (_label, junk) => {
    localStorage.setItem(RUN_KEY, junk);
    expect(createRunStore(localStorage).active()).toBeNull();
  });

  it('a well-formed record still round-trips', () => {
    localStorage.setItem(RUN_KEY, JSON.stringify(validBase));
    expect(createRunStore(localStorage).active()).toEqual(validBase);
  });
});

describe('createRunStore: a storage that throws', () => {
  function throwingStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (): void => {
        throw new Error('denied');
      },
      removeItem: (): void => {
        throw new Error('denied');
      },
      clear: (): void => map.clear(),
      key: (): string | null => null,
      get length(): number {
        return map.size;
      },
    } as unknown as Storage;
  }

  it('degrades to in-memory for the session: writes appear to this instance but never land', () => {
    const s = throwingStorage();
    const r = createRunStore(s);
    r.startNewRun(0); // must not throw
    expect(r.active()?.currentLevelId).toBe('0');
    r.setLivesRemaining(1); // must not throw
    expect(r.active()?.livesRemaining).toBe(1);
    expect(s.getItem(RUN_KEY)).toBeNull(); // never actually written
  });

  it('a getItem that throws is read as no run', () => {
    const s = {
      getItem: (): string | null => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(createRunStore(s).active()).toBeNull();
  });
});

describe('two stores over one storage (the second-tab case)', () => {
  it('is last-write-wins, not a max-merge -- a single mutable position has no lossless combine', () => {
    const tabA = createRunStore(localStorage);
    tabA.startNewRun(0);
    const tabB = createRunStore(localStorage);
    tabA.advanceLevel(2, 2);
    tabB.setLivesRemaining(1); // tabB still thinks the run is at level 0
    // tabB's write landed last and overwrote tabA's level advance -- the documented
    // trade-off, not a defect: see run.ts's module doc comment.
    expect(createRunStore(localStorage).active()).toEqual({
      campaignId: DEFAULT_CAMPAIGN_ID,
      currentLevelId: '0',
      livesRemaining: 1,
      status: 'active',
    });
  });
});
