// Structural validation for EVERY shipped arena, present and future. Each rule here is
// one a hand-drawn grid can silently break: a sealed pocket looks fine in ASCII, and a
// spawn sightline is invisible until a player dies to it three seconds into a level.
// New arenas added to ARENAS get all of this for free -- that is the point of the file.
import { describe, it, expect } from 'vitest';
import { ARENAS, ARENA_01, loadArena } from './arena';
import type { Arena } from './arena';
import { lineOfSight } from './ai/targeting';

/**
 * A cell a tank could EVER stand on: open now, or openable by demolition. The
 * 2026-07-31 balance pass made ARENA_02's middle bar a full destructible barrier --
 * the halves START sealed and the level is about breaching it -- so plain-open
 * connectivity is a design choice, not an invariant. Solid-sealed pockets remain
 * forbidden: no amount of play opens those.
 */
function isBreachable(arena: Arena, r: number, c: number): boolean {
  const kind = arena.legend[arena.grid[r][c]];
  return !kind || kind === 'destructible';
}

/** 4-neighbour flood fill from the first open cell; returns the number reached. */
function reachableOpenCells(arena: Arena): { open: number; reached: number } {
  const { rows, cols } = arena;
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
  let open = 0;
  let start: [number, number] | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isBreachable(arena, r, c)) {
        open++;
        if (!start) start = [r, c];
      }
    }
  }
  if (!start) return { open, reached: 0 };
  const stack = [start];
  seen[start[0]][start[1]] = true;
  let reached = 0;
  while (stack.length) {
    const [r, c] = stack.pop()!;
    reached++;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (seen[nr][nc] || !isBreachable(arena, nr, nc)) continue;
      seen[nr][nc] = true;
      stack.push([nr, nc]);
    }
  }
  return { open, reached };
}

describe('the shipped arena sequence', () => {
  it('starts at ARENA_01, the arena the game has always shipped', () => {
    expect(ARENAS[0]).toBe(ARENA_01);
    expect(ARENAS.length).toBeGreaterThanOrEqual(2); // progression needs somewhere to go
  });

  describe.each(ARENAS.map((a, i) => ({ a, i })))('arena $i', ({ a }) => {
    it('loads, with exactly one player spawn and at least one enemy', () => {
      const { tanks, spawns } = loadArena(a);
      expect(spawns.filter((s) => s.kind === 'player')).toHaveLength(1);
      expect(tanks.filter((t) => t.kind !== 'player').length).toBeGreaterThanOrEqual(1);
    });

    it('has every breachable cell reachable from every other (no SOLID-sealed pockets)', () => {
      // Destructibles count as passable-eventually: a region behind them is gameplay
      // (ARENA_02's sealed halves), a region behind solids is a dead zone forever.
      const { open, reached } = reachableOpenCells(a);
      expect(reached).toBe(open);
    });

    it('denies every enemy a straight line to the player spawn', () => {
      // Level 1 was DESIGNED around this (see ARENA_01's comment: Teal must bank a
      // ricochet). Brown never moves, so an enemy spawn with direct line of sight to
      // the player spawn is a death sentence three seconds into the level. The check
      // uses the sim's own lineOfSight, so it means exactly what the AI means by it.
      const { walls, spawns } = loadArena(a);
      const player = spawns.find((s) => s.kind === 'player')!;
      for (const s of spawns) {
        if (s.kind === 'player') continue;
        expect(lineOfSight(s.pos, player.pos, walls), `${s.kind} sees the player spawn`).toBe(false);
      }
    });
  });
});

describe("ARENA_02's destructible trade", () => {
  // The design comment claims blowing the bars' destructible ends opens the UPPER
  // pair's lanes and nothing else. The generic sightline test above cannot see WHAT
  // does the blocking -- it went green while the comment overclaimed the trade for
  // all four enemies. Measured here instead: this fails if a grid edit either opens
  // a lower lane (a solid outer end went missing) or seals an upper one (the trade
  // the level is built around stopped existing).
  it('opens exactly the two upper lanes when every destructible is gone', () => {
    const { walls, spawns } = loadArena(ARENAS[1]);
    for (const w of walls) if (w.kind === 'destructible') w.destroyed = true;
    const player = spawns.find((s) => s.kind === 'player')!;
    const open = spawns
      .filter((s) => s.kind !== 'player')
      .map((s) => ({ kind: s.kind, y: s.pos.y, sees: lineOfSight(s.pos, player.pos, walls) }));
    // Population: all 4 enemy spawns. Upper row (y = 5) opens; lower row (y = 7) stays shut.
    expect(open.filter((o) => o.y === 5).map((o) => o.sees)).toEqual([true, true]);
    expect(open.filter((o) => o.y === 7).map((o) => o.sees)).toEqual([false, false]);
    expect(open).toHaveLength(4);
  });
});
