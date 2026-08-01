import type { ArenaDefinition } from './arena-types';
import { validateArenas } from './validate';

/**
 * A deliberately NON-11x9 arena. It exists to prove the per-level render refit
 * (PR #53) sizes and centres the ground plane correctly for a board other than
 * the shipped one -- checked in `tools/gl/harness.ts`, both at construction and
 * through `refit()` -- and to run the geometry and claim-validation paths (this
 * file, `arena-validation.test.ts`) at that size. NOT every size-generic code
 * path: walls and tanks are not separately checked at this size.
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
        cols: 15, rows: 11, cellSize: 2,
        legend: { '#': 'solid', x: 'destructible' },
        grid: [
          '...............',
          '.B...........G.',
          '...............',
          '....#####......',
          '...............',
          '......x........',
          '...............',
          '......###......',
          '...............',
          '.......P.......',
          '...............',
        ],
        notes: ['15x11 fixture: proves per-level ground-plane refit and the geometry/claim validation paths at a non-shipped size.'],
        claims: [
          {
            // Measured, not guessed: brown's line to the player spawn crosses the
            // solid '###' block at row 7 (cols 6-8), which is unaffected by breach
            // -- only the single destructible 'x' at (6, 5) opens, and it is not on
            // this line. So the claim is sees=false both before and after breach.
            type: 'sightlineAfterBreach', from: [1, 1], sees: false,
            why: 'The row-7 solid block still stands between brown and the player spawn after ' +
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
