// The PP1 role-first ordnance arm (issue #358).
import { describe, it, expect } from 'vitest';
import { PP1_ROLE_SHELL_CAPS, PP1_ROLE_BANDS } from './pp1-roles';
import { configFor, TANK_KINDS } from './roster';
import { loadArena } from '../arena';
import { ARENAS } from '../arena';

describe('the PP1 role matrix', () => {
  it('sits inside every band the issue authorised', () => {
    // The bands are the approved decision; the values are this arm's pick within them. A
    // value outside its band is a retune wearing an experiment's name, which is exactly what
    // the issue's "not permission to retune every tank in one PR" note forbids.
    for (const [kind, cap] of Object.entries(PP1_ROLE_SHELL_CAPS)) {
      const band = PP1_ROLE_BANDS[kind as never];
      expect(band, `${kind} has a cap but no authorised band`).toBeDefined();
      const [lo, hi] = band as readonly [number, number];
      expect(cap, `${kind} cap ${cap} is outside its band ${lo}-${hi}`).toBeGreaterThanOrEqual(lo);
      expect(cap).toBeLessThanOrEqual(hi);
    }
    // ...and both tables cover the same kinds, so a band cannot be added without a value or
    // a value without an approving band.
    expect(Object.keys(PP1_ROLE_SHELL_CAPS).sort()).toEqual(Object.keys(PP1_ROLE_BANDS).sort());
  });

  it('is LOWER than the shipped roster wherever it differs, which is the whole point', () => {
    // The decision is "lower, role-specific budgets". An arm that raised one would be
    // measuring something else, and would do it invisibly behind a flag.
    for (const [kind, cap] of Object.entries(PP1_ROLE_SHELL_CAPS)) {
      const shipped = configFor(kind as never).weapon.maxActiveProjectiles;
      expect(cap, `${kind} arm ${cap} exceeds its shipped ${shipped}`).toBeLessThanOrEqual(shipped);
    }
    // ...and it is not a no-op: five of the six differ today, which is the gap the issue
    // reports. Olive is the exception and the issue names it as the control.
    const changed = Object.entries(PP1_ROLE_SHELL_CAPS)
      .filter(([kind, cap]) => cap !== configFor(kind as never).weapon.maxActiveProjectiles);
    expect(changed.map(([k]) => k).sort()).toEqual(['brown', 'green', 'grey', 'player', 'teal']);
  });

  it('leaves yellow out, because PP1 does not contain it', () => {
    expect(PP1_ROLE_SHELL_CAPS.yellow, 'yellow was opted into an experiment it is outside').toBeUndefined();
    expect(TANK_KINDS, 'yellow is still a shipped kind, it is just not in this arm').toContain('yellow');
  });
});

describe('stamping the arm at spawn', () => {
  const arena = ARENAS[0];

  it('stamps nothing at all when the arm is off, which is every shipped session', () => {
    const { tanks } = loadArena(arena);
    expect(tanks.length).toBeGreaterThan(0);
    for (const t of tanks) {
      expect(t.shellCap, `${t.kind} carried a cap with the arm off`).toBeUndefined();
    }
  });

  it('stamps every tank the matrix names, and only those', () => {
    const { tanks } = loadArena(arena, 1, 'campaign-coop', undefined, undefined, undefined, true);
    for (const t of tanks) {
      expect(t.shellCap, `${t.kind} was not stamped`).toBe(PP1_ROLE_SHELL_CAPS[t.kind]);
    }
    // The arena must actually contain a kind the matrix lowers, or this asserts nothing.
    expect(tanks.some((t) => t.shellCap !== undefined && t.shellCap < 5)).toBe(true);
  });

  it('stamps CO-PLAYERS too, not just the tanks one spawn pass builds', () => {
    // There are three spawn sites in arena.ts -- the grid loop, the co-op placer and the
    // versus branch -- and stamping at each is how one gets missed. A co-player carrying the
    // roster's 5 while P1 carried the arm's 4 would be an experiment measuring two rosters.
    const { tanks } = loadArena(arena, 3, 'campaign-coop', undefined, undefined, undefined, true);
    const players = tanks.filter((t) => t.kind === 'player');
    expect(players.length, 'the fixture built no co-players').toBe(3);
    for (const p of players) expect(p.shellCap).toBe(PP1_ROLE_SHELL_CAPS.player);
  });
});
