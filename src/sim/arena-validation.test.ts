// Structural validation for EVERY shipped arena, present and future. Each rule here is
// one a hand-drawn grid can silently break: a sealed pocket looks fine in ASCII, and a
// spawn sightline is invisible until a player dies to it three seconds into a level.
// New arenas added to ARENAS get all of this for free -- that is the point of the file.
import { describe, it, expect } from 'vitest';
import { lineOfSight } from './ai/targeting';
import { ARENAS, ARENA_01, loadArena, arenaBounds } from './arena';
import { structuralFailures, claimFailures, cellCentre, cellOf, breach } from './arena-claims';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { WIDE_ARENA, SEALED_POCKET_ARENA, OPEN_SIGHTLINE_ARENA } from './config/arena-fixtures';
import type { ArenaClaim } from './config/arena-types';

describe('the shipped arena sequence', () => {
  it('starts at ARENA_01, the arena the game has always shipped', () => {
    expect(ARENAS[0]).toBe(ARENA_01);
    expect(ARENAS.length).toBeGreaterThanOrEqual(2); // progression needs somewhere to go
  });

});

// ONE parametrised block over ARENA_DEFS, not two under two names for the same
// array object (`arena.ts`'s ARENAS and `config/arenas.ts`'s ARENA_DEFS are the
// same reference -- a reader hunting for the difference finds none).
//
// Design intent lives WITH the data now (config/data/arenas.json `claims`),
// verified by one generic runner. The two hand-written describe blocks this
// replaces -- ARENA_02's destructible trade and ARENA_03's flank lanes -- are
// re-expressed as claims: same properties, no bespoke geometry.
describe.each(ARENA_DEFS.map((a) => ({ id: a.id, arena: a })))('$id', ({ arena }) => {
  it('loads, with exactly one player spawn and at least one enemy', () => {
    const { tanks, spawns } = loadArena(arena);
    expect(spawns.filter((s) => s.kind === 'player')).toHaveLength(1);
    expect(tanks.filter((t) => t.kind !== 'player').length).toBeGreaterThanOrEqual(1);
  });

  it('obeys every universal structural rule', () => {
    expect(structuralFailures(arena).join('\n')).toBe('');
  });

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
  'arena-04': { lane: 7, sightlineAfterBreach: 6, spawnBlockRobust: 1 },
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
    // The SHARED inverse (arena-claims.ts), not a local copy: cell-mapping.test.ts
    // pins it against loadArena's placement, so this cannot drift on its own.
    const enemyCells = new Set(
      spawns
        .filter((s) => s.kind !== 'player')
        .map((s) => cellOf(arena, s.pos).join(',')),
    );
    const claimCells = new Set(sightlineClaims.map((c) => `${c.from[0]},${c.from[1]}`));
    expect(claimCells, arena.id).toEqual(enemyCells);
  }
});

describe('variable arena dimensions', () => {
  it('a 17x13 arena loads, validates, and is NOT any shipped size', () => {
    expect(WIDE_ARENA.cols).toBe(17);
    expect(WIDE_ARENA.rows).toBe(13);
    expect(arenaBounds(WIDE_ARENA)).toEqual({ width: 34, height: 26 });
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

describe("arena-02's spawnBlockRobust figures, which no claim can protect", () => {
  // arena-02 declares no `spawnBlockRobust` claim -- correctly: breaching its centre
  // barrier IS the level, so the property is false there by design. But the runner
  // only evaluates claims that are DECLARED, so the numbers documented in
  // arena-claims.ts and CLAUDE.md ("12 of 16 breached, 0 of 16 intact") were measured
  // by hand and nothing recomputed them. They would have rotted silently the first
  // time anyone edited that grid.
  //
  // This recomputes them. It is deliberately NOT a claim: making it one would assert
  // a property arena-02 does not have. A grid edit that changes these counts fails
  // here and forces the documented numbers to be updated with it.
  it('recomputes 0 of 16 intact and 12 of 16 breached', () => {
    const arena = arenaById('arena-02');
    const { walls, spawns } = loadArena(arena);
    const breached = breach(walls);
    const player = spawns.find((s) => s.kind === 'player')!;
    const enemies = spawns.filter((s) => s.kind !== 'player');
    const NUDGE = 0.1;
    const offsets = [
      { x: NUDGE, y: 0 }, { x: -NUDGE, y: 0 },
      { x: 0, y: NUDGE }, { x: 0, y: -NUDGE },
    ];

    const count = (w: typeof walls): number => {
      let seen = 0;
      for (const enemy of enemies) {
        for (const off of offsets) {
          const target = { x: player.pos.x + off.x, y: player.pos.y + off.y };
          if (lineOfSight(enemy.pos, target, w)) seen++;
        }
      }
      return seen;
    };

    // The denominator, stated: 4 enemy spawns x 4 cardinal nudges = 16 checks per
    // wall phase. Pinned so a fifth enemy cannot silently change what "of 16" means.
    expect(enemies).toHaveLength(4);
    expect(enemies.length * offsets.length).toBe(16);

    expect(count(walls)).toBe(0);       // intact: the barrier seals both halves
    expect(count(breached)).toBe(12);   // breached: the trade the level is built on
  });
});

describe('the cover ratio each arena quotes in its notes', () => {
  // arena-04's notes carry five numbers comparing all four boards on one probe: how
  // many open cells no enemy can see from its spawn, walls intact. Exactly the
  // situation the arena-02 block above exists for -- prose measured once by hand,
  // recomputed by nothing, sitting next to a grid anyone may edit. `notes` are
  // validated only as strings, so the validator cannot help.
  //
  // Destructible cells are NOT counted as open: they are walls until destroyed, and
  // counting them changes arena-04 to 46 of 154 (the ranking is unaffected, but the
  // quoted numbers are the excluding ones and the note now says so).
  const EXPECTED: Record<string, { unseen: number; open: number }> = {
    'arena-01': { unseen: 35, open: 86 },
    'arena-02': { unseen: 41, open: 83 },
    'arena-03': { unseen: 30, open: 88 },
    'arena-04': { unseen: 43, open: 151 },
  };

  it('recomputes every quoted count, and the ranking the note claims', () => {
    // Symmetric with EXPECTED_CLAIMS above: set equality both ways, so adding a
    // fifth arena cannot leave this table quietly covering four of five.
    expect(new Set(ARENA_DEFS.map((a) => a.id))).toEqual(new Set(Object.keys(EXPECTED)));

    const ratio: Record<string, number> = {};
    for (const arena of ARENA_DEFS) {
      const { walls, spawns } = loadArena(arena);
      const enemies = spawns.filter((s) => s.kind !== 'player');
      let open = 0;
      let unseen = 0;
      for (let r = 0; r < arena.rows; r++) {
        for (let c = 0; c < arena.cols; c++) {
          if (arena.legend[arena.grid[r][c]] !== undefined) continue; // a wall of any kind
          open++;
          const p = cellCentre(arena, [c, r]);
          if (!enemies.some((e) => lineOfSight(e.pos, p, walls))) unseen++;
        }
      }
      expect({ unseen, open }, arena.id).toEqual(EXPECTED[arena.id]);
      ratio[arena.id] = unseen / open;
    }

    // The note's actual claim is comparative -- "the tightest of the four". Pinned as
    // an ordering, not just four independent counts: a grid edit that made arena-04
    // roomier than arena-03 would satisfy every count above if they were updated to
    // match, and still falsify the sentence.
    const tightest = Object.entries(ratio).sort((a, b) => a[1] - b[1])[0][0];
    expect(tightest).toBe('arena-04');
    expect(ratio['arena-04']).toBeLessThan(ratio['arena-03']);
  });
});
