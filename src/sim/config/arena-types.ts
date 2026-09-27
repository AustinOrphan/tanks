import type { TankKind, WallKind } from '../types';

/**
 * The single source of spawn letters: the validator must reject a grid character no loader
 * can resolve, and two tables would drift. Wall characters live in each arena's `legend`;
 * `.` is open floor.
 */
export const SPAWN_LETTERS: Record<string, TankKind> = {
  P: 'player',
  B: 'brown',
  G: 'grey',
  T: 'teal',
  O: 'olive',
  // greeN: 'G' is grey's, and re-lettering grey would rewrite every campaign
  // grid. sandbox.ts's KIND_LETTER carries the same pairing for generation.
  N: 'green',
  Y: 'yellow',
};

/** Structurally identical to arena.ts's `Arena`. */
export interface ArenaShape {
  cols: number;
  rows: number;
  cellSize: number;
  legend: Record<string, WallKind>;
  grid: string[];
}

/**
 * A machine-checkable statement of design intent, verified by the runner in
 * src/sim/arena-claims.ts. `why` travels with the property it protects, so porting a grid
 * cannot strand the rationale.
 *
 * Every coordinate pair (`from`, `to`) is `[col, row]` -- the order validate.ts's `cell()`
 * reads and arena-claims.ts's `cellCentre` destructures -- while the grid is indexed
 * `grid[r][c]`. A transposition compiles (both are `[number, number]`) and only shows up
 * as a misdrawn board or a wrong cell in a failure message.
 */
export type ArenaClaim =
  | {
      /**
       * All or nothing per arena: declaring one `sightlineAfterBreach` claim commits
       * the arena to declaring one for every enemy spawn. arena-validation.test.ts
       * checks set equality between the claimed `from` cells and the arena's actual
       * enemy-spawn cells. An arena may still declare zero of them (arena-01 does).
       */
      type: 'sightlineAfterBreach';
      from: [number, number];
      sees: boolean;
      why: string;
    }
  | {
      /**
       * Hazard: `from`/`to` go through validate.ts's plain `cell()`, not
       * `enemySpawnCell()`, so nothing ties an endpoint to a spawn. Moving a spawn off
       * an endpoint leaves the lane measuring the same two cells, still passing.
       * Co-locate a `sightlineAfterBreach` claim at the same cell -- that variant
       * requires a live spawn there, so it catches the move at load time -- or
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
