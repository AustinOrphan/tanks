// The level system: the one object that knows how many levels exist, where a session
// starts, and how to build the world for any of them. loop.ts consumes it through
// GameDeps, so these tests pin the real mapping the game wires in.
import { describe, it, expect } from 'vitest';
import { createLevelSystem } from './levels';
import { DEV_FLAGS_OFF } from './devflags';
import { ARENAS, createWorldFor } from '../sim/arena';
import { LIVES } from '../sim/constants';

describe('createLevelSystem: the shipped sequence', () => {
  it('walks ARENAS from the top', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF);
    expect(sys.count).toBe(ARENAS.length);
    expect(sys.start).toBe(0);
  });

  it('builds level i from ARENAS[i] -- the same walls, tanks and seed', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF);
    for (let i = 0; i < sys.count; i++) {
      // Deep-equal against the sim's own constructor with the same seed: if the mapping
      // skipped or reordered an arena, the wall layout would differ.
      expect(sys.world(i, 42)).toEqual(createWorldFor(ARENAS[i], 42));
    }
  });

  it('carries lives into the built world, for cross-level persistence', () => {
    const sys = createLevelSystem(DEV_FLAGS_OFF);
    expect(sys.world(0, 42, undefined, 1).lives).toBe(1);
    expect(sys.world(0, 42).lives).toBe(LIVES); // absent means a fresh run
  });

  it('starts at a dev-flagged level, 1-based and clamped to what exists', () => {
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 2 }).start).toBe(1);
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 1 }).start).toBe(0);
    // A flag pointing past the end lands on the last level rather than crashing a
    // dev session over a stale link.
    expect(createLevelSystem({ ...DEV_FLAGS_OFF, level: 99 }).start).toBe(ARENAS.length - 1);
  });
});

describe('createLevelSystem: the sandbox', () => {
  const sandboxFlags = { ...DEV_FLAGS_OFF, level: 'sandbox' as const };

  it('is a one-level sequence, so clearing it is a final win', () => {
    const sys = createLevelSystem(sandboxFlags);
    expect(sys.count).toBe(1);
    expect(sys.start).toBe(0);
  });

  it('builds the sandbox from the sandbox knobs, disarmed by default', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxTanks: ['teal', 'teal'] });
    const w = sys.world(0, 7);
    const enemies = w.tanks.filter((t) => t.kind !== 'player');
    expect(enemies.map((t) => t.kind)).toEqual(['teal', 'teal']);
    expect(enemies.every((t) => t.disarmed === true)).toBe(true);
    expect(w.seed).toBe(7);
  });

  it('re-arms when the flag says so', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxDisarmed: false });
    const enemies = sys.world(0, 7).tanks.filter((t) => t.kind !== 'player');
    expect(enemies.every((t) => t.disarmed === undefined)).toBe(true);
  });

  it('scatters the requested walls', () => {
    const sys = createLevelSystem({ ...sandboxFlags, sandboxWalls: 5 });
    // 4 boundary walls always exist; the knob adds interior ones.
    expect(sys.world(0, 7).walls).toHaveLength(4 + 5);
  });
});
