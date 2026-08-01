// Structural validation for EVERY shipped arena, present and future. Each rule here is
// one a hand-drawn grid can silently break: a sealed pocket looks fine in ASCII, and a
// spawn sightline is invisible until a player dies to it three seconds into a level.
// New arenas added to ARENAS get all of this for free -- that is the point of the file.
import { describe, it, expect } from 'vitest';
import { ARENAS, ARENA_01, loadArena, arenaBounds } from './arena';
import { structuralFailures, claimFailures } from './arena-claims';
import { ARENA_DEFS } from './config/arenas';
import { WIDE_ARENA, SEALED_POCKET_ARENA, OPEN_SIGHTLINE_ARENA } from './config/arena-fixtures';
import type { ArenaClaim } from './config/arena-types';

describe('the shipped arena sequence', () => {
  it('starts at ARENA_01, the arena the game has always shipped', () => {
    expect(ARENAS[0]).toBe(ARENA_01);
    expect(ARENAS.length).toBeGreaterThanOrEqual(2); // progression needs somewhere to go
  });

  describe.each(ARENAS.map((a, i) => ({ a, i })))('arena $i', ({ a }) => {
    it('loads, with exactly one player spawn and at least one enemy', () => {
      const { tanks, spawns } = loadArena(a);
      expect(spawns.filter((s) => s.kind === 'player')).toHaveLength(1);
      expect(tanks.filter((t) => t.kind !== 'player').length).toBeGreaterThanOrEqual(1);
    });

    it('obeys every universal structural rule', () => {
      expect(structuralFailures(a).join('\n')).toBe('');
    });
  });
});

// Design intent lives WITH the data now (config/data/arenas.json `claims`), verified
// here by one generic runner. The two hand-written describe blocks this replaces --
// ARENA_02's destructible trade and ARENA_03's flank lanes -- are re-expressed as
// claims, which is the migration's own proof: same properties, no bespoke geometry.
describe.each(ARENA_DEFS.map((a) => ({ id: a.id, arena: a })))('$id claims', ({ arena }) => {
  it('every declared design claim holds', () => {
    expect(claimFailures(arena, arena.claims).join('\n\n')).toBe('');
  });
});

// Per-arena claim inventory, read from the shipped data (config/data/arenas.json) as of
// this writing -- NOT a formula, deliberately. Claim mix is a design decision, not
// something derivable: ARENA_01 legitimately has zero sightline claims (it only claims
// spawnBlockRobust), and lanes are not one-per-enemy by definition (ARENA_03 has 2 lanes
// for 5 enemies). Pinning the exact table makes changing an arena's claims a deliberate
// two-file edit -- config/data/arenas.json AND this table -- the same contract
// constants.test.ts uses to pin each balance value individually rather than with a range.
const EXPECTED_CLAIMS: Record<string, Partial<Record<ArenaClaim['type'], number>>> = {
  'arena-01': { spawnBlockRobust: 1 },
  'arena-02': { sightlineAfterBreach: 4 },
  'arena-03': { lane: 2, sightlineAfterBreach: 5, spawnBlockRobust: 1 },
};

it('each shipped arena declares its claim inventory exactly, per this table', () => {
  // Replaces two guards that were each independently bypassable:
  //  - `claimed.length >= 2` (deleted): passed as long as ANY two arenas had ANY claims
  //    at all, so an arena could drop every claim of one type, or lose the `lane` pin
  //    entirely (the deleted bespoke block's `expect(lanes).toHaveLength(2)` was never
  //    re-pinned by anything else), without the count ever moving.
  //  - the enemy-count check (deleted): `if (sightlineClaims.length === 0) continue`
  //    let an arena exempt itself from its own population check by deleting every
  //    sightlineAfterBreach claim it had -- the exact silent-bypass hole this replaces.
  //
  // The table's key set is checked against the shipped arena ids first, so a new arena
  // cannot ship without declaring an inventory for review to compare against the design.
  expect(new Set(ARENA_DEFS.map((a) => a.id))).toEqual(new Set(Object.keys(EXPECTED_CLAIMS)));

  for (const arena of ARENA_DEFS) {
    const counts: Partial<Record<ArenaClaim['type'], number>> = {};
    for (const claim of arena.claims) counts[claim.type] = (counts[claim.type] ?? 0) + 1;
    expect(counts, arena.id).toEqual(EXPECTED_CLAIMS[arena.id]);
  }
});

it('a sightlineAfterBreach claim names every enemy CELL, not just the right count of them', () => {
  // Strictly stronger than the inventory table above: a claim's `from` moved from one
  // enemy's cell to another's keeps every count in EXPECTED_CLAIMS unchanged (same
  // arena, same claim type, same total), but changes WHICH enemy is actually covered.
  // Set equality (not cardinality) is what catches that.
  for (const arena of ARENA_DEFS) {
    const sightlineClaims = arena.claims.filter((c) => c.type === 'sightlineAfterBreach');
    if (sightlineClaims.length === 0) continue; // ARENA_01: no claims of this type to check
    const { spawns } = loadArena(arena);
    const cellOf = (x: number) => Math.round(x / arena.cellSize - 0.5); // inverse of loadArena's (c+0.5)*cellSize
    const enemyCells = new Set(
      spawns
        .filter((s) => s.kind !== 'player')
        .map((s) => `${cellOf(s.pos.x)},${cellOf(s.pos.y)}`),
    );
    const claimCells = new Set(sightlineClaims.map((c) => `${c.from[0]},${c.from[1]}`));
    expect(claimCells, arena.id).toEqual(enemyCells);
  }
});

describe('variable arena dimensions', () => {
  it('a 15x11 arena loads, validates, and is NOT the shipped size', () => {
    expect(WIDE_ARENA.cols).toBe(15);
    expect(WIDE_ARENA.rows).toBe(11);
    expect(arenaBounds(WIDE_ARENA)).toEqual({ width: 30, height: 22 });
    // The point of the fixture: it differs from every shipped arena.
    for (const a of ARENA_DEFS) expect(arenaBounds(a)).not.toEqual(arenaBounds(WIDE_ARENA));
  });

  it('the structural rules and the claim runner both handle it', () => {
    // structuralFailures, not the old local flood-fill helper: Task 3 extracted
    // and deleted that. Size-generic by construction -- it reads cols/rows off
    // the arena it is given.
    expect(structuralFailures(WIDE_ARENA)).toEqual([]);
    expect(claimFailures(WIDE_ARENA, WIDE_ARENA.claims)).toEqual([]);
  });

  it('loads into a world with the spawns its grid declares', () => {
    const { spawns } = loadArena(WIDE_ARENA);
    expect(spawns.filter((s) => s.kind === 'player')).toHaveLength(1);
    expect(spawns.filter((s) => s.kind !== 'player')).toHaveLength(2);
  });

  it('is never in the shipped sequence', () => {
    expect(ARENA_DEFS.map((a) => a.id)).not.toContain('fixture-wide');
  });
});

describe('the universal rules have negative controls', () => {
  // Without these, structuralFailures could return [] unconditionally and every
  // shipped arena would still look validated. The spec requires one bad fixture
  // per universal rule (population: both geometry rules; the spawn-count rule is
  // controlled at the validator level in validate.test.ts).
  it('a solid-sealed pocket is reported, and ONLY that rule', () => {
    // Length pinned at 1, not just [0]'s content: this fixture must isolate the
    // sealed-pocket rule, so a future edit that also opened a spawn sightline
    // would still need to be caught here, not hidden behind an index that only
    // ever reads the first (sealed-pocket-always-pushed-first) message.
    const failures = structuralFailures(SEALED_POCKET_ARENA);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/sealed pocket/);
  });

  it('an enemy with a straight line to the player spawn is reported, and ONLY that rule', () => {
    const failures = structuralFailures(OPEN_SIGHTLINE_ARENA);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/spawn sightline/);
  });
});
