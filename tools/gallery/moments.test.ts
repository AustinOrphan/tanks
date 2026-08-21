import { describe, it, expect } from 'vitest';
import { MOMENTS, simulateMoment } from './moments';
import type { World } from '../../src/sim/world';
import { RESPAWN_DELAY_TICKS, MINE_PROXIMITY_RADIUS, MINE_TIMER, TANK_SPEED, DT, TICK_HZ } from '../../src/sim/constants';

describe('every moment pins its events to exact ticks', () => {
  for (const [name, def] of Object.entries(MOMENTS)) {
    it(`${name}: each expected event fires on its declared tick — and on no other`, () => {
      const tl = simulateMoment(def);
      expect(tl.worlds).toHaveLength(def.ticks + 1);
      for (const { type, tick } of def.expect) {
        expect(tl.events[tick].map((e) => e.type)).toContain(type);
        // The negative half: the pinned tick is THE tick. An event that also fires
        // elsewhere makes "staged on a known tick" false, and a fixture drift that
        // moves it shows up here rather than as a silently mistimed gif.
        const elsewhere = tl.events
          .flatMap((evs, t) => evs.filter((e) => e.type === type).map(() => t))
          .filter((t) => t !== tick);
        expect(elsewhere, `${type} also fired at ticks ${elsewhere}`).toEqual([]);
      }
    });
    it(`${name}: the timeline is a pure function of the def (two runs, identical)`, () => {
      const a = simulateMoment(def);
      const b = simulateMoment(def);
      expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
      expect(JSON.stringify(a.worlds[def.ticks])).toBe(JSON.stringify(b.worlds[def.ticks]));
    });
  }
});

describe('fire moment specifics', () => {
  it('the fire event carries the player ownerId and the staged position', () => {
    const tl = simulateMoment(MOMENTS.fire);
    const tick = MOMENTS.fire.expect.find((e) => e.type === 'fire')!.tick;
    const ev = tl.events[tick].find((e) => e.type === 'fire');
    expect(ev).toBeDefined();
    if (ev?.type !== 'fire') throw new Error('narrowed above');
    // ownerId: events sourced from a different tank would fail this
    expect(ev.ownerId).toBe(1);
    // pos.x: muzzle offset pin (SHELL_SPAWN_FORWARD = 0.85); different tank id or spawn point would fail this
    expect(ev.pos.x).toBeCloseTo(0.85, 2);
    // pos.y: tank centre y-coordinate; different tank position would fail this
    expect(ev.pos.y).toBe(0);
  });
});

describe('respawn moment specifics', () => {
  it('stages kill and revival K ticks apart, where K is the shipped RESPAWN_DELAY_TICKS', () => {
    const killed = MOMENTS.respawn.expect.find((e) => e.type === 'tank-destroyed')!.tick;
    const revived = MOMENTS.respawn.expect.find((e) => e.type === 'respawn')!.tick;
    expect(revived - killed).toBe(RESPAWN_DELAY_TICKS);
  });
  it('the victim is dead in the worlds between the two pinned ticks and alive after', () => {
    const tl = simulateMoment(MOMENTS.respawn);
    const killed = MOMENTS.respawn.expect.find((e) => e.type === 'tank-destroyed')!.tick;
    const revived = MOMENTS.respawn.expect.find((e) => e.type === 'respawn')!.tick;
    const ev = tl.events[killed].find((e) => e.type === 'tank-destroyed') as { tankId: number };
    const victim = (w: World) => w.tanks.find((t) => t.id === ev.tankId)!;
    expect(victim(tl.worlds[killed]).alive).toBe(false);
    expect(victim(tl.worlds[revived - 1]).alive).toBe(false);
    expect(victim(tl.worlds[revived]).alive).toBe(true);
  });
});

describe('ricochet moment specifics', () => {
  it('is the first bounce, and lands on the wall line it bounced off', () => {
    const tl = simulateMoment(MOMENTS.ricochet);
    const tick = MOMENTS.ricochet.expect.find((e) => e.type === 'ricochet')!.tick;
    const ev = tl.events[tick].find((e) => e.type === 'ricochet');
    expect(ev).toBeDefined();
    if (ev?.type !== 'ricochet') throw new Error('narrowed above');
    // bounceIndex 0: the FIRST bounce this shell has spent, not a second shell's or a
    // re-fired later one -- a bounce budget bug (e.g. crediting the wrong shell, or
    // reusing an index) would fail this without needing a second wall to reproduce.
    expect(ev.bounceIndex).toBe(0);
    // The wall this moment actually built, read back from the simulated world rather
    // than a bare literal -- a wall moved, missed, or hit on a different face all fail
    // this the same way a wrong-tick pin would.
    const wall = tl.worlds[0].walls[0];
    expect(ev.pos.x).toBeCloseTo(wall.aabb.minX, 6);
  });
});

describe('wall-break moment specifics', () => {
  it('flips the cell\'s destroyed flag exactly at the pinned tick, not before or after', () => {
    const tl = simulateMoment(MOMENTS['wall-break']);
    const tick = MOMENTS['wall-break'].expect.find((e) => e.type === 'wall-destroyed')!.tick;
    expect(tl.worlds[tick - 1].walls[0].destroyed).toBe(false);
    expect(tl.worlds[tick].walls[0].destroyed).toBe(true);
  });
  it('credits the shooter, and never catches the shooter in the same blast', () => {
    const tl = simulateMoment(MOMENTS['wall-break']);
    const tick = MOMENTS['wall-break'].expect.find((e) => e.type === 'wall-destroyed')!.tick;
    const ev = tl.events[tick].find((e) => e.type === 'wall-destroyed');
    expect(ev).toBeDefined();
    if (ev?.type !== 'wall-destroyed') throw new Error('narrowed above');
    expect(ev.ownerId).toBe(1);
    // No 'explosion'/'tank-destroyed' anywhere in the clip: the shooter is staged far
    // enough from the mine (see moments.ts) to survive its own shot's blast.
    const other = tl.events.flat().map((e) => e.type);
    expect(other).not.toContain('explosion');
    expect(other).not.toContain('tank-destroyed');
    expect(tl.worlds[MOMENTS['wall-break'].ticks].tanks[0].alive).toBe(true);
  });
});

describe('mine-cycle moment specifics', () => {
  const drop = () => MOMENTS['mine-cycle'].expect.find((e) => e.type === 'mine-dropped')!.tick;
  const arm = () => MOMENTS['mine-cycle'].expect.find((e) => e.type === 'mine-armed')!.tick;
  const detonate = () => MOMENTS['mine-cycle'].expect.find((e) => e.type === 'mine-detonate')!.tick;

  it('arms only once the owner has cleared MINE_PROXIMITY_RADIUS, the ticks the sim balance actually needs', () => {
    // Independent cross-check against the imported constants, same shape as respawn's
    // `revived - killed === RESPAWN_DELAY_TICKS` -- the expect[] ticks above stay
    // literals, so this can genuinely fail if MINE_PROXIMITY_RADIUS or TANK_SPEED moves
    // without the fixture moving with it.
    const ticksToClear = Math.ceil(MINE_PROXIMITY_RADIUS / (TANK_SPEED * DT));
    expect(arm() - drop()).toBe(ticksToClear);
  });

  it('detonates on fuse expiry, MINE_TIMER seconds after the drop, not a proximity re-trigger', () => {
    expect(detonate() - drop()).toBe(Math.round(MINE_TIMER * TICK_HZ));
  });

  it('never fires an explosion or kills its own owner: the walk-away clears blast range first', () => {
    const tl = simulateMoment(MOMENTS['mine-cycle']);
    const types = tl.events.flat().map((e) => e.type);
    expect(types).not.toContain('explosion');
    expect(types).not.toContain('tank-destroyed');
    expect(tl.worlds[MOMENTS['mine-cycle'].ticks].tanks[0].alive).toBe(true);
  });
});
