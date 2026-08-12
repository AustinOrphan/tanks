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

  // Split into ISOLATED per-method tests, each on its own fresh store, each checked
  // immediately after its one call. The combined version of this test (advanceLevel,
  // then setLivesRemaining, then endRun, one assertion at the end) masked a mutation
  // that made advanceLevel CONJURE a run when none was active: endRun's own no-op
  // guard still fires last and writes the shadow back to null, cleaning up the
  // evidence before the single trailing assertion ever ran. All 25 of this file's
  // tests stayed green under that mutation. Checking `active()` right after each
  // individual call, with nothing after it to clean up, is what makes each one able
  // to fail on its own defect rather than only on the composite's.
  it('advanceLevel alone does not conjure a run into existence', () => {
    const r = createRunStore(localStorage);
    r.advanceLevel(3, 2);
    expect(r.active()).toBeNull();
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
  });

  it('setLivesRemaining alone does not conjure a run into existence', () => {
    const r = createRunStore(localStorage);
    r.setLivesRemaining(1);
    expect(r.active()).toBeNull();
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
  });

  it('endRun alone does not conjure a run into existence', () => {
    const r = createRunStore(localStorage);
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
    // isActiveRun requires `typeof livesRemaining === 'number'`: a stringified digit
    // parses as valid JSON but fails that type check, so it reads as no run rather
    // than being coerced.
    ['a string livesRemaining', JSON.stringify({ ...validBase, livesRemaining: '3' })],
  ])('%s', (_label, junk) => {
    localStorage.setItem(RUN_KEY, junk);
    expect(createRunStore(localStorage).active()).toBeNull();
  });

  it('a well-formed record still round-trips', () => {
    localStorage.setItem(RUN_KEY, JSON.stringify(validBase));
    expect(createRunStore(localStorage).active()).toEqual(validBase);
  });

  it('an absurdly large livesRemaining is ACCEPTED, by design -- no magnitude cap', () => {
    // isActiveRun checks type, finiteness, integrality and non-negativity, but no
    // upper bound -- the same convention stats.ts's read() uses for its counters
    // (CLAUDE.md: "no upper bound check, only type/shape"). That is deliberate here
    // too, not an oversight: the spec's run model explicitly allows a life pool
    // larger than the campaign's starting count ("unless another life has been
    // deliberately awarded by game design"), so a large-but-well-formed integer must
    // round-trip rather than being rejected as corrupt.
    localStorage.setItem(RUN_KEY, JSON.stringify({ ...validBase, livesRemaining: 999 }));
    expect(createRunStore(localStorage).active()).toEqual({ ...validBase, livesRemaining: 999 });
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

  it('defect #2: a stale tab must not resurrect a run this tab (or another) already ended', () => {
    // The reviewer's exact repro: tabA starts a run and tabB constructs alongside it,
    // snapshotting the same run into its own shadow. tabA then advances AND ends the
    // run entirely -- storage now holds nothing. tabB never saw either write; its
    // shadow still believes the run is active at level 0 with full lives. tabB's next
    // mutating call must not spread that stale shadow over an ended run and bring it
    // back as a 0-life 'active' record -- verified against the sim, a 0-life world
    // with the player still alive is playable, which is exactly the degenerate extra
    // attempt this guards against.
    const tabA = createRunStore(localStorage);
    tabA.startNewRun(0);
    const tabB = createRunStore(localStorage);
    tabA.advanceLevel(2, 1);
    tabA.endRun();
    expect(localStorage.getItem(RUN_KEY)).toBeNull(); // the run is genuinely gone

    tabB.setLivesRemaining(0); // tabB's stale shadow: level 0, full lives

    expect(tabB.active(), "tabB's own view must see the run as ended too").toBeNull();
    expect(localStorage.getItem(RUN_KEY)).toBeNull(); // must not have written anything back
    expect(createRunStore(localStorage).active(), 'a fresh store agrees: still no run').toBeNull();
  });

  it('the resync guard does not fire under a THROWING storage -- the shadow stays the truth, unchanged from before this fix', () => {
    // Same paranoia as "createRunStore: a storage that throws" below, but exercising
    // the NEW resync path specifically: a storage whose setItem/removeItem always
    // throw (Safari private mode) but whose getItem keeps working -- because nothing
    // ever actually lands, getItem always reads back empty. Without excluding a
    // known-broken storage from the resync, that empty read would misread as
    // "another tab ended it" and erase the very shadow this degrade path exists to
    // protect, on a session that never had a second tab at all.
    const map = new Map<string, string>();
    const s = {
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
    const r = createRunStore(s);
    r.startNewRun(0); // write() catches the throw here -- storage is now known broken
    expect(r.active()?.currentLevelId).toBe('0');
    r.setLivesRemaining(2); // must consult the shadow, not the (always-empty) storage
    expect(r.active()?.livesRemaining, 'the shadow remains the truth').toBe(2);
    r.advanceLevel(1, 2);
    expect(r.active()?.currentLevelId, 'the shadow remains the truth').toBe('1');
  });
});
