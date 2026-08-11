// The dev sandbox: an open floor built from plain options. The QUERY PARSING lives in
// the game layer (devflags); everything here is pure data in, world out, so replays of
// sandbox sessions stay exact functions of their inputs.
import { describe, it, expect } from 'vitest';
import { sandboxArena, createSandboxWorld, SANDBOX_ENEMY_ANCHORS } from './sandbox';
import { arenaBounds, ARENA_01, loadArena } from './arena';
import { TANK_KINDS } from './config';
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

  it('spawns yellow -- the two-tables-agree trap (KIND_LETTER here vs SPAWN_LETTERS in loadArena)', () => {
    // sandboxArena paints sandbox.ts's OWN KIND_LETTER onto the grid; loadArena then
    // reads it back through config/arena-types.ts's SPAWN_LETTERS. If a new kind is
    // added to one table and not the other, this is where it would surface: not as a
    // compile error (SPAWN_LETTERS is keyed by letter, not exhaustive over TankKind),
    // but as sandboxArena emitting a character loadArena silently drops (SPAWN_LETTERS
    // returns undefined, so PASS 1 in loadArena's `if (!kind) continue` skips the cell
    // and the tank never spawns).
    const { spawns } = loadArena(sandboxArena({ tanks: ['yellow'] }));
    expect(spawns.filter((s) => s.kind !== 'player').map((s) => s.kind)).toEqual(['yellow']);
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

it('round-trips EVERY enemy kind, so the two spawn-letter tables cannot drift apart', () => {
  // `sandbox.ts` keeps its own KIND_LETTER for grid GENERATION while `loadArena` reads
  // SPAWN_LETTERS (config/arena-types.ts) to PARSE. CLAUDE.md names the hazard; nothing
  // enforced it. Review demonstrated the hole by setting sandbox's green to 'Z': all
  // 1165 tests still passed, while `sandboxArena({tanks:['green']})` threw
  // "Unrecognized character 'Z'" the moment anyone actually used it.
  //
  // Derived from the canonical kind list, NOT a hand-written array -- that is what makes
  // a sixth kind covered on the day it exists rather than the day someone remembers.
  // The existing sandbox tests only ever used brown, grey and teal, so olive and green
  // were both unexercised here.
  const enemies = TANK_KINDS.filter((k) => k !== 'player');
  expect(enemies.length).toBeGreaterThanOrEqual(4); // population guard: not an empty sweep
  for (const kind of enemies) {
    const { spawns } = loadArena(sandboxArena({ tanks: [kind] }));
    expect(spawns.filter((s) => s.kind !== 'player').map((s) => s.kind), kind).toEqual([kind]);
  }
});

it('places every tank at the WORLD position its anchor was authored for, at any cell size', () => {
  // The sandbox borrows ARENA_01's cols/rows/cellSize but authors its anchors in cells of
  // SANDBOX_AUTHORED_CELL. When the shipped arenas were re-expressed 3x finer, the board
  // stayed 22x18 world units while these anchors, read as raw indices, collapsed into its
  // top-left ninth -- every tank inside x<7.34, y<6.0, enemies ~3x closer to the player.
  //
  // The whole existing file passed throughout, because it pins grid characters and never
  // world geometry. This asserts the world positions, which is the property that broke.
  const { tanks } = loadArena(sandboxArena({ tanks: ['brown', 'grey', 'teal'] }));
  const at = (kind: string) => tanks.find((t) => t.kind === kind)!.pos;

  // The authored anchors, in world units: cell (c,r) of a 2.0 grid sits at (2c+1, 2r+1).
  expect(at('player')).toEqual({ x: 11, y: 15 });
  expect(at('brown')).toEqual({ x: 3, y: 5 });
  expect(at('grey')).toEqual({ x: 19, y: 5 });
  expect(at('teal')).toEqual({ x: 7, y: 3 });

  // ...and they are spread across the board, not bunched in one corner. Both halves of
  // each axis must be occupied; the collapse put every tank below the midpoint of both.
  const { width, height } = arenaBounds(sandboxArena({ tanks: ['brown', 'grey', 'teal'] }));
  expect(tanks.some((t) => t.pos.x > width / 2)).toBe(true);
  expect(tanks.some((t) => t.pos.y > height / 2)).toBe(true);
});

it('scatters walls a tank cannot walk through, and keeps them clear of every spawn', () => {
  // `walls=N` is meant to place N tank-sized blocks. At a 3x-finer cell size a single
  // grid cell is 0.667 units against a 1.0 tank diameter, so the knob quietly started
  // producing pillars. It also stopped clearing spawns: the "walls may not crowd a tank
  // at birth" ring is a Chebyshev radius in CELLS, so its world reach shrank with them.
  const arena = sandboxArena({ tanks: ['brown', 'grey', 'teal'], walls: 4, seed: 7 });
  const { walls, tanks } = loadArena(arena);
  const interior = walls.filter(
    (w) => w.aabb.minX > 0 && w.aabb.minY > 0
      && w.aabb.maxX < arena.cols * arena.cellSize && w.aabb.maxY < arena.rows * arena.cellSize,
  );
  expect(interior.length).toBeGreaterThan(0); // population guard: not a vacuous sweep
  for (const w of interior) {
    expect(w.aabb.maxX - w.aabb.minX).toBeCloseTo(2, 9);
    expect(w.aabb.maxY - w.aabb.minY).toBeCloseTo(2, 9);
    // No block may sit within a full authored block of any tank's centre.
    for (const t of tanks) {
      const dx = Math.max(w.aabb.minX - t.pos.x, 0, t.pos.x - w.aabb.maxX);
      const dy = Math.max(w.aabb.minY - t.pos.y, 0, t.pos.y - w.aabb.maxY);
      expect(Math.max(dx, dy), `${t.kind} vs wall ${w.id}`).toBeGreaterThan(0.5);
    }
  }
});
