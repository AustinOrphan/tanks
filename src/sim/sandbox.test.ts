// The dev sandbox: an open floor built from plain options. The QUERY PARSING lives in
// the game layer (devflags); everything here is pure data in, world out, so replays of
// sandbox sessions stay exact functions of their inputs.
import { describe, it, expect } from 'vitest';
import { sandboxArena, createSandboxWorld, SANDBOX_ENEMY_ANCHORS } from './sandbox';
import { arenaBounds, ARENA_01, loadArena } from './arena';
import { validateArenaShape } from './config/validate';

describe('sandboxArena', () => {
  it('defaults to an open floor at the shipped dimensions', () => {
    const a = sandboxArena({});
    // Same board size as every shipped arena -- the renderer cannot refit per level
    // yet, and the sandbox goes through the same renderer.
    expect(arenaBounds(a)).toEqual(arenaBounds(ARENA_01));
    const { walls, spawns } = loadArena(a);
    // loadArena always adds exactly 4 boundary walls; an open floor adds none.
    expect(walls).toHaveLength(4);
    expect(spawns.filter((s) => s.kind === 'player')).toHaveLength(1);
    expect(spawns.filter((s) => s.kind !== 'player').map((s) => s.kind).sort())
      .toEqual(['brown', 'grey', 'teal']); // the classic-trio default, deliberately olive-free
  });

  it('spawns exactly the requested enemy multiset', () => {
    const { spawns } = loadArena(sandboxArena({ tanks: ['brown', 'brown', 'teal'] }));
    expect(spawns.filter((s) => s.kind !== 'player').map((s) => s.kind).sort())
      .toEqual(['brown', 'brown', 'teal']);
  });

  it('refuses more enemies than it has anchor positions, loudly', () => {
    const many = Array(SANDBOX_ENEMY_ANCHORS.length + 1).fill('brown');
    expect(() => sandboxArena({ tanks: many })).toThrow(/enem/i);
  });

  it('places exactly the requested number of interior walls, deterministically', () => {
    const a = sandboxArena({ walls: 6, seed: 11 });
    const b = sandboxArena({ walls: 6, seed: 11 });
    expect(a.grid).toEqual(b.grid); // same seed, same board -- replays depend on this
    expect(loadArena(a).walls).toHaveLength(4 + 6);
    // Different seed, different placement. Seeds 11 and 12 verified to differ when this
    // was written; if a PRNG change makes them collide, pick another pair, don't loosen.
    const c = sandboxArena({ walls: 6, seed: 12 });
    expect(c.grid).not.toEqual(a.grid);
  });

  it('never walls in a spawn: every open cell stays reachable, all spawns clear', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = sandboxArena({ walls: 12, seed });
      const open: boolean[][] = a.grid.map((row) => [...row].map((ch) => !a.legend[ch]));
      // Flood fill from the player cell; every open cell must be reached.
      const start: [number, number][] = [];
      a.grid.forEach((row, r) => {
        const c = row.indexOf('P');
        if (c >= 0) start.push([r, c]);
      });
      const seen = a.grid.map((row) => [...row].map(() => false));
      const stack = [...start];
      seen[start[0][0]][start[0][1]] = true;
      let reached = 0;
      while (stack.length) {
        const [r, c] = stack.pop()!;
        reached++;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= a.rows || nc < 0 || nc >= a.cols) continue;
          if (seen[nr][nc] || !open[nr][nc]) continue;
          seen[nr][nc] = true;
          stack.push([nr, nc]);
        }
      }
      const openCount = open.flat().filter(Boolean).length;
      expect(reached, `seed ${seed} sealed a pocket`).toBe(openCount);
    }
  });
});

describe('createSandboxWorld', () => {
  it('disarms every enemy by default, and only the enemies', () => {
    const w = createSandboxWorld({});
    for (const t of w.tanks) {
      if (t.kind === 'player') expect(t.disarmed).toBeUndefined();
      else expect(t.disarmed).toBe(true);
    }
  });

  it('arms them when asked', () => {
    const w = createSandboxWorld({ disarmed: false });
    for (const t of w.tanks) expect(t.disarmed).toBeUndefined();
  });

  it('threads the seed into the world, so AI draws are reproducible too', () => {
    expect(createSandboxWorld({ seed: 77 }).seed).toBe(77);
  });
});

it('the generated sandbox passes the same structural validator as a shipped arena', () => {
  // The sandbox is programmatic (query-parameterised, so it can never be a static
  // file), but it must clear the same bar: one player, an enemy, a legal grid.
  const arena = sandboxArena({ tanks: ['brown', 'grey', 'teal'], walls: 4, seed: 7 });
  expect(() => validateArenaShape(arena, 'sandbox', 'sandbox')).not.toThrow();
});
