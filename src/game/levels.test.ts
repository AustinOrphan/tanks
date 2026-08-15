// The level system: the one object that knows how many levels exist, where a session
// starts, and how to build the world for any of them. loop.ts consumes it through
// GameDeps, so these tests pin the real mapping the game wires in.
import { describe, it, expect } from 'vitest';
import { createLevelSystem } from './levels';
import { createRunStore, type RunStore } from './run';
import { createMemoryStorage } from './storage';
import { DEV_FLAGS_OFF } from './devflags';
import { ARENAS, arenaBounds, arenaById, createWorldFor, CAMPAIGN_LEVELS, type CampaignLevel } from '../sim/arena';
import { LIVES } from '../sim/constants';

/** No active run -- the boot-with-nothing-started case. */
function noRun(): RunStore {
  return createRunStore(createMemoryStorage());
}

/** A real RunStore with an active run already sitting at CAMPAIGN_LEVELS[level] (0-based). */
function runAt(level: number): RunStore {
  const r = createRunStore(createMemoryStorage());
  r.startNewRun(CAMPAIGN_LEVELS[level].id);
  return r;
}

describe('createLevelSystem: the shipped sequence', () => {
  it('walks CAMPAIGN_LEVELS from the top', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    expect(sys.levels).toBe(CAMPAIGN_LEVELS);
    expect(sys.levels.length).toBe(CAMPAIGN_LEVELS.length);
    expect(sys.start).toBe(CAMPAIGN_LEVELS[0]);
  });

  it('builds level i from its own arenaId -- the same walls, tanks and seed', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    for (const level of sys.levels) {
      // Deep-equal against the sim's own constructor with the same seed: if the mapping
      // skipped or reordered an arena, the wall layout would differ.
      expect(sys.world(level, 42)).toEqual(createWorldFor(arenaById(level.arenaId), 42));
    }
  });

  it('carries lives into the built world, for cross-level persistence', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    expect(sys.world(CAMPAIGN_LEVELS[0], 42, undefined, 1).lives).toBe(1);
    expect(sys.world(CAMPAIGN_LEVELS[0], 42).lives).toBe(LIVES); // absent means a fresh run
  });

  it('starts at a dev-flagged level, 1-based and clamped to what exists', () => {
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 2 }, noRun()).start).toBe(CAMPAIGN_LEVELS[1]);
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, noRun()).start).toBe(CAMPAIGN_LEVELS[0]);
    // A flag pointing past the end lands on the last level rather than crashing a
    // dev session over a stale link.
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 99 }, noRun()).start)
      .toBe(CAMPAIGN_LEVELS[CAMPAIGN_LEVELS.length - 1]);
  });
});

describe('createLevelSystem: corpseBlock/muzzleInside reach the built world (composition, not unit)', () => {
  // Unit tests on bullets.ts prove World.corpseBlocksShells/muzzleClearsTanks change
  // resolveBulletHits/muzzlePoint. They cannot see whether the DEV FLAG that is
  // supposed to set those fields actually does, through createLevelSystem's closure --
  // that is a composition question, the same distinction step-pipeline.test.ts draws
  // for sim stages.
  it('corpseBlock off leaves the shipped GHOST default', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    expect(sys.world(CAMPAIGN_LEVELS[0], 42).corpseBlocksShells).toBe(false);
  });

  it('corpseBlock on reaches world.corpseBlocksShells', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, corpseBlock: true }, noRun());
    expect(sys.world(CAMPAIGN_LEVELS[0], 42).corpseBlocksShells).toBe(true);
  });

  it('muzzleInside off leaves the new clearance ON (Austin\'s default lean)', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    expect(sys.world(CAMPAIGN_LEVELS[0], 42).muzzleClearsTanks).toBe(true);
  });

  it('muzzleInside on turns world.muzzleClearsTanks OFF, restoring the old spawn', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, muzzleInside: true }, noRun());
    expect(sys.world(CAMPAIGN_LEVELS[0], 42).muzzleClearsTanks).toBe(false);
  });

  it('both flags are independent of each other', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, corpseBlock: true, muzzleInside: true }, noRun());
    const w = sys.world(CAMPAIGN_LEVELS[0], 42);
    expect(w.corpseBlocksShells).toBe(true);
    expect(w.muzzleClearsTanks).toBe(false);
  });
});

describe('createLevelSystem: the sandbox', () => {
  const sandboxFlags = { ...DEV_FLAGS_OFF, level: 'sandbox' as const };

  it('is a one-level sequence, so clearing it is a final win', () => {
    const sys = createLevelSystem(sandboxFlags, noRun());
    expect(sys.levels.length).toBe(1);
    expect(sys.start).toBe(sys.levels[0]);
    expect(sys.start.id).toBe('sandbox');
  });

  it('builds the sandbox from the sandbox knobs, disarmed by default', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxTanks: ['teal', 'teal'] }, noRun());
    const w = sys.world(sys.start, 7);
    const enemies = w.tanks.filter((t) => t.kind !== 'player');
    expect(enemies.map((t) => t.kind)).toEqual(['teal', 'teal']);
    expect(enemies.every((t) => t.disarmed === true)).toBe(true);
    expect(w.seed).toBe(7);
  });

  it('re-arms when the flag says so', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxDisarmed: false }, noRun());
    const enemies = sys.world(sys.start, 7).tanks.filter((t) => t.kind !== 'player');
    expect(enemies.every((t) => t.disarmed === undefined)).toBe(true);
  });

  it('scatters the requested walls', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxWalls: 5 }, noRun());
    // 4 boundary walls always exist; the knob adds interior ones.
    expect(sys.world(sys.start, 7).walls).toHaveLength(4 + 5);
  });

  it('the sandbox branch wires corpseBlock/muzzleInside too, the same as the campaign branch', () => {
    const sys = createLevelSystem({ ...sandboxFlags, corpseBlock: true, muzzleInside: true }, noRun());
    const w = sys.world(sys.start, 7);
    expect(w.corpseBlocksShells).toBe(true);
    expect(w.muzzleClearsTanks).toBe(false);
  });

  it('the sandbox start ignores the active run entirely -- it is a test rig, not a level', () => {
    // A real campaign run sitting at level 4 must not leak into the sandbox's own
    // hardcoded start: the sandbox early-returns before ever consulting `run`.
    const sys = createLevelSystem(sandboxFlags, runAt(4));
    expect(sys.start.id).toBe('sandbox');
  });
});

describe('createLevelSystem: the active run', () => {
  it('with no run yet, a plain session starts at level 1 -- New Game/Continue decide from title', () => {
    // Issue #153: `start` no longer infers a destination from permanent progress.
    // With nothing persisted as an active run, there is nothing to resume; the title
    // screen offers New Game (and Continue only once a run exists).
    expect(createLevelSystem(DEV_FLAGS_OFF, noRun()).start).toBe(CAMPAIGN_LEVELS[0]);
  });

  it('resumes the active run at its own persisted level', () => {
    expect(createLevelSystem(DEV_FLAGS_OFF, runAt(1)).start).toBe(CAMPAIGN_LEVELS[1]);
    // A run sitting on the last level lands there, not one past the end.
    expect(createLevelSystem(DEV_FLAGS_OFF, runAt(CAMPAIGN_LEVELS.length - 1)).start)
      .toBe(CAMPAIGN_LEVELS[CAMPAIGN_LEVELS.length - 1]);
  });

  it('falls back to level 1 for a run whose stored id names no real level, rather than crashing', () => {
    // Only reachable by a corrupt/foreign record in practice -- run.ts never writes
    // an id that isn't a real CampaignLevel's. The graceful fallback (not the
    // throwing campaignLevelById) is what makes this survivable at boot.
    const r = createRunStore(createMemoryStorage());
    r.startNewRun(CAMPAIGN_LEVELS[0].id);
    r.advanceLevel('level-does-not-exist', 3);
    expect(createLevelSystem(DEV_FLAGS_OFF, r).start).toBe(CAMPAIGN_LEVELS[0]);
  });

  it('lets a dev-flag jump beat the active run', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, runAt(3));
    expect(sys.start).toBe(CAMPAIGN_LEVELS[0]); // the flag said level 1, the run said level 4
  });

  it('tracks progress for the shipped sequence and NOT for the sandbox', () => {
    expect(createLevelSystem(DEV_FLAGS_OFF, noRun()).tracksProgress).toBe(true);
    // A sandbox win must never unlock real levels: it is a test rig, not play.
    expect(
      createLevelSystem({ ...DEV_FLAGS_OFF, level: 'sandbox' as const }, noRun()).tracksProgress,
    ).toBe(false);
  });

  // Defect 1 (adjudicated review of #156): `tracksProgress` alone does not tell a real
  // campaign session apart from a dev-flag jump -- both are `true`. A jumped session
  // must not be mistaken for one that owns the active RUN (loop.ts's campaignActive),
  // which is what let a win at a jumped level regress a mid-campaign run and a loss
  // destroy it outright. `isDevJump` is the seam that lets loop.ts tell them apart,
  // right where `jump` is already computed.
  describe('isDevJump', () => {
    it('is false for a plain session, with or without an active run', () => {
      expect(createLevelSystem(DEV_FLAGS_OFF, noRun()).isDevJump).toBe(false);
      expect(createLevelSystem(DEV_FLAGS_OFF, runAt(3)).isDevJump).toBe(false);
    });

    it('is true whenever ?dev=1&level=N is present, regardless of the run', () => {
      expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, noRun()).isDevJump).toBe(true);
      expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, runAt(3)).isDevJump).toBe(true);
      // Out-of-range jumps still clamp `start`, and are still a jump.
      expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 99 }, noRun()).isDevJump).toBe(true);
    });

    it('is false for the sandbox -- already excluded from campaign-run play via tracksProgress', () => {
      expect(
        createLevelSystem({ ...DEV_FLAGS_OFF, level: 'sandbox' as const }, noRun()).isDevJump,
      ).toBe(false);
    });
  });
});

describe('createLevelSystem: start is live, not a boot-time snapshot', () => {
  it('moves when the run moves, so a mid-session level clear changes where quit lands', () => {
    // Reported 2026-07-31 (originally against highestCleared, now against the active
    // run): clear level 1, quit -- the menu rebuilt at level 1 even though level 2 was
    // now current, because start was computed once at boot. The tell: correct after a
    // refresh (boot recomputes), wrong within the session.
    const run = runAt(0);
    const sys = createLevelSystem(DEV_FLAGS_OFF, run);
    expect(sys.start).toBe(CAMPAIGN_LEVELS[0]);
    run.advanceLevel(CAMPAIGN_LEVELS[1].id, 3);
    expect(sys.start).toBe(CAMPAIGN_LEVELS[1]); // the same system object, no rebuild, no reload
  });

  it('a dev-flag jump stays pinned regardless of the run', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, runAt(1));
    expect(sys.start).toBe(CAMPAIGN_LEVELS[0]); // the flag said level 1; the run says level 2
  });
});

describe('createLevelSystem: per-level bounds', () => {
  it('reports each arena\'s own board size, from cols/rows not walls', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    for (const level of sys.levels) {
      const arena = arenaById(level.arenaId);
      expect(sys.bounds(level)).toEqual({ ...arenaBounds(arena), cellSize: arena.cellSize });
    }
  });

  it('the sandbox reports the standard board', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 'sandbox' as const }, noRun());
    expect(sys.bounds(sys.start)).toEqual({ ...arenaBounds(ARENAS[0]), cellSize: ARENAS[0].cellSize });
  });
});

describe('createLevelSystem: resolves through campaign data, not ARENAS position (issue #154)', () => {
  it('a reordered campaign builds the level at position 0 from ITS OWN arenaId, not ARENAS[0]', () => {
    // The assertion that actually fails if levels.ts ever reverts to indexing ARENAS
    // by position: a mechanical swap of the old `ARENAS[i]` pin to `CAMPAIGN_LEVELS[i]`
    // alone would stay numerically green under this exact regression, since today's
    // shipped campaign order is still 1:1 with ARENAS' own order.
    const reordered: readonly CampaignLevel[] = [
      CAMPAIGN_LEVELS[1], // arena-02
      CAMPAIGN_LEVELS[0], // arena-01
      ...CAMPAIGN_LEVELS.slice(2),
    ];
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun(), reordered);
    expect(sys.levels[0].arenaId).toBe('arena-02');
    expect(sys.world(sys.levels[0], 42)).toEqual(createWorldFor(arenaById('arena-02'), 42));
    expect(sys.world(sys.levels[0], 42)).not.toEqual(createWorldFor(arenaById('arena-01'), 42));
  });

  it('start and every element of levels agree on object identity, in BOTH branches (the LevelSystem invariant loop.ts relies on)', () => {
    // loop.ts's ordinalOf/nextInSession do `deps.levels.levels.indexOf(l)` -- silently
    // returning -1 (read as "not found", ordinal 0 or `null` for "next") if `start`
    // were ever a freshly-constructed lookalike instead of a reference INTO `levels`.
    // Nothing else would catch a future regression here; it would not crash.
    const real = createLevelSystem(DEV_FLAGS_OFF, noRun());
    expect(real.levels.includes(real.start)).toBe(true);

    const sandbox = createLevelSystem({ ...DEV_FLAGS_OFF, level: 'sandbox' as const }, noRun());
    expect(sandbox.levels.includes(sandbox.start)).toBe(true);
  });
});
