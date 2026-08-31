// The idle-turret search heading (issue #371).
//
// The contract here is a SHAPE, not a look: bounded, held, reproducible, and blind to
// every other tank. The sweep and span constants are presentation cadence and are expected
// to move, so nothing below pins their values -- each case reads the constant it depends on.
import { describe, it, expect } from 'vitest';
import { searchAim } from './search';
import { AI_SEARCH_HOLD_TICKS, AI_SEARCH_SWEEP } from '../constants';
import { angleDelta } from '../types';
import type { Tank } from '../types';
import type { World } from '../world';

const tank = (id: number, over: Partial<Tank> = {}): Tank =>
  ({
    id,
    kind: 'grey',
    pos: { x: 0, y: 0 },
    bodyAngle: 0.3,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
    ...over,
  }) as Tank;

const world = (over: Partial<World> = {}): World =>
  ({ seed: 12345, tick: 0, tanks: [], bullets: [], mines: [], walls: [], ...over }) as unknown as World;

describe('idle turret search heading', () => {
  it('stays inside the sweep of the HULL angle, at every tick of a long run', () => {
    // Population stated: 4 hull angles x 2000 ticks = 8000 samples per tank id, 3 ids.
    let checked = 0;
    for (const bodyAngle of [0, 1.9, -2.7, Math.PI]) {
      for (const id of [1, 2, 3]) {
        const t = tank(id, { bodyAngle });
        for (let tick = 0; tick < 2000; tick++) {
          const a = searchAim(world({ tick }), t);
          expect(Math.abs(angleDelta(a, bodyAngle))).toBeLessThanOrEqual(AI_SEARCH_SWEEP);
          checked++;
        }
      }
    }
    expect(checked).toBe(4 * 3 * 2000);
  });

  it('reaches most of the sweep, so the bound above is not vacuous', () => {
    // The negative control for the case above: a searchAim that returned the hull angle
    // unchanged, or that only ever nudged a hundredth of a radian, would satisfy every
    // bound in this file and produce a turret that still never moves.
    let widest = 0;
    const t = tank(1);
    for (let tick = 0; tick < 20000; tick++) {
      widest = Math.max(widest, Math.abs(angleDelta(searchAim(world({ tick }), t), t.bodyAngle)));
    }
    expect(widest).toBeGreaterThan(AI_SEARCH_SWEEP * 0.9);
  });

  it('holds ONE heading for a whole span, and does not hold it forever', () => {
    const t = tank(7);
    const first = searchAim(world({ tick: 0 }), t);
    for (let tick = 1; tick < AI_SEARCH_HOLD_TICKS; tick++) {
      expect(searchAim(world({ tick }), t)).toBe(first);
    }
    // The next span must actually differ, or the hold is indistinguishable from a constant.
    expect(searchAim(world({ tick: AI_SEARCH_HOLD_TICKS }), t)).not.toBe(first);
  });

  it('is reproducible, and separates on every input that should separate it', () => {
    const t = tank(1);
    // Same everything -> same answer. This is what replay and the golden trace depend on.
    expect(searchAim(world({ tick: 100 }), t)).toBe(searchAim(world({ tick: 100 }), t));
    // A different seed, a different tank, or a different span must not agree.
    expect(searchAim(world({ tick: 100, seed: 999 }), t)).not.toBe(searchAim(world({ tick: 100 }), t));
    expect(searchAim(world({ tick: 100 }), tank(2))).not.toBe(searchAim(world({ tick: 100 }), t));
    expect(searchAim(world({ tick: 100 + AI_SEARCH_HOLD_TICKS }), t)).not.toBe(
      searchAim(world({ tick: 100 }), t),
    );
  });

  it('two tanks searching at the same tick do not point the same way', () => {
    // Otherwise a whole enemy line sweeps in unison, which reads as one scripted gun with
    // several barrels rather than several tanks each looking somewhere.
    const seen = new Set<number>();
    for (let id = 1; id <= 8; id++) seen.add(searchAim(world({ tick: 0 }), tank(id)));
    expect(seen.size).toBe(8);
  });

  it('ignores every other tank on the board', () => {
    // Issue #371's binding constraint: a search must not reveal or infer an enemy the
    // perception model says the tank has not detected. Asserted by moving, adding and
    // killing opponents and requiring the answer not to budge.
    const t = tank(1);
    const base = searchAim(world({ tick: 300, tanks: [t] }), t);
    const enemy = tank(2, { kind: 'player', pos: { x: 3, y: 4 } });
    expect(searchAim(world({ tick: 300, tanks: [t, enemy] }), t)).toBe(base);
    expect(
      searchAim(world({ tick: 300, tanks: [t, tank(2, { kind: 'player', pos: { x: -9, y: 1 } })] }), t),
    ).toBe(base);
    expect(
      searchAim(world({ tick: 300, tanks: [t, tank(2, { kind: 'player', alive: false })] }), t),
    ).toBe(base);
  });

  it('does not move when only the TURRET moves', () => {
    // The anchor is the hull, deliberately. If this were anchored on turretAngle the
    // target would chase the barrel as it slewed, breaking the aim hold every tick and
    // reintroducing the per-tick re-solve issue #344 removed.
    const a = searchAim(world({ tick: 300 }), tank(1, { turretAngle: 0 }));
    const b = searchAim(world({ tick: 300 }), tank(1, { turretAngle: 2.2 }));
    expect(b).toBe(a);
  });
});
