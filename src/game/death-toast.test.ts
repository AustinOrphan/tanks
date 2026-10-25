import { describe, it, expect } from 'vitest';
import { createDeathToastCue, deathToastText, DEATH_TOAST_WINDOW_TICKS } from './death-toast';
import { createWorldFor } from '../sim/arena';
import { STANDARD_ARENA, createArenaWorld } from '../sim/config/arena-fixtures';
import { createWorld, type World } from '../sim/world';
import { dropMine, detonateMine, stepBlasts, BLAST_LIFETIME_TICKS } from '../sim/mines';
import { MINE_BLAST_RADIUS, TANK_RADIUS } from '../sim/constants';
import type { Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';

function spy(): { hud: { showToast(message: string): void }; toasts: string[] } {
  const toasts: string[] = [];
  return { hud: { showToast: (m) => toasts.push(m) }, toasts };
}

const destroyed = (t: Tank): SimEvent => ({
  type: 'tank-destroyed', tankId: t.id, kind: t.kind, by: { source: 'shell', ownerId: 0 },
  pos: { x: t.pos.x, y: t.pos.y },
});

/** A real campaign-coop load, its player tanks in slot order (slot 0 is the tracked player). */
function coop(players: number): { world: World; slots: Tank[] } {
  const world = createWorldFor(STANDARD_ARENA, 7, { playerCount: players });
  const slots = world.tanks
    .filter((t) => t.kind === 'player')
    .sort((a, b) => (a.controlledBy ?? 0) - (b.controlledBy ?? 0));
  expect(slots.map((t) => t.controlledBy), 'the load stamps every slot').toEqual(
    Array.from({ length: players }, (_, i) => i),
  );
  return { world, slots };
}

const at = (world: World, tick: number): World => ({ ...world, tick });

describe('the co-op death toast (issue #925)', () => {
  it('names the slot the way the stock strip labels it, P1 through P4', () => {
    expect([0, 1, 2, 3].map(deathToastText)).toEqual(['P1 out', 'P2 out', 'P3 out', 'P4 out']);
  });

  it('names the player who died, not the tracked player', () => {
    // Slot 2's death with slot 0 tracked: the toast is about whoever died, and only the
    // vignette is tied to the tracked player.
    const { world, slots: [p1, , p3] } = coop(3);
    const { hud, toasts } = spy();
    createDeathToastCue(hud).handle([destroyed(p3)], world, 'campaign', p1.id);
    expect(toasts).toEqual(['P3 out']);
  });

  it('stays silent with one player tank, where the vignette is the classic red', () => {
    const solo = createArenaWorld(7);
    const player = solo.tanks.find((t) => t.kind === 'player') as Tank;
    const { hud, toasts } = spy();
    createDeathToastCue(hud).handle([destroyed(player)], solo, 'campaign', player.id);
    expect(toasts).toEqual([]);
    // The control: the same death with a partner on the board is named.
    const { world, slots: [p1] } = coop(2);
    const partnered = spy();
    createDeathToastCue(partnered.hud).handle([destroyed(p1)], world, 'campaign', p1.id);
    expect(partnered.toasts).toEqual(['P1 out']);
  });

  it('stays silent in versus, whose stock strip and announcement already name every death', () => {
    for (const mode of ['ffa', 'teams'] as const) {
      const world = createWorldFor(STANDARD_ARENA, 7, { playerCount: 2, rules: { mode } });
      const [p1, p2] = world.tanks.filter((t) => t.kind === 'player');
      const { hud, toasts } = spy();
      createDeathToastCue(hud).handle([destroyed(p2), destroyed(p1)], world, 'versus', p1.id);
      expect(toasts, mode).toEqual([]);
    }
    // The control: a Level Select board played by two is co-op-shaped, and is named.
    const { world, slots: [p1, p2] } = coop(2);
    const { hud, toasts } = spy();
    createDeathToastCue(hud).handle([destroyed(p2)], world, 'practice', p1.id);
    expect(toasts).toEqual(['P2 out']);
  });

  it("ignores an enemy's death", () => {
    const { world, slots: [p1] } = coop(2);
    const enemy = world.tanks.find((t) => t.kind !== 'player') as Tank;
    const { hud, toasts } = spy();
    createDeathToastCue(hud).handle([destroyed(enemy)], world, 'campaign', p1.id);
    expect(toasts).toEqual([]);
  });

  describe('the throttle: a multi-kill does not narrate every death', () => {
    it('names one player when several die in one frame', () => {
      const { world, slots: [p1, p2, p3] } = coop(3);
      const { hud, toasts } = spy();
      createDeathToastCue(hud).handle([destroyed(p2), destroyed(p3)], at(world, 100), 'campaign', p1.id);
      expect(toasts).toEqual(['P2 out']);
    });

    it('raises nothing for a death inside the window, and names one at its end', () => {
      const { world, slots: [p1, p2, p3] } = coop(3);
      const inside = spy();
      const cue = createDeathToastCue(inside.hud);
      cue.handle([destroyed(p2)], at(world, 100), 'campaign', p1.id);
      cue.handle([destroyed(p3)], at(world, 100 + DEATH_TOAST_WINDOW_TICKS - 1), 'campaign', p1.id);
      expect(inside.toasts).toEqual(['P2 out']);
      const after = spy();
      const later = createDeathToastCue(after.hud);
      later.handle([destroyed(p2)], at(world, 100), 'campaign', p1.id);
      later.handle([destroyed(p3)], at(world, 100 + DEATH_TOAST_WINDOW_TICKS), 'campaign', p1.id);
      expect(after.toasts).toEqual(['P2 out', 'P3 out']);
    });

    it('holds every death one real blast causes inside one window', () => {
      // The window's justification, measured on the sim rather than asserted: a blast kills
      // each tank on the tick its edge reaches it, and keeps killing through its hold, so its
      // deaths spread over BLAST_LIFETIME_TICKS - 1 ticks. Slot 1 stands on the mine, slot 2
      // at the edge's full reach, and slot 3 drives in on the blast's last lethal tick; slot
      // 0, the tracked player, is clear of it.
      const tank = (id: number, slot: number, x: number): Tank => ({
        id, kind: 'player', pos: { x, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
        desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
        aiState: 'idle', aiTimer: 0, controlledBy: slot,
      });
      const p1 = tank(1, 0, 40);
      const p2 = tank(2, 1, TANK_RADIUS);
      const p3 = tank(3, 2, MINE_BLAST_RADIUS + TANK_RADIUS - 0.05);
      const p4 = tank(4, 3, 60);
      const world = createWorld({ walls: [], tanks: [p1, p2, p3, p4], spawns: [], lives: 3 });
      world.tick = 500;
      expect(dropMine(world, p1.id, [])).toBe(true);
      const mine = world.mines[0];
      mine.pos = { x: 0, y: 0 };
      const { hud, toasts } = spy();
      const cue = createDeathToastCue(hud);
      const diedAt = new Map<number, number>();
      const frame = (events: SimEvent[]): void => {
        for (const e of events) if (e.type === 'tank-destroyed') diedAt.set(e.tankId, world.tick - 500);
        cue.handle(events, world, 'campaign', p1.id);
      };
      const first: SimEvent[] = [];
      detonateMine(world, mine, first);
      frame(first);
      for (let age = 1; age < BLAST_LIFETIME_TICKS; age++) {
        world.tick += 1;
        if (age === BLAST_LIFETIME_TICKS - 1) p4.pos = { x: -TANK_RADIUS, y: 0 };
        const events: SimEvent[] = [];
        stepBlasts(world, events);
        frame(events);
      }
      // The premise: three deaths, the first and last as far apart as one blast allows.
      expect([...diedAt.entries()].sort((a, b) => a[0] - b[0])).toEqual([
        [2, 0], [3, expect.any(Number)], [4, BLAST_LIFETIME_TICKS - 1],
      ]);
      expect(diedAt.get(3)).toBeGreaterThan(0);
      expect(toasts).toEqual(['P2 out']);
    });

    it("names the vignette's owner first in a frame it shares", () => {
      // The vignette flashes the tracked player's color on this same frame, so a toast
      // naming the other victim would mis-attribute it.
      const { world, slots: [p1, p2] } = coop(2);
      const { hud, toasts } = spy();
      createDeathToastCue(hud).handle([destroyed(p2), destroyed(p1)], at(world, 100), 'campaign', p1.id);
      expect(toasts).toEqual(['P1 out']);
    });

    it("never suppresses the vignette's owner inside the window", () => {
      const { world, slots: [p1, p2] } = coop(2);
      const { hud, toasts } = spy();
      const cue = createDeathToastCue(hud);
      cue.handle([destroyed(p2)], at(world, 100), 'campaign', p1.id);
      cue.handle([destroyed(p1)], at(world, 103), 'campaign', p1.id);
      expect(toasts).toEqual(['P2 out', 'P1 out']);
    });

    it("starts the window over on a new world, whose tick clock starts over", () => {
      const { world, slots: [p1, p2, p3] } = coop(3);
      const { hud, toasts } = spy();
      const cue = createDeathToastCue(hud);
      cue.handle([destroyed(p2)], at(world, 100), 'campaign', p1.id);
      cue.reset();
      cue.handle([destroyed(p3)], at(world, 103), 'campaign', p1.id);
      expect(toasts).toEqual(['P2 out', 'P3 out']);
      // The control: without the reset the same two deaths are one window.
      const kept = spy();
      const stale = createDeathToastCue(kept.hud);
      stale.handle([destroyed(p2)], at(world, 100), 'campaign', p1.id);
      stale.handle([destroyed(p3)], at(world, 103), 'campaign', p1.id);
      expect(kept.toasts).toEqual(['P2 out']);
    });
  });
});
