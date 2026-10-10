import { describe, it, expect } from 'vitest';
import {
  ENEMY_ROLE_CUES, isEnemyRoleCue, weaponLever, mineLever,
  weaponShapeFor, mineShapeFor,
} from './enemy-role';
import { configFor, hasAbility, TankAbility } from '../sim/config';
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
  type Kind = (typeof ENEMIES)[number];
  /**
   * The mine load `makeTank` (entities.ts) hands `mineShapeFor`: none for a kind without
   * MINE_LAYER, otherwise its roster budget (issue #1059). Restated here because presentation
   * may not import render, so this file pins what the MAPPING does with that load; the drawn
   * count is pinned against the real gate in entities.test.ts ('the mine cue follows
   * MINE_LAYER, not mine capacity'), which is where a drift between the two fails.
   */
  const mineLoad = (kind: Kind): number =>
    hasAbility(kind, TankAbility.MINE_LAYER) ? configFor(kind).mineCapacity : 0;
  /** The raw roster capacity: the misreading the retired four-group ceiling came from. */
  const rawCapacity = (kind: Kind): number => configFor(kind).mineCapacity;

  type Lever = 'girth' | 'flare' | 'dome' | 'hull';
  const weaponOf = (kind: Kind, lever: Lever = 'girth'): string =>
    Object.values(weaponShapeFor(lever, configFor(kind).weapon.bulletType)).join(',');
  const minesOf = (kind: Kind, load: (k: Kind) => number = mineLoad): string =>
    `${mineShapeFor('deck', load(kind)).deckBar}`;
  const signature = (kind: Kind, load = mineLoad, lever: Lever = 'girth'): string =>
    `${weaponOf(kind, lever)}|${minesOf(kind, load)}`;

  /** The roster grouped by `sig`: how many groups, and which kinds share one. */
  const groupsOf = (sig: (k: Kind) => string): { groups: number; collided: string[][] } => {
    const groups = new Map<string, string[]>();
    for (const kind of ENEMIES) groups.set(sig(kind), [...(groups.get(sig(kind)) ?? []), kind]);
    const all = [...groups.values()].map((ks) => [...ks].sort());
    return { groups: all.length, collided: all.filter((ks) => ks.length > 1).sort() };
  };

  it('separates the six enemy kinds once mine load reads MINE_LAYER -- population: 6 enemy kinds, no pair collides', () => {
    // Weapon class and mine load, the two facts the levers encode, give every enemy kind its
    // own signature: brown (standard shell, no mines), grey (standard, two), yellow (standard,
    // four), teal (ricochet, two), green (ricochet, none) and olive (rocket, none). Brown and
    // green carry a capacity of 2 but hold no MINE_LAYER, and the simulation gates every mine
    // on the ability, so they lay none.
    expect(groupsOf((k) => signature(k)), 'the groups the grammar separates').toEqual({
      groups: 6, collided: [],
    });
    // The negative fixture: keyed on the raw capacity, brown reads as grey and green as teal,
    // and the count falls to the four the retired ceiling claimed as the most a still frame
    // could separate.
    expect(groupsOf((k) => signature(k, rawCapacity)), 'keyed on raw capacity').toEqual({
      groups: 4, collided: [['brown', 'grey'], ['green', 'teal']],
    });
  });

  it('gives every weapon lever the same three groups, the hull included, so mine load is what reaches six (issue #831) -- population: 4 weapon levers x 6 enemy kinds', () => {
    // A seventh lever is a seventh way of saying the same three weapon states, not a new group.
    // Each weapon lever, hull shape included, encodes WEAPON CLASS, so on its own it must group
    // the roster exactly as the bullet type does: brown, grey and yellow fire the standard
    // shell, green and teal the ricochet rocket, olive the fast one. With mine load beside it,
    // each reaches the same six. A lever keyed on the kind name rather than the resolved weapon
    // would read six on its own, and a lever that lost a state would read two.
    for (const lever of ['girth', 'flare', 'dome', 'hull'] as const) {
      expect({
        alone: groupsOf((k) => weaponOf(k, lever)),
        withMineLoad: groupsOf((k) => signature(k, mineLoad, lever)).groups,
      }, lever).toEqual({
        alone: { groups: 3, collided: [['brown', 'grey', 'yellow'], ['green', 'teal']] },
        withMineLoad: 6,
      });
    }
  });

  it('separates olive by weapon class alone and yellow by mine load alone; the other four need both levers', () => {
    // Olive is the only zero-bounce rocket and yellow the only kind carrying four mines, so one
    // lever already sets each apart. Brown, grey, teal and green each share their weapon class
    // with at least one other kind and their mine load with at least one other, and those four
    // are what `both`, two levers on one silhouette, exists to separate.
    const alone = (sig: (k: Kind) => string): string[] =>
      ENEMIES.filter((k) => ENEMIES.filter((o) => sig(o) === sig(k)).length === 1);
    expect(alone((k) => weaponOf(k)), 'kinds weapon class alone separates').toEqual(['olive']);
    expect(alone((k) => minesOf(k)), 'kinds mine load alone separates').toEqual(['yellow']);
    // The negative fixture: on the raw capacity olive stands alone on mine load too, the
    // reading that called it the only kind that lays no mines while brown and green lay none.
    expect(alone((k) => minesOf(k, rawCapacity)), 'keyed on raw capacity').toEqual(['olive', 'yellow']);
  });
});
