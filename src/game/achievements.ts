import type { StatCounts } from './stats';

/**
 * Named feats, latched once earned.
 *
 * Everything here is DERIVED from tallies the game already keeps -- stats.ts counts
 * the attributed event stream, progress.ts tracks cleared levels. The only new state
 * is the set of ids already earned, which is why this store exists at all: an
 * achievement records that something HAPPENED, so it must outlive the counter that
 * proved it. Reset progress clears it; Reset stats deliberately does not.
 *
 * Game layer only, paranoid like its siblings: one key, corrupt data reads as none
 * earned, a throwing storage degrades to an in-memory shadow, and ids the catalog no
 * longer knows are dropped rather than shown as ghost rows.
 */
export const ACHIEVEMENTS_KEY = 'tanks.achievements.v1';

export interface AchievementContext {
  /** The lifetime tally, for cumulative milestones. */
  lifetime: StatCounts;
  /**
   * The current ATTEMPT's tally -- zeroed per level by the loop's switchTo. Named
   * `attempt`, not `run`: issue #153 reserves `run` for the whole-campaign concept
   * (see run.ts), and every feat below is level-sized, exactly the "level-sized
   * stats bucket" the spec's terminology audit calls out.
   */
  attempt: StatCounts;
  highestCleared: number;
  totalLevels: number;
  /**
   * The 1-based level just cleared, non-null ONLY on the frame a win lands. Attempt
   * feats gate on it: without that gate a feat fires the moment the tally happens to
   * qualify, crediting the player for a level they went on to lose.
   */
  clearedLevel: number | null;
  /** Lives remaining, for feats about finishing on the ropes. */
  livesLeft: number;
  /**
   * Whether this level set is the real campaign. The dev sandbox is a ONE-level
   * set, so a progress milestone measured against `totalLevels` would hand out
   * "clear every level" to anyone who opens ?level=sandbox having cleared level 1.
   */
  tracksProgress: boolean;
}

export interface AchievementDef {
  id: AchievementId;
  label: string;
  description: string;
  /** Pure predicate: every entry is testable without a game. */
  earned(ctx: AchievementContext): boolean;
}

export type AchievementId =
  | 'first-blood'
  | 'marksman'
  | 'gunslinger'
  | 'sapper'
  | 'demolition'
  | 'trick-shot'
  | 'minelayer'
  | 'petard'
  | 'boots-on-ground'
  | 'campaigner'
  | 'flawless'
  | 'dead-eye'
  | 'bomb-squad'
  | 'survivor';

/** An attempt feat only counts at the moment of a clear. */
const atClear =
  (pred: (c: AchievementContext) => boolean) =>
  (c: AchievementContext): boolean =>
    c.clearedLevel !== null && pred(c);

export const ACHIEVEMENTS: readonly AchievementDef[] = Object.freeze([
  {
    id: 'first-blood',
    label: 'First Blood',
    description: 'Destroy a tank with a shell.',
    earned: (c) => c.lifetime.shellKills >= 1,
  },
  {
    id: 'marksman',
    label: 'Marksman',
    description: 'Destroy 25 tanks with shells.',
    earned: (c) => c.lifetime.shellKills >= 25,
  },
  {
    id: 'gunslinger',
    label: 'Gunslinger',
    description: 'Destroy 100 tanks with shells.',
    earned: (c) => c.lifetime.shellKills >= 100,
  },
  {
    id: 'sapper',
    label: 'Sapper',
    description: 'Destroy 10 tanks with mines.',
    earned: (c) => c.lifetime.mineKills >= 10,
  },
  {
    id: 'demolition',
    label: 'Demolition',
    // A `wall-destroyed` event is one destructible CELL, and the 3x arena rescale made a
    // cell an eighteenth of the area it was: the whole game held 16 destructible walls
    // (arena-01 2, -02 8, -03 3, -04 3) and now holds 144 (18 / 72 / 27 / 27). At the old
    // 50 this needed at least four complete playthroughs; unchanged it would be cleared
    // inside level 2 alone, which holds 72, by roughly three well-placed mines.
    //
    // Scaled by the same 9x so the ASK is what it was. It is one number and pure feel --
    // retune it freely, but do not read the old 50 as still meaning what it meant.
    //
    // arena-05 added 18 more (its bar reuses arena-04's two 3x3 anchor segments; unlike
    // arena-04 it carries no mid-field destructible -- everything south of the bar was
    // redesigned in solid walls only), taking the total to 162. Retuned from 450 to 540
    // to stay within a quarter playthrough of the original shape (540/162 = 3.33,
    // against the original 450/144 = 3.125) rather than let a fifth level quietly
    // shrink the ask; 3.33 is honest rather than re-tuned to land closer to 3.125,
    // since the exact multiple is feel, not a contract.
    description: 'Blow apart 540 walls.',
    earned: (c) => c.lifetime.wallsDestroyed >= 540,
  },
  {
    id: 'trick-shot',
    label: 'Trick Shot',
    description: 'Bounce 25 shells off walls.',
    earned: (c) => c.lifetime.ricochets >= 25,
  },
  {
    id: 'minelayer',
    label: 'Minelayer',
    description: 'Lay 50 mines.',
    earned: (c) => c.lifetime.minesLaid >= 50,
  },
  {
    id: 'petard',
    label: 'Hoist by His Own Petard',
    description: 'Destroy yourself with your own ordnance. It happens.',
    earned: (c) => c.lifetime.selfKills >= 1,
  },
  {
    id: 'boots-on-ground',
    label: 'Boots on the Ground',
    description: 'Clear a level.',
    earned: (c) => c.highestCleared >= 1,
  },
  {
    id: 'campaigner',
    label: 'Campaigner',
    description: 'Clear every level.',
    // >= totalLevels, not "the last one unlocked": with one level left this must
    // stay locked, which a `highestCleared > 0` style test would not catch.
    earned: (c) => c.tracksProgress && c.totalLevels > 0 && c.highestCleared >= c.totalLevels,
  },
  {
    id: 'flawless',
    label: 'Flawless',
    description: 'Clear a level without losing a life.',
    earned: atClear((c) => c.attempt.deaths === 0),
  },
  {
    id: 'dead-eye',
    label: 'Dead Eye',
    description: 'Clear a level where every shell you fired found a tank.',
    earned: atClear((c) => c.attempt.shotsFired > 0 && c.attempt.shellKills === c.attempt.shotsFired),
  },
  {
    id: 'bomb-squad',
    label: 'Bomb Squad',
    description: 'Clear a level on mines alone, without a single shell kill.',
    earned: atClear((c) => c.attempt.mineKills > 0 && c.attempt.shellKills === 0),
  },
  {
    id: 'survivor',
    label: 'Survivor',
    description: 'Clear a level with one life left.',
    earned: atClear((c) => c.livesLeft === 1),
  },
]);

const IDS = new Set<string>(ACHIEVEMENTS.map((a) => a.id));

export interface AchievementsStore {
  earned(): ReadonlySet<AchievementId>;
  /**
   * Evaluate the catalog, latch anything newly true, and return the NEWLY earned
   * defs -- that return value is the toast queue. An already-earned entry never
   * returns again, so a toast cannot repeat.
   */
  check(ctx: AchievementContext): AchievementDef[];
  /** Cleared by Reset progress: achievements are progress, not statistics. */
  reset(): void;
}

function read(storage: Storage): Set<AchievementId> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(ACHIEVEMENTS_KEY);
  } catch {
    return new Set();
  }
  if (raw === null || raw === '') return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Set();
    const list = (parsed as { earned?: unknown }).earned;
    if (!Array.isArray(list)) return new Set();
    // Unknown ids are DROPPED: a renamed achievement must not come back as a row
    // the page cannot label.
    return new Set(list.filter((id): id is AchievementId => typeof id === 'string' && IDS.has(id)));
  } catch {
    return new Set();
  }
}

export function createAchievementsStore(storage: Storage): AchievementsStore {
  let shadow = read(storage);

  // Flips to false the first time write() catches an exception, and never flips
  // back. Guards resync() below -- same convention as run.ts's storageIsWritable,
  // for the same reason: a storage that has already failed to persist THIS
  // instance's own writes must not be trusted to answer "what does disk actually
  // hold". Safari private mode lets getItem keep succeeding -- reading back empty,
  // because nothing this instance wrote ever actually landed -- even though
  // setItem always throws. Treating that empty read as ground truth would erase
  // the one copy of this session's earned ids the degrade path exists to protect.
  let storageIsWritable = true;

  /** The blind write. Only reset() may use it: a union would resurrect what it clears. */
  function write(ids: Iterable<AchievementId>): void {
    try {
      storage.setItem(ACHIEVEMENTS_KEY, JSON.stringify({ earned: [...ids] }));
    } catch {
      // Private mode or quota: the shadow carries the session.
      storageIsWritable = false;
    }
  }

  /**
   * Resync the shadow to disk before evaluating what's newly earned, so DISK --
   * not the shadow's own history -- decides what "already earned" means. This is
   * the fix for PR #62's residual: a tab left open across Reset progress keeps a
   * shadow full of pre-reset ids, and the old persist() unioned that shadow INTO
   * disk, which brought every one of them back the next time this tab earned
   * anything at all. Resyncing first means the write becomes (disk ∪
   * newly-earned-this-call), not (shadow ∪ disk ∪ new) -- a reset in another tab
   * stays reset, because the ids it cleared are no longer in the base this tab
   * unions onto.
   *
   * Gated on storageIsWritable, exactly like run.ts's refreshShadowIfEnded: once
   * this instance's own write has failed, a later getItem can keep succeeding
   * while reporting nothing, because nothing this instance wrote ever actually
   * landed (see storageIsWritable's doc comment). Treating that empty read as "a
   * reset happened elsewhere" would erase the shadow -- the one copy of this
   * session's earned ids this degrade path exists to protect -- on a session that
   * may never have had a second tab at all. So a known-broken storage is
   * excluded, and the shadow stays the truth for the rest of the session, exactly
   * as before this fix existed.
   */
  function resync(): void {
    if (!storageIsWritable) return;
    shadow = read(storage);
  }

  function persist(): void {
    // shadow is already (disk ∪ this call's fresh ids) once resync() has run --
    // see its doc comment. Nothing left to union here.
    write(shadow);
  }

  return {
    // A COPY, not the live Set: `ReadonlySet` is compile-time only, and a caller
    // that added to the internal set would silently suppress that achievement's
    // real toast forever. It also makes the HUD's refresh wiring falsifiable --
    // a held reference no longer updates itself.
    earned: () => new Set(shadow),
    check(ctx: AchievementContext): AchievementDef[] {
      resync();
      const fresh = ACHIEVEMENTS.filter((a) => !shadow.has(a.id) && a.earned(ctx));
      if (fresh.length === 0) return [];
      for (const a of fresh) shadow.add(a.id);
      persist();
      return fresh;
    },
    reset(): void {
      // clear(), not a new Set: a swap leaves any held reference pointing at the
      // pre-reset ids, which is a different behaviour from the in-place add above.
      //
      // Deliberately does NOT call resync(): reset is the one explicit action
      // allowed to replace whatever disk currently holds, the same way run.ts's
      // startNewRun skips refreshShadowIfEnded -- see resync's doc comment.
      shadow.clear();
      write(shadow); // NOT persist(): the union would instantly resurrect everything
    },
  };
}
