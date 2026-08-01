// The level system: the one object that knows how many levels exist, where a session
// starts, and how to build the world for any of them. loop.ts consumes it through
// GameDeps, so these tests pin the real mapping the game wires in.
import { describe, it, expect } from 'vitest';
import { createLevelSystem } from './levels';
import type { ProgressStore } from './progress';
import { DEV_FLAGS_OFF } from './devflags';

/** A progress store at a fixed high-water mark; recording is a test-visible no-op. */
function progressAt(highest: number): ProgressStore {
  return { highestCleared: () => highest, recordCleared: () => {}, reset: () => {} };
}
import { ARENAS, arenaBounds, createWorldFor } from '../sim/arena';
import { LIVES } from '../sim/constants';

describe('createLevelSystem: the shipped sequence', () => {
  it('walks ARENAS from the top', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, progressAt(0));
    expect(sys.count).toBe(ARENAS.length);
    expect(sys.start).toBe(0);
  });

  it('builds level i from ARENAS[i] -- the same walls, tanks and seed', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, progressAt(0));
    for (let i = 0; i < sys.count; i++) {
      // Deep-equal against the sim's own constructor with the same seed: if the mapping
      // skipped or reordered an arena, the wall layout would differ.
      expect(sys.world(i, 42)).toEqual(createWorldFor(ARENAS[i], 42));
    }
  });

  it('carries lives into the built world, for cross-level persistence', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, progressAt(0));
    expect(sys.world(0, 42, undefined, 1).lives).toBe(1);
    expect(sys.world(0, 42).lives).toBe(LIVES); // absent means a fresh run
  });

  it('starts at a dev-flagged level, 1-based and clamped to what exists', () => {
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 2 }, progressAt(0)).start).toBe(1);
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, progressAt(0)).start).toBe(0);
    // A flag pointing past the end lands on the last level rather than crashing a
    // dev session over a stale link.
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 99 }, progressAt(0)).start).toBe(ARENAS.length - 1);
  });
});

describe('createLevelSystem: the sandbox', () => {
  const sandboxFlags = { ...DEV_FLAGS_OFF, level: 'sandbox' as const };

  it('is a one-level sequence, so clearing it is a final win', () => {
    const sys = createLevelSystem(sandboxFlags, progressAt(0));
    expect(sys.count).toBe(1);
    expect(sys.start).toBe(0);
  });

  it('builds the sandbox from the sandbox knobs, disarmed by default', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxTanks: ['teal', 'teal'] }, progressAt(0));
    const w = sys.world(0, 7);
    const enemies = w.tanks.filter((t) => t.kind !== 'player');
    expect(enemies.map((t) => t.kind)).toEqual(['teal', 'teal']);
    expect(enemies.every((t) => t.disarmed === true)).toBe(true);
    expect(w.seed).toBe(7);
  });

  it('re-arms when the flag says so', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxDisarmed: false }, progressAt(0));
    const enemies = sys.world(0, 7).tanks.filter((t) => t.kind !== 'player');
    expect(enemies.every((t) => t.disarmed === undefined)).toBe(true);
  });

  it('scatters the requested walls', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxWalls: 5 }, progressAt(0));
    // 4 boundary walls always exist; the knob adds interior ones.
    expect(sys.world(0, 7).walls).toHaveLength(4 + 5);
  });
});

describe('createLevelSystem: saved progress', () => {
  it('starts a plain session at the furthest unlocked level', () => {
    // Cleared level 1 -> the session opens on level 2, Wii Play style.
    expect(createLevelSystem(DEV_FLAGS_OFF, progressAt(1)).start).toBe(1);
    // Cleared everything -> the LAST level, not one past the end.
    expect(createLevelSystem(DEV_FLAGS_OFF, progressAt(99)).start).toBe(ARENAS.length - 1);
  });

  it('lets a dev-flag jump beat saved progress', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, progressAt(1));
    expect(sys.start).toBe(0); // the flag said level 1, progress said level 2
  });

  it('tracks progress for the shipped sequence and NOT for the sandbox', () => {
    expect(createLevelSystem(DEV_FLAGS_OFF, progressAt(0)).tracksProgress).toBe(true);
    // A sandbox win must never unlock real levels: it is a test rig, not play.
    expect(
      createLevelSystem({ ...DEV_FLAGS_OFF, level: 'sandbox' as const }, progressAt(0)).tracksProgress,
    ).toBe(false);
  });
});

describe('createLevelSystem: start is live, not a boot-time snapshot', () => {
  it('moves when progress moves, so a mid-session unlock changes where quit lands', () => {
    // Reported 2026-07-31: clear level 1, quit -- the menu rebuilt at level 1 even
    // though level 2 was now unlocked, because start was computed once at boot. The
    // tell: correct after a refresh (boot recomputes), wrong within the session.
    let cleared = 0;
    const live: ProgressStore = {
      highestCleared: () => cleared,
      recordCleared: (l) => {
        cleared = Math.max(cleared, l);
      },
      reset: () => {
        cleared = 0;
      },
    };
    const sys = createLevelSystem(DEV_FLAGS_OFF, live);
    expect(sys.start).toBe(0);
    live.recordCleared(1);
    expect(sys.start).toBe(1); // the same system object, no rebuild, no reload
  });

  it('a dev-flag jump stays pinned regardless of progress', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }, progressAt(1));
    expect(sys.start).toBe(0); // the flag said level 1; the save says level 2
  });
});

describe('createLevelSystem: per-level bounds', () => {
  it('reports each arena\'s own board size, from cols/rows not walls', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF, progressAt(0));
    for (let i = 0; i < sys.count; i++) {
      expect(sys.bounds(i)).toEqual({ ...arenaBounds(ARENAS[i]), cellSize: ARENAS[i].cellSize });
    }
  });

  it('the sandbox reports the standard board', () => {
    const sys = createLevelSystem({ ...DEV_FLAGS_OFF, level: 'sandbox' as const }, progressAt(0));
    expect(sys.bounds(0)).toEqual({ ...arenaBounds(ARENAS[0]), cellSize: ARENAS[0].cellSize });
  });
});
