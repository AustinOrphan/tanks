import { describe, it, expect } from 'vitest';
import { claimFailures, renderBoard, structuralFailures, cellOf } from './arena-claims';
import { SEALED_POCKET_ARENA, OPEN_SIGHTLINE_ARENA } from './config/arena-fixtures';
import { arenaById } from './config/arenas';
import { ARENA_01, loadArena, type Arena } from './arena';
import type { ArenaClaim } from './config/arena-types';

// A guard is worth what its own tests prove: the purity guard passed four of five
// known-bad probes before it got a meta-test. So every claim type is fed a
// deliberately FALSE claim here and must be reported as a failure. The TRUE
// counterpart of each is the control -- without it, a runner that reports
// everything as broken would also pass.
const A03 = arenaById('arena-03');

describe('claimFailures reports a false claim of each type', () => {
  it('sightlineAfterBreach: the true expectation passes, the inverted one fails', () => {
    // ARENA_03 opens NO spawn-to-spawn sightline when everything is breached.
    const truth: ArenaClaim = {
      type: 'sightlineAfterBreach', from: [1, 1], sees: false, why: 'measured',
    };
    const lie: ArenaClaim = { ...truth, sees: true };
    expect(claimFailures(A03, [truth])).toEqual([]);
    expect(claimFailures(A03, [lie])).toHaveLength(1);
    expect(claimFailures(A03, [lie])[0]).toMatch(/sightlineAfterBreach/);

    // [1,1] alone cannot tell breach() from a no-op: its line to the player reads
    // false under BOTH the intact and the breached wall sets, so a mutant that
    // checks `walls` instead of `breached` in the runner still passes every
    // assertion above. A cell whose reading actually CHANGES after breach is
    // needed. Measured (bare cell centres, `from` -> the player spawn, all 99
    // grid cells of arena-03): 9 of 99 read intact=false, breached=true --
    // [3,4], [7,4], [3,5], [4,5], [6,5], [7,5], [4,6], [5,6], [6,6]. [3,4] is
    // used below. These are hand-built inline fixtures for this meta-test, so
    // they bypass validateArenas' requirement that a real claim's `from` sit on
    // an enemy spawn -- do not "fix" this by moving the coordinate onto a spawn:
    // [1,1] above IS a real spawn (an olive), and it's exactly the
    // non-discriminating cell this second pair exists to avoid repeating.
    const truthBreach: ArenaClaim = {
      type: 'sightlineAfterBreach', from: [3, 4], sees: true,
      why: 'measured, discriminates breach() from a no-op (intact=false, breached=true)',
    };
    const lieBreach: ArenaClaim = { ...truthBreach, sees: false };
    expect(claimFailures(A03, [truthBreach])).toEqual([]);
    expect(claimFailures(A03, [lieBreach])).toHaveLength(1);
    expect(claimFailures(A03, [lieBreach])[0]).toMatch(/sightlineAfterBreach/);
  });

  it('lane: the true expectation passes, the inverted one fails', () => {
    // The olive's flank column: blocked while the shield stands, open once breached.
    const truth: ArenaClaim = {
      type: 'lane', from: [1, 1], to: [1, 7],
      intact: 'blocked', breached: 'open', why: 'measured',
    };
    const lie: ArenaClaim = { ...truth, intact: 'open' };
    expect(claimFailures(A03, [truth])).toEqual([]);
    expect(claimFailures(A03, [lie])).toHaveLength(1);
    expect(claimFailures(A03, [lie])[0]).toMatch(/intact/);
  });

  it('spawnBlockRobust: passes at the measured nudge, fails at an absurd one', () => {
    const truth: ArenaClaim = { type: 'spawnBlockRobust', nudge: 0.1, why: 'measured' };
    // Measured sweep (0.25 steps, 5-10 units): arena-03 has a dead zone at nudge
    // 5.75-7.0 where all four cardinal offsets happen to be blocked at once (one
    // lands exactly on the row-4 pillar's centre, one leaves the map through the
    // boundary ring, the other two are blocked by cover) -- not a real "still
    // robust" result, a coincidence of this arena's specific geometry. 8 sits on
    // a solid plateau (7.25 through >=10 all measured open) so it reliably
    // exercises the "absurd nudge defeats the block" case this test is for.
    const lie: ArenaClaim = { ...truth, nudge: 8 };
    expect(claimFailures(A03, [truth])).toEqual([]);
    expect(claimFailures(A03, [lie]).length).toBeGreaterThan(0);
  });

  it('quotes the claim\'s why and draws the board, so a failure says WHICH cell', () => {
    const lie: ArenaClaim = {
      type: 'lane', from: [1, 1], to: [1, 7],
      intact: 'open', breached: 'open', why: 'the shield is the trade',
    };
    const [failure] = claimFailures(A03, [lie]);
    expect(failure).toContain('the shield is the trade');
    expect(failure).toContain('*'); // the annotated board marks the claim's cells
  });

  it('an arena with no claims reports nothing', () => {
    expect(claimFailures(A03, [])).toEqual([]);
  });
});

// spawnBlockRobust's original (Task 3) implementation checked the INTACT wall set
// only. ARENA_03's own history is the reason that was wrong: its shipped defect
// (both browns' post-BREACH lines going tangent-only, fixed by the row-5
// chord-maker) is invisible to an intact-only check, and a claims migration built
// on that check silently lost the coverage the deleted bespoke test had. Fixed by
// checking BOTH wall phases and tagging each failure with which one it came from.
// These two fixtures are built to discriminate the phases from each other. Verified
// by mutating the runner both directions: the breached fixture survives removal of
// the intact phase (it never needed an (intact) tag to reach its expected count) but
// dies if the breached phase is removed; the intact fixture requires BOTH phases --
// it dies if either is removed, since its count only holds with both tags present.
// Neither mutates the shipped arenas.json; both are inline Arena literals so this
// meta-test can see geometry the shipped grids don't (and shouldn't) contain.
describe('spawnBlockRobust tags both wall phases, each tag independently provable', () => {
  it('breached-only defect: fails via (breached), passes via (intact) -- ARENA_03 minus its row-5 chord-maker', () => {
    // Row 5's only occupied cell (col 5) is SOLID, not destructible -- removing it
    // from the fixture (not breaching it; it can't be breached) reproduces the
    // pre-chord-maker geometry ARENA_03's notes describe: the row-4 pillar alone.
    // Intact, the row-6 peek ('x', destructible) still blocks outright, so the
    // nudge is robustly blocked. Breached, the peek is gone and only the pillar's
    // corner remains -- an exact tangency a 0.1-unit nudge opens.
    const fixture: Arena = {
      ...A03,
      grid: A03.grid.map((row, r) => (r === 5 ? '.'.repeat(row.length) : row)),
    };
    const failures = claimFailures(fixture, [
      { type: 'spawnBlockRobust', nudge: 0.1, why: 'discriminates the breached phase' },
    ]);
    // Population: 2 olives + 3 trio = 5 enemies x 4 cardinal offsets = 20 checks.
    // Measured: exactly 4 fail (brown at (9,5) and (13,5), 2 offsets each), all
    // tagged (breached). If the runner's breached-phase check were removed, this
    // becomes 0 and the length assertion dies; a runner that checked intact only
    // (Task 3's original) would report this arena as ROBUST, which is the bug.
    expect(failures).toHaveLength(4);
    expect(failures.every((f) => f.includes('spawnBlockRobust (breached)'))).toBe(true);
    expect(failures.some((f) => f.includes('spawnBlockRobust (intact)'))).toBe(false);
  });

  it('intact defect unaffected by breach: fails via BOTH tags -- ARENA_01 minus its row-5 chord-maker', () => {
    // ARENA_01's row-5 chord-maker (col 5) is also solid, and nothing destructible
    // sits anywhere near it (ARENA_01's only destructibles are the far flank
    // shields at col 2 / col 8), so breaching changes nothing at this cell: intact
    // and breached geometry are IDENTICAL here. A defect at this spot must appear
    // under BOTH phases, tagged separately -- proving the intact loop runs at all
    // (a breached-only runner would still catch this given the codebase's
    // breach()-only-removes-walls semantics, but it could never produce an
    // (intact)-tagged message, which is what this asserts).
    const fixture: Arena = {
      ...ARENA_01,
      grid: ARENA_01.grid.map((row, r) =>
        r === 5 ? row.slice(0, 5) + '.' + row.slice(6) : row),
    };
    const failures = claimFailures(fixture, [
      { type: 'spawnBlockRobust', nudge: 0.1, why: 'discriminates the intact phase' },
    ]);
    // Population: 3 enemies (brown, grey, teal) x 4 offsets = 12 checks. Measured:
    // 8 fail (brown at (9,5), grey at (13,5), 2 offsets each), EACH duplicated as
    // an (intact) and a (breached) failure since the geometry doesn't move. If the
    // runner's intact-phase check were removed, the 4 (intact)-tagged messages
    // vanish, length drops to 4, and this assertion dies.
    expect(failures).toHaveLength(8);
    expect(failures.some((f) => f.includes('spawnBlockRobust (intact)'))).toBe(true);
    expect(failures.some((f) => f.includes('spawnBlockRobust (breached)'))).toBe(true);
  });
});

describe('structuralFailures covers the universal rules', () => {
  it('reports nothing for a shipped arena', () => {
    // The control: without it, a function that returned failures for EVERYTHING
    // would also satisfy the negative controls in Task 5.
    expect(structuralFailures(A03)).toEqual([]);
  });
});

describe('renderBoard', () => {
  it('marks the requested cells and preserves the grid otherwise', () => {
    // [3, 1] is deliberately OFF the diagonal: a mark at [1, 1] cannot tell a
    // correct rows[r][c] write from a transposed rows[c][r] one, since row and
    // col are interchangeable there. Coordinate order is [col, row] throughout
    // ArenaClaim (see arena-types.ts), matching loadArena's (c, r) grid walk.
    const board = renderBoard(A03, [[3, 1]]);
    const lines = board.trim().split('\n');
    expect(lines).toHaveLength(A03.rows);
    expect(lines[1][3]).toBe('*'); // row 1, col 3 -- the marked cell
    expect(lines[3][1]).toBe('.'); // row 3, col 1 -- untouched; a transposed write lands here instead
    expect(lines[7]).toContain('P'); // untouched rows still read as the grid
  });
});

// The marking behaviour itself, which nothing asserted before: review found the
// sealed-pocket board marking the ENTIRE play area as cut off (its flood fill
// started at the first breachable cell in scan order, which on that fixture IS
// the sealed cell) while leaving the real pocket blank. Nothing caught it because
// no test read board content -- only that a failure string existed.
describe('failure boards point at the thing that failed', () => {
  it('the sealed-pocket board marks the CUT-OFF cell, not the play area', () => {
    const [failure] = structuralFailures(SEALED_POCKET_ARENA);
    const board = failure.split('\n').slice(1);
    // The fixture's pocket is the B at [0,0]; everything else is the reachable half.
    expect(board[0][0]).toBe('*');
    expect(failure).toMatch(/1 cut off/);
    // The play area must NOT be marked -- this is the regression under guard.
    expect(board[3]).not.toContain('*'); // the player's row
    expect(board.join('').split('*')).toHaveLength(2); // exactly one mark
  });

  it('a spawn-sightline board marks E at the enemy and P at the player', () => {
    // POSITIONAL, not merely present: re-review noted that asserting `toContain('E')`
    // and `toContain('P')` cannot catch the two glyphs being swapped, because this
    // fixture's grid already holds a literal 'P' at the player's own cell whatever
    // the marking does. Assert the cells.
    const [failure] = structuralFailures(OPEN_SIGHTLINE_ARENA);
    const board = failure.split('\n').slice(1);
    const { spawns } = loadArena(OPEN_SIGHTLINE_ARENA);
    const enemy = spawns.find((sp) => sp.kind !== 'player')!;
    const player = spawns.find((sp) => sp.kind === 'player')!;
    const [ec, er] = cellOf(OPEN_SIGHTLINE_ARENA, enemy.pos);
    const [pc, pr] = cellOf(OPEN_SIGHTLINE_ARENA, player.pos);
    expect(board[er][ec]).toBe('E');
    expect(board[pr][pc]).toBe('P');
  });

  it('an arena with no player spawn is diagnosed, not crashed on', () => {
    // reachable()'s flood fill anchors on the player; this exercises the fallback.
    // validateArenas would reject such an arena, but structuralFailures is called
    // on hand-built fixtures too, so the branch is real and was untested.
    const noPlayer: Arena = {
      cols: 5, rows: 3, cellSize: 2,
      legend: { '#': 'solid' },
      grid: ['B#...', '#....', '.....'],
    };
    const failures = structuralFailures(noPlayer);
    expect(() => structuralFailures(noPlayer)).not.toThrow();
    expect(failures).toContain('no player spawn');
  });

  it('renderBoard reports an out-of-grid mark instead of throwing', () => {
    // It runs on the failure path, so a raw TypeError here buries the failure it
    // was called to explain. Before this, `rows[r][c] = '*'` threw.
    const arena = arenaById('arena-01');
    expect(() => renderBoard(arena, [[99, 99]])).not.toThrow();
    const out = renderBoard(arena, [[99, 99], [1, 1]]);
    expect(out).toMatch(/not drawn -- outside the 11x9 grid: \[99, 99\]/);
    expect(out.split('\n')[1][1]).toBe('*'); // the in-range mark still drawn
  });

  it('renderBoard honours a per-mark glyph', () => {
    const arena = arenaById('arena-01');
    const out = renderBoard(arena, [[2, 3, 'E'], [4, 5]]);
    expect(out.split('\n')[3][2]).toBe('E');
    expect(out.split('\n')[5][4]).toBe('*'); // default when no glyph given
  });
});
