import { describe, expect, it } from 'vitest';
import type { TankKind } from '../types';
import { SPAWN_LETTERS } from './arena-types';
import { arenaById } from './arenas';
import { CAMPAIGN_LEVELS } from './campaign';
import type { CampaignLevel } from './campaign-types';
import { firstAppearanceFor, type SpawnGrid } from './first-appearance';
import { TANK_KINDS } from './validate';
import arenasJson from './data/arenas.json';
import campaignJson from './data/campaign.json';

const ENEMIES = TANK_KINDS.filter((k) => k !== 'player');

/** Synthetic boards, keyed by id. `P` player, `B` brown, `G` grey, `T` teal, `O` olive, `#` wall. */
const BOARDS: Record<string, SpawnGrid> = {
  'only-brown': { grid: ['P.#', '.B.'] },
  'grey-and-teal': { grid: ['PG.', '#.T'] },
  'only-olive': { grid: ['P..', '..O'] },
};
const board = (id: string): SpawnGrid => {
  const found = BOARDS[id];
  if (!found) throw new Error(`no synthetic board ${id}`);
  return found;
};
const levels = (...arenaIds: string[]): CampaignLevel[] =>
  arenaIds.map((arenaId, i) => ({ id: `level-${i + 1}`, arenaId }));
const table = (ls: readonly CampaignLevel[], lookup: (id: string) => SpawnGrid, kinds: readonly TankKind[]) =>
  Object.fromEntries(kinds.map((k) => [k, firstAppearanceFor(ls, lookup, k)]));

describe('firstAppearanceFor (issue #777)', () => {
  it("matches a spawn-letter count of the shipped campaign's own arenas", () => {
    // Counted here from the raw JSON, level by level, rather than through the function under
    // test: the earliest position whose grid holds at least one cell SPAWN_LETTERS maps to the
    // kind. Six enemy kinds; at `main` when this was written, three first appear at level 1
    // and one appears in no level.
    const arenas = (arenasJson as { arenas: Array<{ id: string; grid: string[] }> }).arenas;
    const counted = Object.fromEntries(
      ENEMIES.map((kind) => {
        const at = (campaignJson as { levels: Array<{ arenaId: string }> }).levels.findIndex((level) => {
          const arena = arenas.find((a) => a.id === level.arenaId);
          return arena!.grid.some((row) => [...row].some((ch) => SPAWN_LETTERS[ch] === kind));
        });
        return [kind, at === -1 ? null : at + 1];
      }),
    );
    expect(table(CAMPAIGN_LEVELS, arenaById, ENEMIES)).toEqual(counted);
    // Non-vacuity: the shipped campaign reaches some kinds and not others, so both halves of
    // the contract are exercised against real data.
    expect(Object.values(counted).some((v) => v === null)).toBe(true);
    expect(Object.values(counted).some((v) => v !== null)).toBe(true);
  });

  it('follows the campaign order, so reordering the levels moves every answer with it', () => {
    const kinds: TankKind[] = ['brown', 'grey', 'teal', 'olive', 'green'];
    expect(table(levels('only-brown', 'grey-and-teal', 'only-olive'), board, kinds)).toEqual({
      brown: 1, grey: 2, teal: 2, olive: 3, green: null,
    });
    expect(table(levels('only-olive', 'grey-and-teal', 'only-brown'), board, kinds)).toEqual({
      brown: 3, grey: 2, teal: 2, olive: 1, green: null,
    });
  });

  it('orders by position in the level list, never by the level id', () => {
    const misleading: CampaignLevel[] = [
      { id: 'level-09', arenaId: 'only-olive' },
      { id: 'level-01', arenaId: 'only-brown' },
    ];
    expect(firstAppearanceFor(misleading, board, 'olive')).toBe(1);
    expect(firstAppearanceFor(misleading, board, 'brown')).toBe(2);
  });

  it('reads a cell through SPAWN_LETTERS, so green is N and a G is grey', () => {
    // A rule keyed on the kind's initial would read `G` as green. The shipped letters are not
    // initials for every kind: green is `N` because `G` was grey's first.
    const lookup = (id: string): SpawnGrid => ({ 'g-only': { grid: ['PG'] }, 'n-only': { grid: ['PN'] } })[id]!;
    expect(firstAppearanceFor(levels('g-only'), lookup, 'grey')).toBe(1);
    expect(firstAppearanceFor(levels('g-only'), lookup, 'green')).toBeNull();
    expect(firstAppearanceFor(levels('g-only', 'n-only'), lookup, 'green')).toBe(2);
  });

  it('answers 1 for the player, which every arena spawns, and null for an empty campaign', () => {
    expect(firstAppearanceFor(levels('only-olive', 'only-brown'), board, 'player')).toBe(1);
    expect(firstAppearanceFor([], board, 'brown')).toBeNull();
  });
});
