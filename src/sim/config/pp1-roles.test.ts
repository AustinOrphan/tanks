// The PP1 role-first ordnance arm (issue #358).
import { describe, it, expect } from 'vitest';
import { PP1_ROLE_SHELL_CAPS, PP1_ROLE_BANDS, PP1_ROLE_MINE_CAPS } from './pp1-roles';
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

describe("the arm's mine directions, as capacities (issue #358's second axis)", () => {
  it('zeroes exactly the three kinds the matrix says carry none, and each is a real change', () => {
    // The matrix's mine column: brown "none", teal "test without mines", green "none".
    for (const kind of ['brown', 'teal', 'green'] as const) {
      expect(PP1_ROLE_MINE_CAPS[kind], kind).toBe(0);
      // A control on the premise: if a kind ever ships at 0 already, this arm stops being an
      // experiment for it and the table is claiming a change it does not make.
      expect(configFor(kind).mineCapacity, `${kind} already ships at 0`).toBeGreaterThan(0);
    }
  });

  it('pins the two "matches" claims against the shipped roster, so a drift fails loudly', () => {
    // The matrix states a direction for these and records that shipped already satisfies it.
    // Asserting equality is what makes that a claim rather than a comment: if the roster's
    // player mine capacity moves, the arm silently stops being the approved matrix.
    expect(PP1_ROLE_MINE_CAPS.player).toBe(configFor('player').mineCapacity);
    expect(PP1_ROLE_MINE_CAPS.olive).toBe(configFor('olive').mineCapacity);
  });

  it('leaves grey out: its approved direction is a placement policy, not a capacity', () => {
    expect(PP1_ROLE_MINE_CAPS).not.toHaveProperty('grey');
    // ...and grey is still IN the shell arm, so absence here is a scoped exclusion rather
    // than grey having been forgotten by the experiment altogether.
    expect(PP1_ROLE_SHELL_CAPS.grey).toBeDefined();
  });

  it('never raises a capacity above the roster it overrides', () => {
    for (const [kind, cap] of Object.entries(PP1_ROLE_MINE_CAPS)) {
      expect(cap, kind).toBeLessThanOrEqual(configFor(kind as never).mineCapacity);
    }
  });

  it('stamps mine capacities at spawn, alongside the shell caps and only with the arm on', () => {
    // ARENAS[3], not [0]: it is the one campaign arena carrying ALL SIX PP1 kinds, so every
    // entry in both tables is exercised and the sweep below is over the whole matrix rather
    // than the three kinds arena 0 happens to spawn. Asserted, so a roster edit that drops a
    // kind from this arena fails here instead of quietly shrinking the population.
    const on = loadArena(ARENAS[3], 1, 'campaign-coop', 42, 3, undefined, true);
    const kinds = new Set(on.tanks.map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['brown', 'green', 'grey', 'olive', 'player', 'teal']);

    const off = loadArena(ARENAS[3], 1, 'campaign-coop', 42, 3, undefined, false);
    expect(off.tanks.every((t) => t.mineCap === undefined), 'no arm must mean no stamp').toBe(true);
    for (const tank of on.tanks) {
      expect(tank.mineCap, tank.kind).toBe(PP1_ROLE_MINE_CAPS[tank.kind]);
    }

    // Grey carries a shell cap and NO mine cap: the one kind where the two tables disagree,
    // and the case a single combined "ordnance" field could not have expressed. Unconditional
    // -- the population assertion above already proved this arena spawns one.
    const grey = on.tanks.find((t) => t.kind === 'grey');
    expect(grey?.shellCap).toBe(PP1_ROLE_SHELL_CAPS.grey);
    expect(grey?.mineCap, 'grey must keep its authored mine capacity').toBeUndefined();
  });
});
