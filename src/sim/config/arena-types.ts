import type { TankKind, WallKind } from '../types';

/**
 * Spawn letters, the SINGLE source. `arena.ts` imports this rather than keeping
 * its own copy: the validator must reject a grid character no loader can resolve,
 * and two tables would drift. Wall characters live in each arena's `legend`; `.`
 * is open floor.
 */
export const SPAWN_LETTERS: Record<string, TankKind> = {
  P: 'player',
  B: 'brown',
  G: 'grey',
  T: 'teal',
  O: 'olive',
};

/** The geometry half of a definition -- what a bare `Arena` already is. */
export interface ArenaShape {
  cols: number;
  rows: number;
  cellSize: number;
  legend: Record<string, WallKind>;
  grid: string[];
}

/**
 * A machine-checkable statement of design intent, verified by the runner in
 * src/sim/arena-claims.ts. Every claim carries `why`: the rationale travels with
 * the property it protects, so porting a grid cannot strand it.
 *
 * Every coordinate pair below (`from`, `to`) is `[col, row]` -- matching the
 * order `loadArena` walks the grid in (`for (r) for (c) ... grid[r][c]`) and the
 * order the array literal is written in a `for (const [c, r] of ...)` destructure.
 * The runner and its tests both trust this order; a transposition compiles fine
 * (both are `[number, number]`) and only shows up as a misdrawn board or a wrong
 * cell in a failure message.
 */
export type ArenaClaim =
  | { type: 'sightlineAfterBreach'; from: [number, number]; sees: boolean; why: string }
  | {
      type: 'lane';
      from: [number, number];
      to: [number, number];
      intact: 'blocked' | 'open';
      breached: 'blocked' | 'open';
      why: string;
    }
  | { type: 'spawnBlockRobust'; nudge: number; why: string };

export interface ArenaDefinition extends ArenaShape {
  id: string;
  notes: string[];
  claims: ArenaClaim[];
}
