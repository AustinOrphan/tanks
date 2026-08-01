import type { ArenaDefinition } from './arena-types';
import { validateArenas } from './validate';

/**
 * A deliberately NON-SHIPPED size. It exists to prove the per-level render refit
 * (PR #53) sizes and centres the ground plane correctly for a board other than
 * the shipped ones -- checked in `tools/gl/harness.ts`, both at construction and
 * through `refit()` -- and to run the geometry and claim-validation paths (this
 * file, `arena-validation.test.ts`) at that size. NOT every size-generic code
 * path: walls and tanks are not separately checked at this size.
 *
 * 17x13, NOT 15x11: it was 15x11 until arena-04 shipped at exactly that size,
 * which would have made `arena-validation.test.ts`'s "differs from every shipped
 * arena" assertion false. The fixture moved rather than the level -- a fixture
 * whose whole job is to be an unshipped size must give way to production data,
 * and the suite now covers three distinct board sizes instead of two. The name
 * stays WIDE_ARENA; every consumer reads its dimensions off the object.
 *
 * TEST-ONLY: never in ARENAS, so it cannot reach the shipped sequence. It runs
 * through the same validator as the shipped file, so it cannot rot into
 * something the real pipeline would reject.
 */
export const WIDE_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [
      {
        id: 'fixture-wide',
        cols: 17, rows: 13, cellSize: 2,
        legend: { '#': 'solid', x: 'destructible' },
        grid: [
          '.................',
          '.B.............G.',
          '.................',
          '.................',
          '.....#######.....',
          '.................',
          '........x........',
          '.................',
          '.................',
          '.......#####.....',
          '.................',
          '........P........',
          '.................',
        ],
        notes: ['17x13 fixture: proves per-level ground-plane refit and the geometry/claim validation paths at a size no shipped level uses.'],
        claims: [
          {
            // Measured, not guessed: brown's line to the player spawn crosses the
            // solid '#####' block at row 9 (cols 7-11), which is unaffected by breach
            // -- only the single destructible 'x' at (8, 6) opens, and it is not on
            // this line. So the claim is sees=false both before and after breach.
            type: 'sightlineAfterBreach', from: [1, 1], sees: false,
            why: 'The row-9 solid block still stands between brown and the player spawn after ' +
              'breach; the only destructible cell on the board is elsewhere, so brown never ' +
              'sees the player.',
          },
        ],
      },
    ],
  },
  'arena-fixtures.ts',
)[0];

/**
 * DELIBERATELY BROKEN fixtures: the negative controls for the universal geometry
 * rules (src/sim/arena-claims.ts structuralFailures). Each is structurally VALID --
 * it passes validateArenas, so it reaches the geometry rules at all -- and violates
 * exactly one rule. A guard is worth what its own tests prove.
 */
export const SEALED_POCKET_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [{
      id: 'fixture-sealed',
      cols: 5, rows: 5, cellSize: 2,
      legend: { '#': 'solid' },
      // The B in the top-left is walled off by solids: no play opens it.
      grid: ['B#...', '##...', '.....', '..P..', '.....'],
      notes: ['Negative control: a solid-sealed pocket must be reported.'],
      claims: [],
    }],
  },
  'arena-fixtures.ts',
)[0];

export const OPEN_SIGHTLINE_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [{
      id: 'fixture-sightline',
      cols: 5, rows: 5, cellSize: 2,
      legend: { '#': 'solid' },
      // Brown and the player share a column with nothing between them.
      grid: ['..B..', '.....', '.....', '.....', '..P..'],
      notes: ['Negative control: an enemy holding a straight line to the player spawn.'],
      claims: [],
    }],
  },
  'arena-fixtures.ts',
)[0];
