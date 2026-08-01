import { describe, it, expect } from 'vitest';
import { claimFailures, renderBoard, structuralFailures } from './arena-claims';
import { arenaById } from './config/arenas';
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

describe('structuralFailures covers the universal rules', () => {
  it('reports nothing for a shipped arena', () => {
    // The control: without it, a function that returned failures for EVERYTHING
    // would also satisfy the negative controls in Task 5.
    expect(structuralFailures(A03)).toEqual([]);
  });
});

describe('renderBoard', () => {
  it('marks the requested cells and preserves the grid otherwise', () => {
    const board = renderBoard(A03, [[1, 1]]);
    const lines = board.trim().split('\n');
    expect(lines).toHaveLength(A03.rows);
    expect(lines[1][1]).toBe('*');
    expect(lines[7]).toContain('P'); // untouched rows still read as the grid
  });
});
