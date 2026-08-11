import { describe, it, expect } from 'vitest';
import {
  bulletConfig,
  DODGE_PATIENCE_TICKS,
  FIRE_COOLDOWN_TICKS,
  MINE_CAP,
  SHELL_CAP,
  TANK_SPEED,
  TANK_TURN_RATE,
  TICK_HZ,
} from '../constants';
import type { TankKind } from '../types';
import { configFor, hasAbility } from './roster';
import { AIBehavior, TankAbility } from './enums';

// The shipped kinds. `player` is included because the player is now resolved through
// the same pipeline (its weapon/movement/mine-capacity all come from configFor).
const KINDS: TankKind[] = ['player', 'brown', 'grey', 'teal', 'olive', 'green', 'yellow'];

// The colours the renderer shipped before this refactor (entities.ts TANK_COLORS, as
// 0x hex). config.color must reproduce them exactly, or the tanks change colour.
const SHIPPED_COLORS: Record<TankKind, string> = {
  player: '#3d7bd6',
  brown: '#8a5a2b',
  grey: '#8890a0',
  teal: '#2bb0a6',
  olive: '#7a8f3c', // new with the kind itself: no prior render literal to reproduce
  // Deliberately NOT the reference taxonomy's GREEN (#3D9A50). That is 11.0 deltaE76
  // from the player's own green swatch (#4fae52), and customization.test.ts requires
  // every swatch to clear every enemy identity by 20 -- an enemy the player can dress
  // up as is a legibility bug, not a palette preference. #0A6E42 is 32.9 from the
  // nearest of all ten shipped colours, so it leaves the palette's existing worst
  // pair (27.7, green swatch vs olive) as the minimum instead of becoming the new one.
  green: '#0A6E42',
  // The reference taxonomy's own YELLOW hex, reused as-is (issue #136): every one of
  // the ten shipped/paletted colours it was checked against (customization.test.ts's
  // deltaE floor of 20) clears it by at least 38, well clear of the 27.7 minimum pair.
  yellow: '#E7C928',
};

describe('game roster resolves to the shipped tunables (behaviour-preservation pins)', () => {
  // These pins are the whole safety argument for the refactor: the sim now reads
  // configFor(kind) where it used to read a global constant, so the resolved value
  // MUST equal that constant for every kind or behaviour shifts. Each assertion
  // fails if the roster/balance is authored with a different class or number.

  // The uniform era ended with the 2026-07-31 balance pass: Brown turns and fires
  // slowly, Teal creeps but fires fast. Pinned PER KIND now -- retuning the roster
  // means updating the entry here too, exactly the balance.json contract.
  it('movement speed: uniform TANK_SPEED except Teal, who creeps', () => {
    for (const k of ['player', 'brown', 'grey'] as const) {
      expect(configFor(k).movementSpeed).toBe(TANK_SPEED);
    }
    expect(configFor('teal').movementSpeed).toBeCloseTo(TANK_SPEED * 0.6, 9);
  });

  it('rotation speed: player and grey at TANK_TURN_RATE; brown and teal slow', () => {
    for (const k of ['player', 'grey'] as const) {
      expect(configFor(k).rotationSpeed).toBe(TANK_TURN_RATE);
    }
    for (const k of ['brown', 'teal'] as const) {
      expect(configFor(k).rotationSpeed).toBeCloseTo(TANK_TURN_RATE * 0.6, 9);
    }
  });

  it('fire cooldown: player and grey at FIRE_COOLDOWN_TICKS; brown slow, teal fast', () => {
    for (const k of ['player', 'grey'] as const) {
      expect(configFor(k).weapon.fireCooldown).toBe(FIRE_COOLDOWN_TICKS);
    }
    // Measured from the resolved FireRate enums on 2026-07-31: SLOW = 38 ticks
    // (~0.63s), FAST = 14 (~0.23s). Integers, because cooldowns are counted in ticks.
    expect(configFor('brown').weapon.fireCooldown).toBe(38);
    expect(configFor('teal').weapon.fireCooldown).toBe(14);
  });

  it('shell cap and mine capacity: SHELL_CAP/MINE_CAP everywhere except olive', () => {
    // DERIVED from KINDS with an explicit exception table, not a hand-written subset.
    // Review found green's mineCapacity unpinned: the old loop listed player/brown/
    // grey/teal by hand, olive was handled separately, and green fell through the gap
    // entirely -- changing it 2 -> 0 passed all 1218 tests. Written this way, a sixth
    // kind is pinned to the defaults the day it exists, or must declare itself an
    // exception here.
    const PER_TANK: Partial<Record<TankKind, { shells: number; mines: number }>> = {
      // Olive is the first kind with a genuinely PER-TANK cap: one rocket in flight at
      // a time (its whole rhythm -- a slow, telegraphed lance), and no mines at all.
      // Raising either is a gameplay change, not a tidy-up.
      olive: { shells: 1, mines: 0 },
      // Yellow's whole identity (issue #136): the dedicated mine layer, 2x MINE_CAP.
      // Shell cap stays the default -- it is not a shooting specialist.
      yellow: { shells: SHELL_CAP, mines: 4 },
    };
    for (const k of KINDS) {
      const want = PER_TANK[k] ?? { shells: SHELL_CAP, mines: MINE_CAP };
      expect(configFor(k).weapon.maxActiveProjectiles, k).toBe(want.shells);
      expect(configFor(k).mineCapacity, k).toBe(want.mines);
    }
  });

  it('projectile speed/bounces mirror the sim bulletConfig for the resolved bullet type', () => {
    for (const k of KINDS) {
      const w = configFor(k).weapon;
      expect(w.speed).toBe(bulletConfig[w.bulletType].speed);
      // ricochetCount is carried per-tank; it must equal the sim's per-BulletType
      // bounce table, or a tank's shells would bounce a different number of times
      // than the bullet system actually grants them.
      expect(w.ricochetCount).toBe(bulletConfig[w.bulletType].bounces);
    }
  });
});

describe('per-kind identity comes from config, not code branches', () => {
  it('teal fires ricochet; brown/grey/player fire normal shells', () => {
    expect(configFor('teal').weapon.bulletType).toBe('ricochet');
    expect(configFor('brown').weapon.bulletType).toBe('normal');
    expect(configFor('grey').weapon.bulletType).toBe('normal');
    expect(configFor('player').weapon.bulletType).toBe('normal');
  });

  it('MINE_LAYER is held by exactly the kinds that lay mines today (grey/teal/player, not brown)', () => {
    expect(hasAbility('brown', TankAbility.MINE_LAYER)).toBe(false);
    expect(hasAbility('grey', TankAbility.MINE_LAYER)).toBe(true);
    expect(hasAbility('teal', TankAbility.MINE_LAYER)).toBe(true);
    expect(hasAbility('player', TankAbility.MINE_LAYER)).toBe(true);
  });

  it('reproduces the shipped render colours exactly', () => {
    for (const k of KINDS) expect(configFor(k).color).toBe(SHIPPED_COLORS[k]);
  });

  it('routes each kind to its shipped behaviour class (decideAi dispatches on this)', () => {
    // Changing any of these re-routes the kind to a DIFFERENT decision function --
    // a gameplay change, so it must be a deliberate two-file edit (roster + here).
    expect(configFor('brown').behavior).toBe(AIBehavior.STATIONARY);
    expect(configFor('grey').behavior).toBe(AIBehavior.DEFENSIVE);
    expect(configFor('teal').behavior).toBe(AIBehavior.TACTICAL);
    expect(configFor('olive').behavior).toBe(AIBehavior.DEFENSIVE);
    expect(configFor('green').behavior).toBe(AIBehavior.STATIONARY);
  });

  it("grey's profile-derived dodge patience equals the tuned DODGE_PATIENCE_TICKS", () => {
    // greyDecision computes patience as (1 - ai.aggression) * TICK_HZ. This pin is
    // what makes retuning DEFENSIVE_BASIC.aggression a loud edit instead of a
    // silent difficulty change: 45 ticks was measured/tuned, not incidental.
    const derived = Math.round((1 - configFor('grey').ai.aggression) * TICK_HZ);
    expect(derived).toBe(DODGE_PATIENCE_TICKS);
  });

  it('mine inclination (minePlacementChance sign) matches who lays mines today', () => {
    // The decision functions propose mines only when the profile carries a positive
    // minePlacementChance; brown must stay inert on both this and the ability gate.
    expect(configFor('grey').ai.minePlacementChance ?? 0).toBeGreaterThan(0);
    expect(configFor('teal').ai.minePlacementChance ?? 0).toBeGreaterThan(0);
    expect(configFor('brown').ai.minePlacementChance ?? 0).toBe(0);
  });

  it("teal's profile keeps both shot types active (positive direct AND bank weights)", () => {
    // tryDirect/tryBank are gated on these signs; zeroing either would silently
    // delete a whole shot type from the shipped game.
    expect(configFor('teal').ai.directShotWeight).toBeGreaterThan(0);
    expect(configFor('teal').ai.bankShotWeight).toBeGreaterThan(0);
  });

  it("olive, the rocket debut: every stat the level-3 design depends on", () => {
    // The first kind added purely as data (PR: rocket tank + level 3). Each line
    // is a design decision: SLOW chassis (a deliberate, creeping siege tank),
    // SLOW fire but a 'fast' 12 u/s no-bounce rocket, one in flight at a time,
    // no mines, DEFENSIVE routing (grey's implementation drives it).
    const o = configFor('olive');
    expect(o.behavior).toBe(AIBehavior.DEFENSIVE);
    expect(o.weapon.bulletType).toBe('fast');
    expect(o.weapon.speed).toBe(bulletConfig.fast.speed);
    expect(o.weapon.ricochetCount).toBe(bulletConfig.fast.bounces);
    expect(o.movementSpeed).toBeCloseTo(TANK_SPEED * 0.6, 9);
    expect(o.rotationSpeed).toBeCloseTo(TANK_TURN_RATE * 0.6, 9);
    expect(o.weapon.fireCooldown).toBe(38); // SLOW, same tick count pinned for brown
    expect(hasAbility('olive', TankAbility.MINE_LAYER)).toBe(false);
    expect(o.ai.minePlacementChance ?? 0).toBe(0);
  });

  it("green, the ricochet sniper: every stat its level-4 placement depends on", () => {
    // Review found green shipped with NOTHING pinning its chassis or weapon: fireRate
    // SLOW->FAST, maxActiveProjectiles 5->1, mineCapacity 2->0 and rotationSpeed
    // SLOW->FAST could all be changed at once and 1164 tests still passed. Each line
    // below is a design decision the level-4 numbers were measured against.
    const g = configFor('green');
    expect(g.behavior).toBe(AIBehavior.STATIONARY);
    // The whole point of the kind: it is the only STATIONARY profile that banks, and
    // brown.ts gates its bank path on exactly this being > 0. At 0 green becomes a
    // brown with a different colour, and its 29-cell reach in arena-04 goes to zero.
    expect(g.ai.bankShotWeight).toBeGreaterThan(0);
    expect(g.ai.directShotWeight).toBeGreaterThan(0); // still takes the direct shot first
    // A ricochet shell, not a straight one -- bankShot is handed this bounce budget,
    // and arena-validation.test.ts's reach figures are computed with it.
    expect(g.weapon.bulletType).toBe('ricochet');
    expect(g.weapon.ricochetCount).toBe(bulletConfig.ricochet.bounces);
    expect(g.weapon.speed).toBe(bulletConfig.ricochet.speed);
    expect(g.weapon.fireCooldown).toBe(38); // SLOW: a sniper, not a machine gun
    expect(g.weapon.maxActiveProjectiles).toBe(SHELL_CAP);
    expect(g.rotationSpeed).toBeCloseTo(TANK_TURN_RATE * 0.6, 9); // SLOW turret traverse
    // Stationary and mineless, like brown: the north front keeps its character.
    expect(hasAbility('green', TankAbility.MINE_LAYER)).toBe(false);
    expect(g.ai.minePlacementChance ?? 0).toBe(0);
    // Descriptive, matching teal, the other banker. BANK_SHOT_AIM is documentation --
    // no gameplay code reads it (see the note on abilities in resolve.ts) -- but the
    // dedicated bank tank lacking the descriptor its lesser banker carries is wrong.
    expect(hasAbility('green', TankAbility.BANK_SHOT_AIM)).toBe(true);
  });

  it('yellow, the mine specialist debut (issue #136 -- data-only, reused MOBILE_MINE_LAYER)', () => {
    // The cheap case named in #136: a data-only kind reusing teal's shipped profile,
    // differing only in weapon and mine capacity. Each line below is the design decision
    // that distinguishes it from teal, or it is just teal with a different colour.
    const y = configFor('yellow');
    // TACTICAL -- routed to tealDecision by decideAi's switch, same as teal. Also the
    // load-bearing fact behind the structuralFailures spawn-safety rule: that rule only
    // binds STATIONARY bankers (arena-claims.ts), so a TACTICAL/mobile kind can never
    // trip it no matter its bankShotWeight -- and MOBILE_MINE_LAYER's is 0 anyway.
    expect(y.behavior).toBe(AIBehavior.TACTICAL);
    expect(y.behavior).not.toBe(AIBehavior.STATIONARY);
    // A plain shell, not teal's ricochet rocket -- yellow's identity is the mines, not
    // the shot.
    expect(y.weapon.bulletType).toBe('normal');
    expect(y.weapon.ricochetCount).toBe(bulletConfig.normal.bounces);
    expect(y.weapon.speed).toBe(bulletConfig.normal.speed);
    expect(y.weapon.fireCooldown).toBe(FIRE_COOLDOWN_TICKS); // MEDIUM, like player/grey
    expect(y.weapon.maxActiveProjectiles).toBe(SHELL_CAP);
    expect(y.movementSpeed).toBe(TANK_SPEED); // MEDIUM chassis, unlike teal's 0.6x creep
    expect(y.rotationSpeed).toBe(TANK_TURN_RATE); // MEDIUM turret, unlike teal's 0.6x
    // The whole point of the kind: double MINE_CAP, and the ability that makes the
    // mine-inclined profile legal (resolve.ts:69 refuses a mine-inclined profile without
    // this on the definition -- roster.ts loading at all is that check passing).
    expect(y.mineCapacity).toBe(4);
    expect(hasAbility('yellow', TankAbility.MINE_LAYER)).toBe(true);
    expect(y.ai.minePlacementChance ?? 0).toBeGreaterThan(0);
    // Reused profile, not a new one (#136's point: this is the free part). Same
    // MOBILE_MINE_LAYER numbers teal reads -- if this profile diverges from teal's, one
    // of the two kinds is silently reading the wrong table.
    expect(y.ai).toEqual(configFor('teal').ai);
  });

  it('parses to the exact 0xRRGGBB numbers the renderer used to hardcode', () => {
    // entities.ts renders `parseInt(configFor(kind).color.slice(1), 16)`. Pinning the
    // NUMBER (not just the string) locks the value THREE actually receives to the old
    // TANK_COLORS literals -- the one migrated value whose consumed form is otherwise
    // only asserted as a string. Mirrors the render expression exactly.
    const asNumber = (k: TankKind) => parseInt(configFor(k).color.slice(1), 16);
    expect(asNumber('player')).toBe(0x3d7bd6);
    expect(asNumber('brown')).toBe(0x8a5a2b);
    expect(asNumber('grey')).toBe(0x8890a0);
    expect(asNumber('teal')).toBe(0x2bb0a6);
  });
});
