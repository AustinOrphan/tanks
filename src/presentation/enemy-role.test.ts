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
    // THE APPROVED ARM (issue #773): the muzzle flare and the raised deck block, which are the
    // two #678's comparison found clearest. This asserts the pair, not just that two levers are
    // pulled: `both` meant girth and deck under the first three-lever vocabulary, and shipping
    // the arm means it now means what the measurement chose.
    expect(weaponLever('both')).toBe('flare');
    expect(mineLever('both')).toBe('riser');
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

  it('separates the hull lever\'s three states by WHICH feature sharpens, not by an ordering', () => {
    // `hull` is the one weapon lever whose states are ABSOLUTE plan parameters rather than
    // multipliers, so it cannot join the sweep above: its shipped value is HULL_CORNER, not 1.
    // The reason is the clamps. `hullPlan` puts `nose` through `clamp01` and the shipped nose
    // is already 1, so nose cannot go above shipped and can only mark the `fast` end; `round`
    // is clamped to min(round, halfW * 0.9, halfL * 0.45) = 0.45 here, which is the ceiling the
    // `ricochet` end sits at.
    const corner = (t: 'fast' | 'normal' | 'ricochet') =>
      weaponShapeFor('hull', t).hullCorner as number;
    const nose = (t: 'fast' | 'normal' | 'ricochet') =>
      weaponShapeFor('hull', t).hullNose as number;

    // NOT AN ORDERING, and that is the finding rather than a compromise. `hullPlan` clamps the
    // corner to min(round, halfW * 0.9, halfL * 0.45) = 0.225 on this hull, and the shipped 0.3
    // is already clamped to it, so nothing can be blunter than shipped. A first version asked
    // for 0.45 at the `ricochet` end and rendered VERTEX-IDENTICAL to shipped; this test passed
    // anyway, because it compared the mapping's numbers instead of the shapes they make.
    //
    // So the three states are separated by WHICH feature sharpens, and what must hold is that
    // all three are distinct and that neither non-shipped state is blunter than shipped.
    expect(corner('ricochet')).toBeLessThan(corner('normal'));
    expect(corner('fast'), 'fast changes the nose, not the corner').toBe(corner('normal'));
    expect(nose('fast')).toBeLessThan(nose('normal'));
    expect(nose('ricochet'), 'ricochet changes the corner, not the nose').toBe(nose('normal'));

    const sig = (t: 'fast' | 'normal' | 'ricochet') => `${corner(t)}|${nose(t)}`;
    expect(new Set([sig('fast'), sig('normal'), sig('ricochet')]).size, 'three distinct states').toBe(3);
    // The shipped tank must not move a vertex, so the standard shell is the shipped hull.
    //
    // LITERALS, not the render constants, and deliberately: presentation may not import
    // render -- the renderer is an implementation, not a contract, and
    // `dependency-direction.test.ts` enforces it. So this half pins the VALUES, and the tie
    // between them and `HULL_CORNER` / `HULL_NOSE` is asserted one layer up, in
    // `entities.test.ts`, where both are legally in scope. Neither half is sufficient alone:
    // this one would pass if the render constants moved, and that one would pass if these
    // numbers stopped being the shipped ones.
    expect(corner('normal'), 'the standard shell is the shipped hull').toBe(0.3);
    expect(nose('normal'), 'the standard shell is the shipped hull').toBe(1);
    // No state may ask for a corner the clamp would eat, because a value the clamp eats is a
    // state that silently renders as its neighbour -- which is exactly what happened.
    // A state that intends to CHANGE the corner must ask for a value the clamp will honour. A
    // state that intends to keep the shipped corner may pass the shipped value through, clamp
    // and all -- it renders as shipped either way, which is the intent.
    const CORNER_CEILING = 0.225;   // min(halfW * 0.9, halfL * 0.45) on the shipped hull
    for (const t of ['fast', 'normal', 'ricochet'] as const) {
      if (corner(t) !== corner('normal')) {
        expect(corner(t), `${t} asks for a corner the clamp would eat`).toBeLessThanOrEqual(CORNER_CEILING);
      }
      expect(nose(t), `${t} nose above the clamp01 ceiling`).toBeLessThanOrEqual(1);
      expect(nose(t), `${t} nose below zero`).toBeGreaterThan(0);
    }
  });

  it('spends the hull lever on weapon TYPE, never on the kind name', () => {
    // The fix PR #830 made for mine capacity, applied here before it can go wrong: the cue
    // answers "what is about to be fired at me", so re-arming a tank in tank-defs.json has to
    // move its hull with it. A mapping keyed on kind would agree today and drift silently.
    //
    // The control is that kinds sharing a bullet type must share a hull, and kinds differing in
    // it must differ -- which is a property of the ROSTER, so it fails if the mapping is keyed
    // on anything else.
    const byType = new Map<string, Set<string>>();
    for (const kind of ENEMIES) {
      const t = configFor(kind).weapon.bulletType;
      const shape = weaponShapeFor('hull', t);
      const sig = `${shape.hullCorner}|${shape.hullNose}`;
      if (!byType.has(t)) byType.set(t, new Set());
      byType.get(t)!.add(sig);
    }
    for (const [t, sigs] of byType) {
      expect(sigs.size, `every ${t} tank must get one hull`).toBe(1);
    }
    // ...and distinct types must not collide, or the lever carries nothing.
    const all = new Set([...byType.values()].map((s) => [...s][0]));
    expect(all.size, 'distinct bullet types must get distinct hulls').toBe(byType.size);
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

  it('does not widen the ceiling when the hull lever joins the grammar (issue #831)', () => {
    // A seventh lever is a seventh way of saying the same three weapon states, not a seventh
    // group. Hull shape encodes WEAPON CLASS, which brown and grey already share and teal and
    // green already share, so adding it to the signature must leave the count at four.
    //
    // This is the check that a new lever cannot quietly widen the ceiling by being keyed on
    // something it should not be: if `hull` were derived from the kind name rather than the
    // resolved weapon, this would read six and the ceiling argument would silently become
    // false while every other test still passed.
    const withHull = (kind: (typeof ENEMIES)[number]) => {
      const c = configFor(kind);
      const h = weaponShapeFor('hull', c.weapon.bulletType);
      return `${signature(kind)}|${h.hullCorner}|${h.hullNose}`;
    };
    const groups = new Set(ENEMIES.map(withHull));
    expect(groups.size, 'the hull lever must not add a group').toBe(4);
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
