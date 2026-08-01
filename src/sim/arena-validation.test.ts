// Structural validation for EVERY shipped arena, present and future. Each rule here is
// one a hand-drawn grid can silently break: a sealed pocket looks fine in ASCII, and a
// spawn sightline is invisible until a player dies to it three seconds into a level.
// New arenas added to ARENAS get all of this for free -- that is the point of the file.
import { describe, it, expect } from 'vitest';
import { ARENAS, ARENA_01, loadArena } from './arena';
import { lineOfSight } from './ai/targeting';
import { structuralFailures } from './arena-claims';

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

describe("ARENA_02's destructible trade", () => {
  // The design comment claims blowing the bars' destructible ends opens the UPPER
  // pair's lanes and nothing else. The generic sightline test above cannot see WHAT
  // does the blocking -- it went green while the comment overclaimed the trade for
  // all four enemies. Measured here instead: this fails if a grid edit either opens
  // a lower lane (a solid outer end went missing) or seals an upper one (the trade
  // the level is built around stopped existing).
  it('opens exactly the two upper lanes when every destructible is gone', () => {
    const { walls, spawns } = loadArena(ARENAS[1]);
    for (const w of walls) if (w.kind === 'destructible') w.destroyed = true;
    const player = spawns.find((s) => s.kind === 'player')!;
    const open = spawns
      .filter((s) => s.kind !== 'player')
      .map((s) => ({ kind: s.kind, y: s.pos.y, sees: lineOfSight(s.pos, player.pos, walls) }));
    // Population: all 4 enemy spawns. Upper row (y = 5) opens; lower row (y = 7) stays shut.
    expect(open.filter((o) => o.y === 5).map((o) => o.sees)).toEqual([true, true]);
    expect(open.filter((o) => o.y === 7).map((o) => o.sees)).toEqual([false, false]);
    expect(open).toHaveLength(4);
  });
});

describe("ARENA_03's flank-lane trade", () => {
  // The design comment claims each olive's destructible shield is the ONLY wall on
  // its vertical flank column, and that breaching opens that lane end-to-end --
  // measured here with the sim's own lineOfSight, exactly as it was designed
  // (intact=false, breached=true on both flanks; see the arena comment). Also pins
  // the negative: breaching every destructible opens NO spawn-to-spawn sightline,
  // which is what distinguishes this level's trade from ARENA_02's.
  it('a breached shield opens its vertical lane, both flanks; intact blocks both', () => {
    const { walls, spawns } = loadArena(ARENAS[2]);
    // Lanes are DERIVED from the olive spawns (review: hardcoded coordinates keep
    // checking an empty cell if a spawn moves a row). The foot of each lane is the
    // same column at the player's row.
    const player = spawns.find((s) => s.kind === 'player')!;
    const lanes = spawns
      .filter((s) => s.kind === 'olive')
      .map((s) => ({ olive: s.pos, foot: { x: s.pos.x, y: player.pos.y } }));
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) {
      expect(lineOfSight(lane.olive, lane.foot, walls)).toBe(false);
    }
    for (const w of walls) if (w.kind === 'destructible') w.destroyed = true;
    for (const lane of lanes) {
      expect(lineOfSight(lane.olive, lane.foot, walls)).toBe(true);
    }
  });

  it('breaching everything still opens no spawn-to-spawn sightline (0 of 5 enemies)', () => {
    const { walls, spawns } = loadArena(ARENAS[2]);
    for (const w of walls) if (w.kind === 'destructible') w.destroyed = true;
    const player = spawns.find((s) => s.kind === 'player')!;
    const enemies = spawns.filter((s) => s.kind !== 'player');
    expect(enemies).toHaveLength(5); // 2 olive + 2 brown + 1 grey; the level-3 roster
    for (const s of enemies) {
      expect(lineOfSight(s.pos, player.pos, walls), `${s.kind} at (${s.pos.x},${s.pos.y})`).toBe(false);
    }
    // NOT a knife edge: review found that with row 4 alone, both browns' post-breach
    // lines were blocked only by an exact corner tangency (raySegmentVsAABB counts
    // tmin === tmax as a hit) that a 0.1-unit player nudge opened into a full lane.
    // The row-5 chord-maker fixes that; these probes pin the fix -- they FAIL on the
    // tangent-only geometry.
    for (const dx of [-0.1, 0.1]) {
      const nudged = { x: player.pos.x + dx, y: player.pos.y };
      for (const s of enemies) {
        expect(lineOfSight(s.pos, nudged, walls), `${s.kind} vs player nudged ${dx}`).toBe(false);
      }
    }
  });
});
