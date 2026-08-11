// Structural validation for EVERY shipped arena, present and future. Each rule here is
// one a hand-drawn grid can silently break: a sealed pocket looks fine in ASCII, and a
// spawn sightline is invisible until a player dies to it three seconds into a level.
// New arenas added to ARENAS get all of this for free -- that is the point of the file.
import { describe, it, expect } from 'vitest';
import { bankShot, lineOfSight } from './ai/targeting';
import { ARENAS, ARENA_01, loadArena, arenaBounds } from './arena';
import { structuralFailures, claimFailures, cellCentre, cellOf, breach } from './arena-claims';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { configFor } from './config';
import { WIDE_ARENA, SEALED_POCKET_ARENA, OPEN_SIGHTLINE_ARENA, BANK_SIGHTLINE_ARENA } from './config/arena-fixtures';
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
  'arena-05': { spawnBlockRobust: 1 },
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
  // per universal rule (population: all three geometry rules -- sealed pocket, spawn
  // sightline, and the stationary-banker spawn rule below; the spawn-count rule is
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
  // counting them changes arena-04 to 311 of 1386 (the ranking is unaffected, but the
  // quoted numbers are the excluding ones and the note now says so).
  //
  // These counts are all population, not just denominators: every open cell of every
  // shipped arena's 33x27 (45x33 for arena-04) grid is walked, so `open` moved to ~9x
  // its old value across the board. `unseen` moved by roughly the same factor but not
  // exactly -- it is resampled at 9x the point density (cell centres, not a continuous
  // area), which measures the same underlying unseen region more finely rather than a
  // region that changed shape. Subsampling the new grid at exactly the points that map
  // back to the old cell centres (k -> 3k+1 on both axes) reproduces the old counts
  // (35/86, 41/83, 30/88, 35/151) exactly, confirming the geometry itself did not move.
  const EXPECTED: Record<string, { unseen: number; open: number }> = {
    'arena-01': { unseen: 288, open: 774 },
    'arena-02': { unseen: 369, open: 747 },
    'arena-03': { unseen: 248, open: 792 },
    'arena-04': { unseen: 284, open: 1359 },
    'arena-05': { unseen: 185, open: 1359 },
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

    // The notes' actual claims are comparative. Pinned as an ordering, not just five
    // independent counts: a grid edit that made arena-04 roomier than arena-03 would
    // satisfy every count above if they were updated to match, and still falsify the
    // sentence. arena-05 is now the tightest of the five (its own notes explain why --
    // a staggered wall gives its enemies more overlapping sightline than arena-04's one
    // continuous wall); arena-04's notes are corrected to say "tightest of the four that
    // existed when written" rather than claim a property arena-05 removes.
    const tightest = Object.entries(ratio).sort((a, b) => a[1] - b[1])[0][0];
    expect(tightest).toBe('arena-05');
    expect(ratio['arena-05']).toBeLessThan(ratio['arena-04']);
    expect(ratio['arena-04']).toBeLessThan(ratio['arena-03']);
  });
});

describe('the STATIONARY-banker spawn rule, which green is the reason for', () => {
  // One geometry, three kinds. The board is identical in all three -- green at (1, 1),
  // player at (5, 1), a solid at (3, 1) killing the direct line, boundary ring available
  // to bounce off -- so the ONLY variable is which enemy stands there. That is what makes
  // each gate's control meaningful rather than three unrelated boards.
  const at = (letter: string) => ({
    ...BANK_SIGHTLINE_ARENA,
    grid: BANK_SIGHTLINE_ARENA.grid.map((row) => row.replace('N', letter)),
  });

  it('reports a stationary banker that can ricochet onto the player spawn', () => {
    const failures = structuralFailures(BANK_SIGHTLINE_ARENA);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/spawn BANK line: green/);
    // Isolation: this fixture must exercise the BANK rule specifically. If the solid at
    // (3, 1) ever stopped blocking, the direct rule would fire and this fixture would be
    // re-testing what OPEN_SIGHTLINE_ARENA already covers while looking like it passed.
    expect(failures[0]).not.toMatch(/spawn sightline/);
  });

  it('does NOT report a MOBILE banker on the same board', () => {
    // The behaviour gate. Teal banks (weight 0.15) and would trip a rule that only
    // checked the weight -- as an earlier draft of this rule did, which failed shipped
    // arena-01 (grey at (13, 5) off 1 wall, teal at (11, 7) off 2) and arena-04. A tank
    // that drives away at tick 1 does not hold the line the rule is about.
    expect(structuralFailures(at('T'))).toEqual([]);
  });

  it('does NOT report a stationary NON-banker on the same board', () => {
    // The weight gate. Brown is stationary and its shell ricochets (ricochetCount 1),
    // so only its bankShotWeight of 0 keeps it quiet here -- which is exactly the gate
    // that makes brown's behaviour unchanged by the bank work in brown.ts.
    expect(structuralFailures(at('B'))).toEqual([]);
  });
});

describe("green's bank reach, which is why it is in level 4", () => {
  // arena-04's notes claim the sniper "answers the board's own weakness": 284 of the
  // 1359 open cells are seen by no enemy from its spawn, and green's ricochets cover
  // 171 of those 284. Prose next to a grid anyone may edit, so it is recomputed here.
  it('reaches 275 cells by ricochet it cannot see, covering 171 of the 284 nothing else sees', () => {
    const arena = arenaById('arena-04');
    const { walls, spawns } = loadArena(arena);
    const green = spawns.find((s) => s.kind === 'green');
    expect(green, 'arena-04 must still contain the green sniper').toBeDefined();
    const cfg = configFor('green');
    // Non-vacuity: if the profile stopped banking, every count below would go to zero
    // and "0 of 151" would still read as a number. Pin the premise they depend on.
    expect(cfg.ai.bankShotWeight).toBeGreaterThan(0);

    const enemies = spawns.filter((s) => s.kind !== 'player');
    const key = (c: number, r: number) => `${c},${r}`;
    const unseen = new Set<string>();
    const bankOnly: Array<[number, number]> = [];
    let open = 0;
    for (let r = 0; r < arena.rows; r++) {
      for (let c = 0; c < arena.cols; c++) {
        if (arena.legend[arena.grid[r][c]] !== undefined) continue;
        open++;
        const p = cellCentre(arena, [c, r]);
        if (!enemies.some((e) => lineOfSight(e.pos, p, walls))) unseen.add(key(c, r));
        if (lineOfSight(green!.pos, p, walls)) continue;
        if (bankShot(green!.pos, p, walls, cfg.weapon.ricochetCount) !== null) bankOnly.push([c, r]);
      }
    }
    expect({ bankOnly: bankOnly.length, open }).toEqual({ bankOnly: 275, open: 1359 });

    // The assertion that actually justifies the placement, and the reason it is an
    // OVERLAP rather than a count: 275 bank-only cells aimed at ground three other
    // enemies already cover would be worth nothing. What matters is how much of the
    // unseen region green alone can reach.
    const covered = bankOnly.filter(([c, r]) => unseen.has(key(c, r)));
    expect({ covered: covered.length, unseen: unseen.size }).toEqual({ covered: 171, unseen: 284 });
  });
});
