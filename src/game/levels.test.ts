// The level system: the one object that knows how many levels exist, where a session
// starts, and how to build the world for any of them. loop.ts consumes it through
// GameDeps, so these tests pin the real mapping the game wires in.
import { describe, it, expect } from 'vitest';
import { createLevelSystem } from './levels';
import { createRunStore, type RunStore } from './run';
import { createMemoryStorage } from './storage';
import { DEV_FLAGS_OFF } from './devflags';
import { ARENAS, arenaBounds, createWorldFor } from '../sim/arena';
import { LIVES } from '../sim/constants';

/** No active run -- the boot-with-nothing-started case. */
function noRun(): RunStore {
  return createRunStore(createMemoryStorage());
}

/** A real RunStore with an active run already sitting at `level` (0-based). */
function runAt(level: number): RunStore {
  const r = createRunStore(createMemoryStorage());
  r.startNewRun(level);
  return r;
}

describe('createLevelSystem: the shipped sequence', () => {
  it('walks ARENAS from the top', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    expect(sys.count).toBe(ARENAS.length);
    expect(sys.start).toBe(0);
  });

  it('builds level i from ARENAS[i] -- the same walls, tanks and seed', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    for (let i = 0; i < sys.count; i++) {
      // Deep-equal against the sim's own constructor with the same seed: if the mapping
      // skipped or reordered an arena, the wall layout would differ.
      expect(sys.world(i, 42)).toEqual(createWorldFor(ARENAS[i], 42));
    }
  });

  it('carries lives into the built world, for cross-level persistence', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    expect(sys.world(0, 42, undefined, 1).lives).toBe(1);
    expect(sys.world(0, 42).lives).toBe(LIVES); // absent means a fresh run
  });

  it('starts at a dev-flagged level, 1-based and clamped to what exists', () => {
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 2 }, noRun()).start).toBe(1);
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, noRun()).start).toBe(0);
    // A flag pointing past the end lands on the last level rather than crashing a
    // dev session over a stale link.
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 99 }, noRun()).start).toBe(ARENAS.length - 1);
  });
});

describe('createLevelSystem: the sandbox', () => {
  const sandboxFlags = { ...DEV_FLAGS_OFF, level: 'sandbox' as const };

  it('is a one-level sequence, so clearing it is a final win', () => {
    const sys = createLevelSystem(sandboxFlags, noRun());
    expect(sys.count).toBe(1);
    expect(sys.start).toBe(0);
  });

  it('builds the sandbox from the sandbox knobs, disarmed by default', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxTanks: ['teal', 'teal'] }, noRun());
    const w = sys.world(0, 7);
    const enemies = w.tanks.filter((t) => t.kind !== 'player');
    expect(enemies.map((t) => t.kind)).toEqual(['teal', 'teal']);
    expect(enemies.every((t) => t.disarmed === true)).toBe(true);
    expect(w.seed).toBe(7);
  });

  it('re-arms when the flag says so', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxDisarmed: false }, noRun());
    const enemies = sys.world(0, 7).tanks.filter((t) => t.kind !== 'player');
    expect(enemies.every((t) => t.disarmed === undefined)).toBe(true);
  });

  it('scatters the requested walls', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxWalls: 5 }, noRun());
    // 4 boundary walls always exist; the knob adds interior ones.
    expect(sys.world(0, 7).walls).toHaveLength(4 + 5);
  });

  it('the sandbox start ignores the active run entirely -- it is a test rig, not a level', () => {
    // A real campaign run sitting at level 4 must not leak into the sandbox's own
    // hardcoded start: the sandbox early-returns before ever consulting `run`.
    const sys = createLevelSystem(sandboxFlags, runAt(4));
    expect(sys.start).toBe(0);
  });
});

describe('createLevelSystem: the active run', () => {
  it('with no run yet, a plain session starts at level 1 -- New Game/Continue decide from title', () => {
    // Issue #153: `start` no longer infers a destination from permanent progress.
    // With nothing persisted as an active run, there is nothing to resume; the title
    // screen offers New Game (and Continue only once a run exists).
    expect(createLevelSystem(DEV_FLAGS_OFF, noRun()).start).toBe(0);
  });

  it('resumes the active run at its own persisted level', () => {
    expect(createLevelSystem(DEV_FLAGS_OFF, runAt(1)).start).toBe(1);
    // A run sitting on the last level lands there, not one past the end.
    expect(createLevelSystem(DEV_FLAGS_OFF, runAt(ARENAS.length - 1)).start).toBe(ARENAS.length - 1);
  });

  it('clamps a run whose stored level is out of range rather than crashing', () => {
    const r = runAt(0);
    r.advanceLevel(99, 3); // only reachable by a corrupt/foreign record in practice
    expect(createLevelSystem(DEV_FLAGS_OFF, r).start).toBe(ARENAS.length - 1);
  });

  it('lets a dev-flag jump beat the active run', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, runAt(3));
    expect(sys.start).toBe(0); // the flag said level 1, the run said level 4
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
    expect(sys.start).toBe(0);
    run.advanceLevel(1, 3);
    expect(sys.start).toBe(1); // the same system object, no rebuild, no reload
  });

  it('a dev-flag jump stays pinned regardless of the run', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, runAt(1));
    expect(sys.start).toBe(0); // the flag said level 1; the run says level 2
  });
});

describe('createLevelSystem: per-level bounds', () => {
  it('reports each arena\'s own board size, from cols/rows not walls', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, noRun());
    for (let i = 0; i < sys.count; i++) {
      expect(sys.bounds(i)).toEqual({ ...arenaBounds(ARENAS[i]), cellSize: ARENAS[i].cellSize });
    }
  });

  it('the sandbox reports the standard board', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 'sandbox' as const }, noRun());
    expect(sys.bounds(0)).toEqual({ ...arenaBounds(ARENAS[0]), cellSize: ARENAS[0].cellSize });
  });
});
