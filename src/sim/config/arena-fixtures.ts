import type { ArenaDefinition } from './arena-types';
import { validateArenas } from './validate';
import { createWorldFor } from '../arena';
import type { World } from '../world';
import type { UnarmedTrigger } from '../types';

/**
 * A deliberately non-shipped size. It exists to prove the per-level render refit
 * (PR #53) sizes and centres the ground plane correctly for a board other than
 * the shipped ones -- checked in `tools/gl/harness.ts`, both at construction and
 * through `refit()` -- and to run the geometry and claim-validation paths (this
 * file, `arena-validation.test.ts`) at that size. Not every size-generic code
 * path: walls and tanks are not separately checked at this size.
 *
 * `arena-validation.test.ts` pins it at 17x13 and asserts that size differs from
 * every shipped arena's. If a shipped level ever takes it, the fixture moves
 * rather than the level: its whole job is to be an unshipped size.
 *
 * Test-only: never in ARENAS, so it cannot reach the shipped sequence. It runs
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
 * Deliberately broken fixtures: the negative controls for the universal geometry
 * rules (src/sim/arena-claims.ts structuralFailures). Each is structurally valid --
 * it passes validateArenas, so it reaches the geometry rules at all -- and violates
 * exactly one rule. A guard is worth what its own tests prove.
 */
export const SEALED_POCKET_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [{
      id: 'fixture-sealed',
      cols: 5, rows: 5, cellSize: 2,
      legend: { '#': 'solid' },
      grid: ['B#...', '##...', '.....', '..P..', '.....'],
      notes: ['Negative control: a solid-sealed pocket must be reported.'],
      claims: [],
    }],
  },
  'arena-fixtures.ts',
)[0];

/**
 * Negative control for the STATIONARY-banker spawn rule. Green at (1, 1) has no direct
 * line to the player at (5, 1) -- the solid at (3, 1) sits squarely between them -- but
 * can ricochet off the boundary ring and land on the spawn anyway. That is the whole
 * point of the rule: satisfying "no spawn sightline" is not the same as being safe once
 * an enemy can shoot round corners, and this fixture is a board that passes the direct
 * sightline rule and fails the banker rule.
 */
export const BANK_SIGHTLINE_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [{
      id: 'fixture-bank-sightline',
      cols: 7, rows: 7, cellSize: 2,
      legend: { '#': 'solid' },
      grid: ['.......', '.N.#.P.', '.......', '.......', '.......', '.......', '.......'],
      notes: ['Negative control: a stationary banker with a ricochet path onto the player spawn.'],
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
      grid: ['..B..', '.....', '.....', '.....', '..P..'],
      notes: ['Negative control: an enemy holding a straight line to the player spawn.'],
      claims: [],
    }],
  },
  'arena-fixtures.ts',
)[0];

/**
 * THE STANDARD BOARD (issue #1009): the board the sim's tests use when they want "a world with a
 * mixed enemy roster", and nothing about the first level.
 *
 * It carries campaign level 1's grid and roster as they stood when it was split off (`arena-01`
 * at commit c083f9c5): one brown, one grey, one teal and one player, on the 33x27 board. It used
 * to BE level 1 -- `createArenaWorld` built `ARENAS[0]` -- which coupled every suite that only
 * needed a mixed roster to the campaign's first level, so the ruling on #355 that re-authors
 * level 1's roster (#1010) would have moved them all. Now level 1 can change and this board
 * does not; a suite that is about level 1 itself reads the shipped `arena-01` instead.
 *
 * Test-only, like every board in this file: never in ARENAS, ARENA_DEFS, the versus catalog or
 * the campaign, and absent from the production bundle, because nothing outside tests and tools
 * imports this module (#1009 checked that once by searching the built `dist` for its id; no test
 * re-checks it). It runs through the same validator as the shipped file, so it cannot rot into
 * something the real pipeline would reject.
 */
export const STANDARD_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [
      {
        id: 'fixture-standard',
        cols: 33, rows: 27, cellSize: 2 / 3,
        legend: { '#': 'solid', x: 'destructible' },
        grid: [
          '.................................',
          '.................................',
          '.................................',
          '......###...............###......',
          '......###...............###......',
          '......###...............###......',
          '......###...............###......',
          '......###....B.....G....###......',
          '......###...............###......',
          '.................................',
          '................T................',
          '.................................',
          '......xxx......###......xxx......',
          '......xxx......###......xxx......',
          '......xxx......###......xxx......',
          '...............###......###......',
          '...............###......###......',
          '...............###......###......',
          '......###...............###......',
          '......###...............###......',
          '......###...............###......',
          '......###...............###......',
          '......###.......P.......###......',
          '......###...............###......',
          '.................................',
          '.................................',
          '.................................',
        ],
        notes: [
          'The standard test board (issue #1009): arena-01 as it stood at c083f9c5, one brown, ' +
            'one grey, one teal and one player, kept so that re-authoring level 1 moves no suite ' +
            'that only needed a mixed roster.',
        ],
        claims: [],
      },
    ],
  },
  'arena-fixtures.ts',
)[0];

/**
 * A playing world on the standard board. Tests, including the pacifist suite's headline metric,
 * rely on its mixed roster -- brown, grey and teal against one player -- and NOT on it being any
 * particular campaign level: it was level 1 until #1009 split the two apart.
 */
export function createArenaWorld(seed?: number, unarmedTrigger?: UnarmedTrigger): World {
  return createWorldFor(STANDARD_ARENA, seed, { rules: { unarmedTrigger } });
}
