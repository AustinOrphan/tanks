import { describe, it, expect } from 'vitest';
import { MOMENTS, simulateMoment } from './moments';
import type { World } from '../../src/sim/world';
import { RESPAWN_DELAY_TICKS } from '../../src/sim/constants';

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
