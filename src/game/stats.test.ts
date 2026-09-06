// @vitest-environment jsdom
// The lifetime tally and the per-attempt tally, fed by the attributed event stream.
// Storage paranoia mirrors progress.ts: corrupt reads as zeros, throwing storage
// degrades to in-memory.
import { describe, it, expect, beforeEach } from 'vitest';
import { createStatsStore, ZERO_STATS, STATS_KEY, RUN_STATS_KEY, type StatCounts } from './stats';
import type { SimEvent } from '../sim/events';

const P = 16; // the player's tank id in these fixtures
const E = 4; // an enemy id

const fire = (ownerId: number): SimEvent =>
  ({ type: 'fire', ownerId, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 });
const ricochet = (ownerId: number): SimEvent =>
  ({ type: 'ricochet', ownerId, pos: { x: 0, y: 0 }, bounceIndex: 0 });
const mineDropped = (ownerId: number): SimEvent =>
  ({ type: 'mine-dropped', mineId: 7, ownerId, pos: { x: 0, y: 0 } });
const wallDown = (ownerId: number): SimEvent =>
  ({ type: 'wall-destroyed', wallId: 3, ownerId, pos: { x: 0, y: 0 } });
const killed = (
  kind: 'player' | 'brown',
  source: 'shell' | 'blast',
  ownerId: number,
): SimEvent =>
  ({ type: 'tank-destroyed', tankId: kind === 'player' ? P : E, kind, by: { source, ownerId }, pos: { x: 0, y: 0 } });

beforeEach(() => localStorage.clear());

describe('createStatsStore: attribution rules', () => {
  function afterEvents(events: SimEvent[]): { life: StatCounts; attempt: StatCounts } {
    const s = createStatsStore(localStorage);
    s.record(events, P, false);
    return { life: s.lifetime(), attempt: s.attempt() };
  }

  it('counts the player\'s shots, ricochets, mines and walls -- and NOT the AI\'s', () => {
    const { life } = afterEvents([
      fire(P), fire(E), ricochet(P), ricochet(E), mineDropped(P), mineDropped(E),
      wallDown(P), wallDown(E),
    ]);
    // Population: one player-owned and one enemy-owned event of each attributable
    // kind. Counting the AI's would roughly triple every number on the page.
    expect(life.shotsFired).toBe(1);
    expect(life.ricochets).toBe(1);
    expect(life.minesLaid).toBe(1);
    expect(life.wallsDestroyed).toBe(1);
  });

  it('splits the player\'s kills by source', () => {
    const { life } = afterEvents([killed('brown', 'shell', P), killed('brown', 'blast', P)]);
    expect(life.shellKills).toBe(1);
    expect(life.mineKills).toBe(1);
  });

  it('a death is a death; dying to your OWN ordnance is also a self kill', () => {
    const { life } = afterEvents([killed('player', 'shell', E), killed('player', 'blast', P)]);
    expect(life.deaths).toBe(2);
    expect(life.selfKills).toBe(1);
  });

  it('an enemy destroyed by a non-player owner is AI friendly fire', () => {
    const { life } = afterEvents([killed('brown', 'shell', 5), killed('brown', 'blast', P)]);
    expect(life.friendlyFireKills).toBe(1); // the player's mine kill is not friendly fire
  });

  it('a SECOND player-kind tank dying is not mistaken for the tracked player dying', () => {
    // Unreached by any runtime call site today (playerCount stays 1 everywhere),
    // but this is exactly the co-op misattribution the fix (record's tank-destroyed
    // branch keying on e.tankId, not e.kind === 'player') exists for: P2 (co-op's
    // controlledBy: 1, its OWN distinct tank id) dying must not bump the tracked
    // player's deaths/selfKills.
    const P2 = 23; // a second player-kind tank's id, distinct from P (the tracked one)
    const p2Killed: SimEvent = {
      type: 'tank-destroyed', tankId: P2, kind: 'player', by: { source: 'shell', ownerId: P }, pos: { x: 0, y: 0 },
    };
    const { life } = afterEvents([p2Killed]);
    expect(life.deaths).toBe(0);
    expect(life.selfKills).toBe(0);
  });
});

describe('createStatsStore: attempt vs lifetime', () => {
  it('startAttempt zeroes the attempt tally and leaves the lifetime alone', () => {
    const s = createStatsStore(localStorage);
    s.record([fire(P)], P, false);
    s.startAttempt();
    expect(s.attempt()).toEqual(ZERO_STATS);
    expect(s.lifetime().shotsFired).toBe(1);
  });

  it('lifetime persists across store instances; the attempt does not', () => {
    const a = createStatsStore(localStorage);
    a.record([fire(P), killed('brown', 'shell', P)], P, false);
    const b = createStatsStore(localStorage);
    expect(b.lifetime().shotsFired).toBe(1);
    expect(b.lifetime().shellKills).toBe(1);
    expect(b.attempt()).toEqual(ZERO_STATS); // a reload is a fresh attempt
  });

  it('resetLifetime zeroes and persists the zeros', () => {
    const a = createStatsStore(localStorage);
    a.record([fire(P)], P, false);
    a.resetStats();
    expect(createStatsStore(localStorage).lifetime()).toEqual(ZERO_STATS);
  });
});

describe('createStatsStore: storage paranoia', () => {
  it('treats corrupt stored values as a fresh tally', () => {
    for (const junk of ['banana', '[]', '{"shotsFired":"many"}', '']) {
      localStorage.setItem(STATS_KEY, junk);
      expect(createStatsStore(localStorage).lifetime(), junk).toEqual(ZERO_STATS);
    }
  });

  it('survives a throwing storage in-memory', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const s = createStatsStore(throwing);
    s.record([fire(P)], P, false); // must not throw
    expect(s.lifetime().shotsFired).toBe(1);
  });
});

describe('the shot-an-enemy-mine scenario (found in review)', () => {
  it('files the kill as the player\'s SHELL kill: a hit, not AI friendly fire', () => {
    // The sim now credits a shell-triggered blast to the shooter, so the page
    // stops calling a player kill "AI friendly fire" and stops scoring the
    // killing shot as a miss.
    const s = createStatsStore(localStorage);
    s.record([fire(P), killed('brown', 'shell', P)], P, false);
    expect(s.lifetime().shellKills).toBe(1);
    expect(s.lifetime().friendlyFireKills).toBe(0);
  });
});

describe('two stores over one storage (the second-tab case)', () => {
  it('never erases another instance\'s counts: persist max-merges per field', () => {
    // Found in review, same clobber class as the progress store but with a far
    // larger window (stats persist on every eventful frame).
    const tabA = createStatsStore(localStorage);
    const tabB = createStatsStore(localStorage);
    tabA.record([fire(P), fire(P)], P, false);
    tabB.record([mineDropped(P)], P, false);
    const reloaded = createStatsStore(localStorage).lifetime();
    expect(reloaded.shotsFired).toBe(2); // tabB's write did not erase tabA's shots
    expect(reloaded.minesLaid).toBe(1);
  });

  it('reset does NOT max-merge, or it would resurrect what it just erased', () => {
    const s = createStatsStore(localStorage);
    s.record([fire(P)], P, false);
    s.resetStats();
    expect(createStatsStore(localStorage).lifetime()).toEqual(ZERO_STATS);
  });
});

describe('a tab left open across reset (PR #62\'s sibling defect)', () => {
  it('does not resurrect pre-reset lifetime numbers on its next write', () => {
    // achievements.ts's exact repro, adapted to stats's per-field max-merge:
    // tabB constructs while disk already holds shotsFired: 2, snapshotting it
    // into its own shadow. tabA then runs the two-click-confirmed Reset stats --
    // disk now holds zeros. tabB never saw that write; its shadow still believes
    // shotsFired is 2. tabB's next mutating call (laying a mine, an unrelated
    // field) must not spread that stale shotsFired count back onto disk merely
    // because the old per-key max-merge compared against it.
    const tabA = createStatsStore(localStorage);
    tabA.record([fire(P), fire(P)], P, false); // tabA racks up shotsFired: 2
    const tabB = createStatsStore(localStorage); // boots with shotsFired: 2 in its shadow
    expect(tabB.lifetime().shotsFired).toBe(2);

    tabA.resetStats();
    expect(createStatsStore(localStorage).lifetime()).toEqual(ZERO_STATS); // disk really is reset

    tabB.record([mineDropped(P)], P, false); // tabB lays a mine, unrelated to the reset field

    expect(tabB.lifetime().shotsFired, 'the reset must stick even from a stale tab').toBe(0);
    expect(tabB.lifetime().minesLaid, 'the newly recorded field must still land').toBe(1);
  });
});

describe('a storage whose writes never land (PR #62\'s sibling: the latch)', () => {
  it('keeps the shadow as the session truth: resync must never erase it', () => {
    // Mirrors achievements.ts's equivalent test. getItem keeps working off a
    // real backing map (so it is NOT the read-throws case already covered
    // above), but setItem always throws, so nothing this instance writes ever
    // actually lands and getItem reads back empty forever. Once a write has
    // failed, resync must stop trusting that empty read as "another tab reset
    // it" -- otherwise the second record() call below would wipe shotsFired
    // from the shadow even though no reset ever happened.
    const map = new Map<string, string>();
    const s = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (): void => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const store = createStatsStore(s);
    store.record([fire(P)], P, false); // write() catches the throw -- storage is now known broken
    expect(store.lifetime().shotsFired).toBe(1);
    store.record([mineDropped(P)], P, false); // a second mutating call, an unrelated field
    expect(store.lifetime().shotsFired, 'the shadow remains the truth, not wiped by the always-empty read').toBe(1);
    expect(store.lifetime().minesLaid).toBe(1);
  });
});

describe('per-field validation (found in review: was only tested with whole-object junk)', () => {
  it('drops the corrupt fields and keeps the valid siblings', () => {
    localStorage.setItem(STATS_KEY, '{"shotsFired":-5,"deaths":3,"shellKills":2.7,"ricochets":4}');
    const life = createStatsStore(localStorage).lifetime();
    expect(life.shotsFired).toBe(0); // negative dropped
    expect(life.shellKills).toBe(0); // float dropped
    expect(life.deaths).toBe(3); // valid sibling survives
    expect(life.ricochets).toBe(4);
  });
});


describe('createStatsStore: the CAMPAIGN RUN scope', () => {
  // The missing middle between `attempt` (one try at one level, in memory, gone at the
  // next world build) and `lifetime` (this browser, forever). A run spans every level and
  // every retry of one campaign, and nothing else.

  it('accumulates only when the caller says this session counts toward the run', () => {
    // The gate is the caller's, not the store's: `loop.ts` passes its own
    // `campaignActive()`, the same signal that decides whether the run STORE may be
    // written. Practice, the sandbox, a dev-flag jump and versus all pass false.
    const s = createStatsStore(localStorage);
    s.record([fire(P), killed('brown', 'shell', P)], P, true);
    expect(s.run().shellKills, 'a campaign frame did not reach the run tally').toBe(1);

    // THE NEGATIVE CONTROL, and the whole reason the argument exists: an excluded session
    // still records lifetime and attempt, and must leave the run tally exactly where it
    // was. A store that ignored the flag passes the assertion above and fails here.
    s.record([fire(P), killed('brown', 'shell', P)], P, false);
    expect(s.run().shellKills, 'practice leaked into the campaign run tally').toBe(1);
    expect(s.lifetime().shellKills, 'the excluded frame was dropped entirely').toBe(2);
    expect(s.run().shotsFired).toBe(1);
    expect(s.lifetime().shotsFired).toBe(2);
  });

  it('SURVIVES the tab closing, which is the entire reason it is persisted', () => {
    // A run outlives the browser session -- `tanks.run.v2` exists so Continue works
    // tomorrow. An in-memory tally would silently undercount any campaign played over
    // more than one sitting, and undercount it on the one screen built to report it.
    // A second store instance IS the reload: same storage, fresh memory.
    const tonight = createStatsStore(localStorage);
    tonight.startRun();
    tonight.record([fire(P), fire(P), killed('brown', 'shell', P)], P, true);

    const tomorrow = createStatsStore(localStorage);
    expect(tomorrow.run().shotsFired, 'the run tally did not survive the reload').toBe(2);
    expect(tomorrow.run().shellKills).toBe(1);

    // ...and it keeps accumulating from there rather than starting over.
    tomorrow.record([fire(P)], P, true);
    expect(tomorrow.run().shotsFired).toBe(3);
  });

  it('startRun zeroes the run tally and ONLY the run tally', () => {
    const s = createStatsStore(localStorage);
    s.record([fire(P), fire(P)], P, true);
    expect(s.lifetime().shotsFired).toBe(2);

    s.startRun();
    expect(s.run().shotsFired, 'a new campaign kept the old one\'s numbers').toBe(0);
    // The negative control: lifetime is not a run and must not be cleared with one.
    // Starting a new campaign is not erasing your history.
    expect(s.lifetime().shotsFired, 'New Game wiped the lifetime tally').toBe(2);
    // ...and the zeros are PERSISTED, not just in memory: a reload must not resurrect
    // the previous run.
    expect(createStatsStore(localStorage).run().shotsFired).toBe(0);
  });

  it('is NOT cleared by the end of a run, which is when the end screen reads it', () => {
    // The sequencing this whole design exists for. `endRun()` deletes the run record at
    // exactly the moment `campaign-complete` wants to report on it, so the tally is
    // cleared FORWARD -- at the next New Game -- instead. Nothing here calls endRun,
    // because the point is that the tally does not care: no code path zeroes it except
    // startRun and resetStats.
    const s = createStatsStore(localStorage);
    s.startRun();
    s.record([killed('brown', 'shell', P), killed('brown', 'shell', P)], P, true);
    // Whatever the run store does now, these numbers are still here to render.
    expect(s.run().shellKills).toBe(2);
    expect(createStatsStore(localStorage).run().shellKills).toBe(2);
  });

  it('resetStats clears BOTH persisted scopes, so erased history cannot come back', () => {
    // A player who has just erased their statistics must not meet numbers from them on
    // the next end screen. Reset stats is the one action that clears the run tally
    // without starting a new run.
    const s = createStatsStore(localStorage);
    s.record([fire(P), fire(P)], P, true);
    s.resetStats();
    expect(s.lifetime()).toEqual(ZERO_STATS);
    expect(s.run(), 'the run tally outlived a Reset stats').toEqual(ZERO_STATS);
    // Persisted, both of them: the reset must survive the reload it usually precedes.
    const reloaded = createStatsStore(localStorage);
    expect(reloaded.lifetime()).toEqual(ZERO_STATS);
    expect(reloaded.run()).toEqual(ZERO_STATS);
  });

  it('reads a corrupt run key as zeros without disturbing the lifetime key', () => {
    // Same paranoia as every other store here, and the isolation matters: the two scopes
    // are separate keys precisely so one cannot poison the other.
    localStorage.setItem(RUN_STATS_KEY, '{not json');
    localStorage.setItem(STATS_KEY, JSON.stringify({ ...ZERO_STATS, shellKills: 9 }));
    const s = createStatsStore(localStorage);
    expect(s.run()).toEqual(ZERO_STATS);
    expect(s.lifetime().shellKills, 'a corrupt run key took the lifetime tally with it').toBe(9);
  });

  it('does not hand out its own state: run() is a copy, like the other two scopes', () => {
    const s = createStatsStore(localStorage);
    s.record([fire(P)], P, true);
    const taken = s.run();
    taken.shotsFired = 999;
    expect(s.run().shotsFired, 'a caller mutated the store through its own reading').toBe(1);
  });
});
