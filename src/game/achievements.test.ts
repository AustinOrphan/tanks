// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACHIEVEMENTS_KEY,
  ACHIEVEMENTS,
  createAchievementsStore,
  type AchievementContext,
} from './achievements';
import { ZERO_STATS } from './stats';
import { arenaById, loadArena, CAMPAIGN_LEVELS } from '../sim/arena';

const ctx = (over: Partial<AchievementContext> = {}): AchievementContext => ({
  lifetime: { ...ZERO_STATS },
  attempt: { ...ZERO_STATS },
  highestCleared: 0,
  totalLevels: 3,
  clearedLevel: null,
  livesLeft: 3,
  tracksProgress: true,
  ...over,
});

describe('the achievement catalog', () => {
  beforeEach(() => localStorage.clear());

  it('has unique ids and no entry that fires on a fresh save', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Population: all 14 catalog entries against a zeroed context. An achievement
    // earned before the player does anything is a bug, not a freebie.
    for (const a of ACHIEVEMENTS) expect(a.earned(ctx()), a.id).toBe(false);
    expect(ACHIEVEMENTS.length).toBe(14);
  });

  it('every entry carries a label and a description the page can show', () => {
    for (const a of ACHIEVEMENTS) {
      expect(a.label.length, a.id).toBeGreaterThan(0);
      expect(a.description.length, a.id).toBeGreaterThan(0);
    }
  });

  it('attempt feats stay dormant until a level is actually cleared', () => {
    // Each must be false mid-attempt with a feat-worthy tally and true only once
    // clearedLevel lands -- otherwise a feat fires on the frame the tally happens to
    // qualify and the player is credited for a level they went on to lose.
    //
    // Population: all 4 attempt feats, NAMED rather than derived by a filter. Review proved the filter
    // silently dropped two of the four (bomb-squad, because the fixture had shell
    // kills; flawless, because it is already true on a zeroed attempt), so dropping
    // atClear from either would have left this green.
    const ATTEMPT_FEATS = ['flawless', 'dead-eye', 'bomb-squad', 'survivor'];
    const feat = { deaths: 0, shotsFired: 4, shellKills: 4, mineKills: 2 };
    const bombAttempt = { deaths: 0, shotsFired: 0, shellKills: 0, mineKills: 2 };
    for (const id of ATTEMPT_FEATS) {
      const a = ACHIEVEMENTS.find((x) => x.id === id)!;
      // The tally that would earn it, but mid-round: clearedLevel is still null.
      const tally = id === 'bomb-squad' ? bombAttempt : feat;
      expect(a.earned(ctx({ attempt: { ...ZERO_STATS, ...tally }, livesLeft: 1 })), id).toBe(false);
      // And the same tally at a clear earns it -- so the false above is the GATE,
      // not merely a predicate that never fires.
      expect(
        a.earned(ctx({ attempt: { ...ZERO_STATS, ...tally }, livesLeft: 1, clearedLevel: 1 })),
        id,
      ).toBe(true);
    }
  });

  it('the cumulative milestones fire at their stated thresholds, not before', () => {
    const kills = (n: number): AchievementContext => ctx({ lifetime: { ...ZERO_STATS, shellKills: n } });
    const idsAt = (n: number): string[] => ACHIEVEMENTS.filter((a) => a.earned(kills(n))).map((a) => a.id);
    expect(idsAt(0)).toEqual([]);
    expect(idsAt(1)).toContain('first-blood');
    expect(idsAt(24)).not.toContain('marksman');
    expect(idsAt(25)).toContain('marksman');
    expect(idsAt(99)).not.toContain('gunslinger');
    expect(idsAt(100)).toContain('gunslinger');
  });

  it('Dead Eye needs shells fired: a mines-only clear is Bomb Squad, not perfect aim', () => {
    // 0 shots means 0 === 0 is vacuously "every shell found a tank". Without the
    // shotsFired > 0 guard, the sniping award lands on a player who never fired.
    const minesOnly = ctx({
      attempt: { ...ZERO_STATS, mineKills: 2, shotsFired: 0, shellKills: 0 },
      clearedLevel: 1,
    });
    const ids = ACHIEVEMENTS.filter((a) => a.earned(minesOnly)).map((a) => a.id);
    expect(ids).toContain('bomb-squad');
    expect(ids).not.toContain('dead-eye');
  });

  it('Campaigner needs every level, not merely the last one unlocked', () => {
    const c = ACHIEVEMENTS.find((a) => a.id === 'campaigner')!;
    expect(c.earned(ctx({ highestCleared: 2, totalLevels: 3, clearedLevel: 2 }))).toBe(false);
    expect(c.earned(ctx({ highestCleared: 3, totalLevels: 3, clearedLevel: 3 }))).toBe(true);
  });

  it('Campaigner ignores a level set that is not the campaign', () => {
    // The dev sandbox is ONE level, but highestCleared comes from the real save, so
    // a player who cleared level 1 and opened ?level=sandbox would otherwise latch
    // "clear every level" on their first eventful frame.
    const c = ACHIEVEMENTS.find((a) => a.id === 'campaigner')!;
    const sandbox = { highestCleared: 1, totalLevels: 1, clearedLevel: 1 };
    expect(c.earned(ctx({ ...sandbox, tracksProgress: false }))).toBe(false);
    expect(c.earned(ctx({ ...sandbox, tracksProgress: true }))).toBe(true);
  });
});

describe('the achievements store', () => {
  beforeEach(() => localStorage.clear());

  it('latches an earned achievement and returns it ONCE, for the toast', () => {
    const s = createAchievementsStore(localStorage);
    const won = ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } });
    const first = s.check(won);
    expect(first.map((a) => a.id)).toEqual(['first-blood']);
    // The second check must return nothing: a repeating toast is the whole risk.
    expect(s.check(won)).toEqual([]);
    expect(s.earned().has('first-blood')).toBe(true);
  });

  it('persists across sessions, and a later session does not re-toast', () => {
    createAchievementsStore(localStorage).check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } }));
    const next = createAchievementsStore(localStorage);
    expect(next.earned().has('first-blood')).toBe(true);
    expect(next.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } }))).toEqual([]);
  });

  it('survives corrupt storage, and drops ids the catalog no longer knows', () => {
    for (const junk of ['', '{', 'null', '"first-blood"', '{"earned":5}']) {
      localStorage.setItem(ACHIEVEMENTS_KEY, junk);
      expect(createAchievementsStore(localStorage).earned().size, junk).toBe(0);
    }
    // A renamed/removed achievement must not resurrect as a ghost row on the page.
    localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify({ earned: ['first-blood', 'ye-olde-feat'] }));
    const s = createAchievementsStore(localStorage);
    expect(s.earned().has('first-blood')).toBe(true);
    expect(s.earned().has('ye-olde-feat' as never)).toBe(false);
  });

  it('does not clobber another tab: two stores over one storage keep both ids', () => {
    // A blind write of this tab's shadow erased whatever the other tab earned since
    // boot -- the identical defect review found in progress.ts and stats.ts.
    const a = createAchievementsStore(localStorage);
    const b = createAchievementsStore(localStorage); // booted with the same empty set
    a.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } })); // A earns first-blood
    b.check(ctx({ lifetime: { ...ZERO_STATS, minesLaid: 50 } })); // B earns minelayer
    const fresh = createAchievementsStore(localStorage).earned();
    expect([...fresh].sort()).toEqual(['first-blood', 'minelayer']);
  });

  it('hands out a COPY: an outside mutation cannot suppress a real unlock', () => {
    const s = createAchievementsStore(localStorage);
    (s.earned() as Set<string>).add('first-blood');
    expect(s.earned().has('first-blood')).toBe(false); // the store is untouched
    // And the achievement still toasts for real when it is actually earned.
    expect(s.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } })).map((x) => x.id)).toEqual([
      'first-blood',
    ]);
  });

  it('reset clears the lot, and they can be earned again afterwards', () => {
    const s = createAchievementsStore(localStorage);
    s.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } }));
    s.reset();
    expect(s.earned().size).toBe(0);
    expect(localStorage.getItem(ACHIEVEMENTS_KEY)).toBe(JSON.stringify({ earned: [] }));
    expect(s.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } })).map((a) => a.id)).toEqual([
      'first-blood',
    ]);
  });

  it('a throwing storage degrades to an in-memory shadow for the session', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const s = createAchievementsStore(throwing);
    expect(s.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } })).map((a) => a.id)).toEqual([
      'first-blood',
    ]);
    expect(s.earned().has('first-blood')).toBe(true); // latched in memory, no throw
  });

  it('a tab left open across Reset progress does not resurrect pre-reset ids on its next write (PR #62)', () => {
    // The backlog's exact repro: tabB constructs while disk already holds first-blood,
    // snapshotting it into its own shadow. tabA then runs the two-click-confirmed
    // reset -- disk now holds nothing. tabB never saw that write; its shadow still
    // believes first-blood is earned. tabB's next mutating call (earning something
    // unrelated) must not spread that stale shadow back onto disk.
    const tabA = createAchievementsStore(localStorage);
    tabA.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } })); // tabA earns first-blood
    const tabB = createAchievementsStore(localStorage); // boots with first-blood in its shadow
    expect(tabB.earned().has('first-blood')).toBe(true);

    tabA.reset();
    expect(localStorage.getItem(ACHIEVEMENTS_KEY)).toBe(JSON.stringify({ earned: [] })); // disk really is reset

    tabB.check(ctx({ lifetime: { ...ZERO_STATS, minesLaid: 50 } })); // tabB earns minelayer, unrelated to the reset id

    expect(tabB.earned().has('first-blood'), 'the reset must stick even from a stale tab').toBe(false);
    expect(tabB.earned().has('minelayer'), 'the newly earned id must still land').toBe(true);
    expect(JSON.parse(localStorage.getItem(ACHIEVEMENTS_KEY)!).earned).toEqual(['minelayer']);
  });

  it('concurrent earning across two live tabs still merges losslessly, with no reset involved', () => {
    // The other half of the same fix: dropping the shadow from the write's union must
    // not cost the no-loss merge that made a union the right choice in the first
    // place. tabA and tabB boot together (both empty), each earns a DIFFERENT
    // achievement, and both must survive.
    const tabA = createAchievementsStore(localStorage);
    const tabB = createAchievementsStore(localStorage); // booted alongside tabA, same empty disk
    tabA.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } })); // tabA earns first-blood (X)
    tabB.check(ctx({ lifetime: { ...ZERO_STATS, minesLaid: 50 } })); // tabB earns minelayer (Y)
    const fresh = createAchievementsStore(localStorage).earned();
    expect([...fresh].sort()).toEqual(['first-blood', 'minelayer']);
  });

  it('a storage whose writes never land keeps the shadow as the session truth: resync must never erase it', () => {
    // Mirrors run.ts's "resync guard does not fire under a THROWING storage" test.
    // getItem keeps working off a real backing map (so it is NOT the read-throws
    // case already covered above), but setItem always throws, so nothing this
    // instance writes ever actually lands and getItem reads back empty forever.
    // Once a write has failed, resync must stop trusting that empty read as "another
    // tab reset it" -- otherwise the second check() call below would wipe first-blood
    // from the shadow even though no reset ever happened.
    const map = new Map<string, string>();
    const s = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (): void => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const store = createAchievementsStore(s);
    store.check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 1 } })); // write() catches the throw -- storage is now known broken
    expect(store.earned().has('first-blood')).toBe(true);
    store.check(ctx({ lifetime: { ...ZERO_STATS, minesLaid: 50 } })); // a second mutating call
    expect(store.earned().has('first-blood'), 'the shadow remains the truth, not wiped by the always-empty read').toBe(
      true,
    );
    expect(store.earned().has('minelayer')).toBe(true);
  });

  it('returns several at once when a single moment earns them', () => {
    const s = createAchievementsStore(localStorage);
    const ids = s
      .check(ctx({ lifetime: { ...ZERO_STATS, shellKills: 100 } }))
      .map((a) => a.id);
    expect(ids).toContain('first-blood');
    expect(ids).toContain('marksman');
    expect(ids).toContain('gunslinger');
  });
});

describe('demolition is scaled to the walls the game actually contains', () => {
  it('still asks for about three playthroughs of destructible walls', () => {
    // `wallsDestroyed` counts one `wall-destroyed` event per destructible CELL, so the
    // threshold's meaning is a function of the arena DATA, not of the achievement alone.
    // The 3x cell rescale moved the game from 16 destructible walls to 144 without
    // touching the 50 here, which turned "at least four complete playthroughs" into
    // "less than one clear of level 2". Nothing caught it: no test referenced the number.
    //
    // Recomputed from the shipped arenas rather than pinned as a literal, so a future
    // rescale fails HERE instead of silently retuning the achievement. Summed over
    // CAMPAIGN_LEVELS (issue #154), not the raw ARENAS catalog: an arena shipped but
    // never placed in the campaign would otherwise silently inflate the assumed
    // playthrough count. Numerically identical today -- campaign.json mirrors
    // ARENA_DEFS 1:1 -- so this closes a latent staleness gap rather than fixing an
    // active defect.
    const total = CAMPAIGN_LEVELS.reduce(
      (n, l) => n + loadArena(arenaById(l.arenaId)).walls.filter((w) => w.kind === 'destructible').length,
      0,
    );
    expect(total).toBeGreaterThan(0); // population guard: not a vacuous ratio

    const demolition = ACHIEVEMENTS.find((a) => a.id === 'demolition')!;
    // Binary-search the threshold out of the predicate rather than duplicating it.
    let lo = 0;
    let hi = 100_000;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (demolition.earned(ctx({ lifetime: { ...ZERO_STATS, wallsDestroyed: mid } }))) hi = mid;
      else lo = mid + 1;
    }
    expect(lo).toBeLessThanOrEqual(100_000); // the predicate must be reachable at all

    // 50/16 was 3.125 playthroughs; hold that shape within a quarter of a playthrough.
    expect(lo / total).toBeGreaterThan(2.9);
    expect(lo / total).toBeLessThan(3.4);

    // ...and the description must quote the same number the predicate enforces.
    expect(demolition.description).toContain(String(lo));
  });
});
