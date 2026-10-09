import { describe, expect, it } from 'vitest';
import { arenaById } from '../../src/sim/arena';
import { VERSUS_CATALOG } from '../../src/sim/config/versus-catalog';
import { measureBoard } from './measure';
import {
  SPREAD_TOLERANCE,
  THREE_PLAYER_SPREAD_CEILING,
  ceilingFor,
  passesSpreadGate,
} from './spread-gate.mjs';

/**
 * Issue #820's gate. The predicate is tested on plain measure objects set well clear of the
 * ceiling on both sides -- a fixture at the ceiling's own two-decimal figure is a knife edge on
 * unrounded values -- and the ceiling is recomputed from the shipped boards by the ruled rule.
 */
const m = (pathSpread: number, over: { spawnPairs?: number; unreachablePairs?: number } = {}) => ({
  spawnPairs: 3, unreachablePairs: 0, pathSpread, ...over,
});

describe('the 3-player spread gate (issue #820)', () => {
  it('passes a 3-player board well inside the ceiling and refuses one well outside it', () => {
    expect(passesSpreadGate(m(0.2), 3)).toBe(true);
    expect(passesSpreadGate(m(1.5), 3)).toBe(false);
  });

  it('refuses a 3-player board whose three pairs were not all measured', () => {
    // A pair with no path contributes nothing to `pathSpread`, so a low spread over two pairs
    // says nothing about the third. Controls: the same spread with all three pairs passes.
    expect(passesSpreadGate(m(0.2, { spawnPairs: 2 }), 3)).toBe(false);
    expect(passesSpreadGate(m(0.2, { unreachablePairs: 1 }), 3)).toBe(false);
    expect(passesSpreadGate(m(0.2), 3)).toBe(true);
  });

  it('passes any other player count without reading pathSpread', () => {
    const unreadable = {
      spawnPairs: 6,
      unreachablePairs: 0,
      get pathSpread(): number { throw new Error('pathSpread was read'); },
    };
    for (const n of [2, 4]) expect(passesSpreadGate(unreadable, n), `N=${n}`).toBe(true);
    // The control: at three players the same object IS read.
    expect(() => passesSpreadGate({ ...unreadable, spawnPairs: 3 }, 3)).toThrow('pathSpread was read');
    // And a spread far over the ceiling passes at 4, where no ruling gates.
    expect(passesSpreadGate(m(1.5, { spawnPairs: 6 }), 4)).toBe(true);
  });

  it('holds its tolerance at float noise on either side of the ceiling', () => {
    expect(passesSpreadGate(m(THREE_PLAYER_SPREAD_CEILING + SPREAD_TOLERANCE / 2), 3)).toBe(true);
    expect(passesSpreadGate(m(THREE_PLAYER_SPREAD_CEILING + 1e-6), 3)).toBe(false);
    expect(ceilingFor(0.7500000000000001)).toBe(0.75);
    expect(ceilingFor(0.7512)).toBe(0.76);
  });

  it('derives its ceiling from the boards offered at three players, and passes every one of them', () => {
    // Computed by the rule rather than pinned per board: a board that raises the N=3 maximum
    // fails here and forces a recorded decision instead of moving the bound silently.
    const offered = VERSUS_CATALOG.filter((e) => e.players.includes(3));
    expect(offered.length, 'no board is offered at three players').toBeGreaterThan(0);
    const measured = offered.map((e) => ({ id: e.arenaId, m: measureBoard(arenaById(e.arenaId), 3, e.arenaId) }));
    for (const { id, m: measures } of measured) {
      expect(passesSpreadGate(measures, 3), `${id} (pathSpread ${measures.pathSpread}) is refused by the gate`).toBe(true);
    }
    const max = measured.reduce((a, b) => (b.m.pathSpread > a.m.pathSpread ? b : a));
    expect(
      THREE_PLAYER_SPREAD_CEILING,
      `the ceiling no longer matches its rule: ${max.id} defines the N=3 maximum at ${max.m.pathSpread}`,
    ).toBe(ceilingFor(max.m.pathSpread));
  });
});
