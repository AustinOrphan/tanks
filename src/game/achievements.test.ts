// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACHIEVEMENTS_KEY,
  ACHIEVEMENTS,
  createAchievementsStore,
  type AchievementContext,
} from './achievements';
import { ZERO_STATS } from './stats';

const ctx = (over: Partial<AchievementContext> = {}): AchievementContext => ({
  lifetime: { ...ZERO_STATS },
  run: { ...ZERO_STATS },
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

  it('run feats stay dormant until a level is actually cleared', () => {
    // Each must be false mid-run with a feat-worthy tally and true only once
    // clearedLevel lands -- otherwise a feat fires on the frame the tally happens to
    // qualify and the player is credited for a level they went on to lose.
    //
    // Population: all 4 run feats, NAMED rather than derived by a filter. Review proved the filter
    // silently dropped two of the four (bomb-squad, because the fixture had shell
    // kills; flawless, because it is already true on a zeroed run), so dropping
    // atClear from either would have left this green.
    const RUN_FEATS = ['flawless', 'dead-eye', 'bomb-squad', 'survivor'];
    const feat = { deaths: 0, shotsFired: 4, shellKills: 4, mineKills: 2 };
    const bombRun = { deaths: 0, shotsFired: 0, shellKills: 0, mineKills: 2 };
    for (const id of RUN_FEATS) {
      const a = ACHIEVEMENTS.find((x) => x.id === id)!;
      // The tally that would earn it, but mid-round: clearedLevel is still null.
      const tally = id === 'bomb-squad' ? bombRun : feat;
      expect(a.earned(ctx({ run: { ...ZERO_STATS, ...tally }, livesLeft: 1 })), id).toBe(false);
      // And the same tally at a clear earns it -- so the false above is the GATE,
      // not merely a predicate that never fires.
      expect(
        a.earned(ctx({ run: { ...ZERO_STATS, ...tally }, livesLeft: 1, clearedLevel: 1 })),
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
      run: { ...ZERO_STATS, mineKills: 2, shotsFired: 0, shellKills: 0 },
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
