// @vitest-environment jsdom
// The lifetime tally and the per-attempt tally, fed by the attributed event stream.
// Storage paranoia mirrors progress.ts: corrupt reads as zeros, throwing storage
// degrades to in-memory.
import { describe, it, expect, beforeEach } from 'vitest';
import { createStatsStore, ZERO_STATS, STATS_KEY, type StatCounts } from './stats';
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
    s.record(events, P);
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
});

describe('createStatsStore: attempt vs lifetime', () => {
  it('startAttempt zeroes the attempt tally and leaves the lifetime alone', () => {
    const s = createStatsStore(localStorage);
    s.record([fire(P)], P);
    s.startAttempt();
    expect(s.attempt()).toEqual(ZERO_STATS);
    expect(s.lifetime().shotsFired).toBe(1);
  });

  it('lifetime persists across store instances; the attempt does not', () => {
    const a = createStatsStore(localStorage);
    a.record([fire(P), killed('brown', 'shell', P)], P);
    const b = createStatsStore(localStorage);
    expect(b.lifetime().shotsFired).toBe(1);
    expect(b.lifetime().shellKills).toBe(1);
    expect(b.attempt()).toEqual(ZERO_STATS); // a reload is a fresh attempt
  });

  it('resetLifetime zeroes and persists the zeros', () => {
    const a = createStatsStore(localStorage);
    a.record([fire(P)], P);
    a.resetLifetime();
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
    s.record([fire(P)], P); // must not throw
    expect(s.lifetime().shotsFired).toBe(1);
  });
});

describe('the shot-an-enemy-mine scenario (found in review)', () => {
  it('files the kill as the player\'s SHELL kill: a hit, not AI friendly fire', () => {
    // The sim now credits a shell-triggered blast to the shooter, so the page
    // stops calling a player kill "AI friendly fire" and stops scoring the
    // killing shot as a miss.
    const s = createStatsStore(localStorage);
    s.record([fire(P), killed('brown', 'shell', P)], P);
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
    tabA.record([fire(P), fire(P)], P);
    tabB.record([mineDropped(P)], P);
    const reloaded = createStatsStore(localStorage).lifetime();
    expect(reloaded.shotsFired).toBe(2); // tabB's write did not erase tabA's shots
    expect(reloaded.minesLaid).toBe(1);
  });

  it('reset does NOT max-merge, or it would resurrect what it just erased', () => {
    const s = createStatsStore(localStorage);
    s.record([fire(P)], P);
    s.resetLifetime();
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
    tabA.record([fire(P), fire(P)], P); // tabA racks up shotsFired: 2
    const tabB = createStatsStore(localStorage); // boots with shotsFired: 2 in its shadow
    expect(tabB.lifetime().shotsFired).toBe(2);

    tabA.resetLifetime();
    expect(createStatsStore(localStorage).lifetime()).toEqual(ZERO_STATS); // disk really is reset

    tabB.record([mineDropped(P)], P); // tabB lays a mine, unrelated to the reset field

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
    store.record([fire(P)], P); // write() catches the throw -- storage is now known broken
    expect(store.lifetime().shotsFired).toBe(1);
    store.record([mineDropped(P)], P); // a second mutating call, an unrelated field
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
