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
  // greeN: 'G' is grey's, and re-lettering grey would rewrite all four shipped
  // grids. sandbox.ts's KIND_LETTER carries the same pairing for generation.
  N: 'green',
  Y: 'yellow',
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
  | {
      /**
       * ALL-OR-NOTHING PER ARENA: declaring one `sightlineAfterBreach` claim commits
       * the arena to declaring one for EVERY enemy spawn. arena-validation.test.ts
       * checks this by SET EQUALITY between the claimed `from` cells and the arena's
       * actual enemy-spawn cells, in both directions, so an arena's claims of this
       * type are a COMPLETE statement of its post-breach spawn lines, never a
       * sample -- restoring a population pin the JSON migration had dropped. An
       * arena may still declare zero of them (arena-01 does).
       */
      type: 'sightlineAfterBreach';
      from: [number, number];
      sees: boolean;
      why: string;
    }
  | {
      /**
       * A line between two points, checked in both wall phases. HAZARD: `from`/`to`
       * are LITERAL grid cells, routed through the plain `cell()` validator rather
       * than `enemySpawnCell()` -- nothing ties an endpoint to a spawn. Moving a
       * spawn away from an endpoint does not invalidate the claim: the lane keeps
       * measuring the same two cells (now possibly empty floor) and keeps passing.
       * Co-locate a `sightlineAfterBreach` claim at the same cell -- that variant
       * DOES require a live spawn there, so it catches the move at load time -- or
       * re-check the lane by hand after moving any spawn it references.
       */
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
