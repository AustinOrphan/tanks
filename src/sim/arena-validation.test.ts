// Structural validation for EVERY shipped arena, present and future. Each rule here is
// one a hand-drawn grid can silently break: a sealed pocket looks fine in ASCII, and a
// spawn sightline is invisible until a player dies to it three seconds into a level.
// New arenas added to ARENAS get all of this for free -- that is the point of the file.
import { describe, it, expect } from 'vitest';
import { ARENAS, ARENA_01, loadArena } from './arena';
import { structuralFailures, claimFailures } from './arena-claims';
import { ARENA_DEFS } from './config/arenas';

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

it('the shipped arenas declare design claims, not just structure', () => {
  // Guards the migration itself: if a port dropped the claims, the runner above
  // would pass vacuously on empty arrays. Population: all 3 shipped arenas.
  const claimed = ARENA_DEFS.filter((a) => a.claims.length > 0);
  expect(claimed.length).toBeGreaterThanOrEqual(2); // arena-02 and arena-03 at minimum
});
