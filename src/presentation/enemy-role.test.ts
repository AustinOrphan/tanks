import { describe, it, expect } from 'vitest';
import {
  ENEMY_ROLE_CUES, isEnemyRoleCue, weaponLever, mineLever,
  weaponShapeFor, mineShapeFor,
} from './enemy-role';
import { configFor } from '../sim/config';
import { TANK_KINDS } from '../sim/config/validate';

const ENEMIES = TANK_KINDS.filter((k) => k !== 'player');

describe('enemy role cues: the vocabulary', () => {
  it('accepts exactly the named cues and nothing else', () => {
    for (const cue of ENEMY_ROLE_CUES) expect(isEnemyRoleCue(cue)).toBe(true);
    // `none`, `off` and `hue` are the near-misses that matter: they all name the SHIPPED
    // board, and naming the default is not a way to select it.
    for (const v of ['', 'none', 'off', 'hue', 'BARREL', 'barrels', 'mines']) {
      expect(isEnemyRoleCue(v), v).toBe(false);
    }
    expect(isEnemyRoleCue(null)).toBe(false);
    expect(isEnemyRoleCue(undefined)).toBe(false);
  });

  it('routes each cue to exactly one lever, and `both` to one of each', () => {
    // Every cue names ONE treatment, so the comparison is between treatments rather than
    // between bundles -- the point of the prototype is to tell them apart.
    for (const cue of ENEMY_ROLE_CUES) {
      const levers = [weaponLever(cue), mineLever(cue)].filter(Boolean);
      expect(levers.length, `${cue} pulls ${levers.length} levers`).toBe(cue === 'both' ? 2 : 1);
    }
    expect(weaponLever('both')).toBe('girth');
    expect(mineLever('both')).toBe('deck');
    // Absent is the shipped board: hue alone, nothing drawn.
    expect([weaponLever(null), mineLever(null)]).toEqual([null, null]);
  });

  it('leaves the shipped tank untouched when no cue is chosen', () => {
    // The property every arm rests on: an unpulled lever is the ABSENCE of a multiplier, so
    // `tankParts({})` is the shipped model exactly.
    expect(weaponShapeFor(null, 'normal')).toEqual({});
    expect(mineShapeFor(null, 2)).toEqual({});
  });
});

describe('enemy role cues: the mapping is the number the player needs', () => {
  it('orders EVERY weapon lever by the bounce budget -- population: all 3 levers x 3 types', () => {
    // A COUNT was tried first and measured out: at the shipped camera a hull is 89px near the
    // viewer and about 40px far, so the barrel is 20-44px and a collar 2-4px -- not countable
    // at any boldness that keeps the toy-tank silhouette. Every lever here changes a whole
    // feature instead, and all three carry the same three states so they can be compared
    // against each other rather than against different claims.
    for (const lever of ['girth', 'flare', 'dome'] as const) {
      const v = (t: 'fast' | 'normal' | 'ricochet') =>
        Object.values(weaponShapeFor(lever, t))[0] as number;
      expect(v('fast'), `${lever}: fast`).toBeLessThan(v('normal'));
      expect(v('normal'), `${lever}: normal`).toBeLessThan(v('ricochet'));
      // The standard shell is the SHIPPED tank, so its arm must not move a pixel.
      expect(v('normal'), `${lever} moves the shipped tank`).toBe(1);
    }
  });

  it('agrees with the ROSTER rather than restating it -- every enemy, collars vs ricochetCount', () => {
    // The guard that makes "derived, not keyed on kind" mean something. If a tank is re-armed
    // in tank-defs.json, its collars have to move with it; a mapping that agreed only today
    // would be a second source of truth waiting to drift.
    for (const kind of ENEMIES) {
      const weapon = configFor(kind).weapon;
      const girth = weaponShapeFor('girth', weapon.bulletType).barrelGirth as number;
      // Ordered BY the bounce count, which is the claim -- a fatter gun throws a shell that
      // comes back more often. Pinned as an ordering rather than a table so re-arming a tank
      // moves its barrel with it.
      expect(girth > 1, `${kind} bounces ${weapon.ricochetCount}`).toBe(weapon.ricochetCount > 1);
      expect(girth < 1, `${kind} bounces ${weapon.ricochetCount}`).toBe(weapon.ricochetCount < 1);
    }
  });

  it('reads mine load in three states, which is the whole shipped population', () => {
    const bar = (n: number) => mineShapeFor('deck', n).deckBar as number;
    expect(bar(0)).toBe(0);
    expect(bar(2)).toBeGreaterThan(0);
    expect(bar(4)).toBeGreaterThan(bar(2));
    // AREA, not a count, and the WIDTH is what varies: the deck bar sits in the strip ahead
    // of the turret, which is shallow but 0.875 wide, so width is the axis with pixels to
    // spend. Four stripes would be four lines a couple of pixels apart -- a texture, not a
    // number.
    const shipped = new Set(ENEMIES.map((k) => configFor(k).mineCapacity));
    expect([...shipped].sort((a, b) => a - b), 'the shipped mine capacities').toEqual([0, 2, 4]);
  });
});

describe('enemy role cues: what the grammar can and cannot separate (issue #357)', () => {
  const signature = (kind: (typeof ENEMIES)[number]) => {
    const c = configFor(kind);
    return `${weaponShapeFor('girth', c.weapon.bulletType).barrelGirth}`
      + `|${mineShapeFor('deck', c.mineCapacity).deckBar}`;
  };

  it('separates the roster into FOUR groups, not six -- and that is the ceiling, not a bug', () => {
    // The finding this whole vocabulary is shaped by. Grouping the roster by anything a STILL
    // FRAME can encode does not reach six: brown and grey carry the same projectile, the same
    // bounce count and the same mine load, and so do teal and green. They differ only in
    // movement speed, rotation speed, fire rate and AI behaviour -- every one of them temporal.
    //
    // Asserted as a POPULATION so the claim cannot rot quietly: if a future roster change makes
    // one of those pairs differ in something showable, this fails and the ceiling is wrong.
    const groups = new Map<string, string[]>();
    for (const kind of ENEMIES) {
      const sig = signature(kind);
      groups.set(sig, [...(groups.get(sig) ?? []), kind]);
    }
    expect(groups.size, 'the number of visually separable groups').toBe(4);

    const collided = [...groups.values()].filter((ks) => ks.length > 1).map((ks) => ks.sort());
    expect(collided.sort(), 'the pairs a static cue cannot separate').toEqual([
      ['brown', 'grey'],
      ['green', 'teal'],
    ]);
  });

  it('gives the two unique kinds signatures nothing else shares', () => {
    // Olive is the only zero-bounce rocket and the only kind that lays no mines; yellow is the
    // only one carrying four. They are what the grammar buys over hue alone, so they are pinned
    // by name rather than left to the count above.
    expect(signature('olive'), 'olive is no longer unique').toBe('0.78|0');
    expect(signature('yellow'), 'yellow is no longer unique').toBe('1|0.62');
    for (const other of ENEMIES.filter((k) => k !== 'olive' && k !== 'yellow')) {
      expect(signature(other), `${other} collides with a unique kind`).not.toBe('0.78|0');
      expect(signature(other), `${other} collides with a unique kind`).not.toBe('1|0.62');
    }
  });
});
