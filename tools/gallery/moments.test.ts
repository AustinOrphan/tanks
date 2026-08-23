import { describe, it, expect } from 'vitest';
import { MOMENTS, simulateMoment, PIVOT_POSITION_BOUND, PIVOT_TURRET_EPS } from './moments';
import type { World } from '../../src/sim/world';
import {
  RESPAWN_DELAY_TICKS, MINE_PROXIMITY_RADIUS, MINE_TIMER, TANK_SPEED, DT, TICK_HZ, TANK_RADIUS,
  MINE_WARNING_TICKS,
} from '../../src/sim/constants';
import { EMIT_SPACING } from '../../src/render/tread-trails';

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

  it('detonates on fuse expiry plus the warning, MINE_TIMER seconds + MINE_WARNING_TICKS after the drop', () => {
    // Issue #275: fuse expiry OPENS the triggered warning; the blast follows exactly
    // MINE_WARNING_TICKS later (the fuse path triggers inside stepMines, so the
    // trigger tick itself takes no countdown decrement -- contrast wall-break's
    // shell path, one tick tighter, documented at its pins in moments.ts).
    expect(detonate() - drop()).toBe(Math.round(MINE_TIMER * TICK_HZ) + MINE_WARNING_TICKS);
  });

  it('never fires an explosion or kills its own owner: the walk-away clears blast range first', () => {
    const tl = simulateMoment(MOMENTS['mine-cycle']);
    const types = tl.events.flat().map((e) => e.type);
    expect(types).not.toContain('explosion');
    expect(types).not.toContain('tank-destroyed');
    expect(tl.worlds[MOMENTS['mine-cycle'].ticks].tanks[0].alive).toBe(true);
  });
});

describe('drive moment specifics', () => {
  it('position.x increases every tick while position.y, bodyAngle, and turretAngle hold exactly still', () => {
    // Negative control: a move input with a nonzero y component (e.g. {x: 1, y: 0.1})
    // moves position.y off 0 -- verified live against this exact assertion and
    // reverted (see this task's report).
    const tl = simulateMoment(MOMENTS.drive);
    for (let t = 1; t <= MOMENTS.drive.ticks; t++) {
      const prev = tl.worlds[t - 1].tanks[0];
      const cur = tl.worlds[t].tanks[0];
      expect(cur.pos.x).toBeGreaterThan(prev.pos.x);
      expect(cur.pos.y).toBe(0);
      expect(cur.bodyAngle).toBe(0);
      expect(cur.turretAngle).toBe(0);
    }
  });
});

describe('pivot moment specifics', () => {
  it('bodyAngle increases every tick while position and turretAngle stay inside their measured bounds', () => {
    // Negative controls (both verified live and reverted, see this task's report):
    // - an already-aligned move (e.g. {x: 1, y: 0}, `drive`'s own input) leaves
    //   bodyAngle FLAT -- the "every tick differs" half of this assertion reds
    //   immediately, and the position bound below is exceeded by tick 5.
    // - a NEARER aim point (e.g. {x: 10, y: 0} instead of {x: 1e6, y: 0}) pushes
    //   turretAngle's drift past PIVOT_TURRET_EPS by tick 4.
    const tl = simulateMoment(MOMENTS.pivot);
    const start = tl.worlds[0].tanks[0];
    for (let t = 1; t <= MOMENTS.pivot.ticks; t++) {
      const prev = tl.worlds[t - 1].tanks[0];
      const cur = tl.worlds[t].tanks[0];
      expect(cur.bodyAngle).toBeGreaterThan(prev.bodyAngle);
      const dist = Math.hypot(cur.pos.x - start.pos.x, cur.pos.y - start.pos.y);
      expect(dist).toBeLessThan(PIVOT_POSITION_BOUND);
      expect(Math.abs(cur.turretAngle - start.turretAngle)).toBeLessThan(PIVOT_TURRET_EPS);
    }
  });
});

describe('traverse moment specifics', () => {
  it('turretAngle increases every tick while position and bodyAngle hold exactly still', () => {
    // Negative control: a nonzero move input (e.g. {x: 1, y: 0}) moves position off
    // (0, 0) -- verified live against this exact assertion and reverted (see this
    // task's report).
    const tl = simulateMoment(MOMENTS.traverse);
    for (let t = 1; t <= MOMENTS.traverse.ticks; t++) {
      const prev = tl.worlds[t - 1].tanks[0];
      const cur = tl.worlds[t].tanks[0];
      expect(cur.turretAngle).toBeGreaterThan(prev.turretAngle);
      expect(cur.pos.x).toBe(0);
      expect(cur.pos.y).toBe(0);
      expect(cur.bodyAngle).toBe(0);
    }
  });
});

describe('trail-stop moment specifics', () => {
  it('crosses EMIT_SPACING several times while driving, then holds EXACTLY still once stopped', () => {
    // Literal, matching the moment's own scripted stop point (moments.ts), not derived
    // from MOMENTS['trail-stop'].ticks -- this is the thing under test, not a restated
    // constant.
    const DRIVE_TICKS = 30;
    const tl = simulateMoment(MOMENTS['trail-stop']);
    // Negative control: cutting the moment's own drive cutoff (moments.ts) from 30 to
    // 3 ticks reds THIS loop, at t = 4 -- "expected 0.15000000000000002 to be greater
    // than 0.15000000000000002" (cur.pos.x stalls the tick after the mutated moment
    // stops driving) -- verified live and reverted (see this task's report). It fails
    // here, not at the EMIT_SPACING line below: DRIVE_TICKS stays a literal 30 in this
    // test regardless of what the moment itself does, so this loop walks ticks 4-30
    // expecting motion the mutated moment no longer produces, and reds before
    // execution ever reaches that later line.
    for (let t = 1; t <= DRIVE_TICKS; t++) {
      const prev = tl.worlds[t - 1].tanks[0];
      const cur = tl.worlds[t].tanks[0];
      expect(cur.pos.x).toBeGreaterThan(prev.pos.x);
      expect(cur.pos.y).toBe(0);
      expect(cur.bodyAngle).toBe(0);
    }
    const stopPos = tl.worlds[DRIVE_TICKS].tanks[0].pos;
    // Several EMIT_SPACING crossings before the stop: the acceptance criterion's
    // "stopping" capture needs more than one decal pair already printed when the tank
    // parks. This line has its OWN dedicated negative control, distinct from the loop
    // above's: halving the moment's drive input to `{x: 0.5, y: 0}` for all 30 ticks
    // (moments.ts) keeps every tick's position still strictly increasing -- so the
    // loop above stays green -- but halves the total distance covered to 0.75, under
    // EMIT_SPACING * 5 = 1.25, and reds exactly this line: "expected
    // 0.7500000000000003 to be greater than 1.25" -- verified live and reverted (see
    // this task's report).
    expect(stopPos.x - tl.worlds[0].tanks[0].pos.x).toBeGreaterThan(EMIT_SPACING * 5);
    // Frozen, not merely unchanged tick to tick: every stopped-phase world compares
    // EXACTLY equal to the position at the moment of stopping, not just to its
    // immediate predecessor -- a slow residual drift would still pass a
    // tick-to-tick-only check but fail this. Negative control: a stray nonzero `move`
    // in the post-stop input branch (e.g. leaving `{x: 1, y: 0}` past DRIVE_TICKS)
    // reds this immediately -- verified live and reverted (see this task's report).
    for (let t = DRIVE_TICKS + 1; t <= MOMENTS['trail-stop'].ticks; t++) {
      const cur = tl.worlds[t].tanks[0];
      expect(cur.pos).toEqual(stopPos);
      expect(cur.bodyAngle).toBe(0);
    }
  });
});

describe('trail-cross moment specifics', () => {
  it('the two tanks never come within the tank-tank collision radius, so neither path is collision-nudged', () => {
    const tl = simulateMoment(MOMENTS['trail-cross']);
    for (let t = 0; t <= MOMENTS['trail-cross'].ticks; t++) {
      const a = tl.worlds[t].tanks[0].pos;
      const b = tl.worlds[t].tanks[1].pos;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      // TANK_RADIUS * 2 -- separateTanks' (collision.ts) own push-apart threshold; a
      // world.tanks entry within it gets shoved off its scripted line. Negative
      // control: moving B's idle row from BY0 = -1.05 to -0.75 in moments.ts pulls this
      // under 1.0 at tick 15 (MEASURED via probe) and reds this line -- verified live
      // and reverted (see this task's report).
      expect(dist).toBeGreaterThan(TANK_RADIUS * 2);
    }
  });
  it('the paths actually cross: A parks on the line B drives, B drives across the line A parks on', () => {
    const tl = simulateMoment(MOMENTS['trail-cross']);
    const final = tl.worlds[MOMENTS['trail-cross'].ticks].tanks;
    // A: stopped (same "holds exactly still once stopped" shape as trail-stop) on
    // x = 0.75 -- the line B's entire path sits on. Negative control: the SAME BY0
    // mutation the sibling collision-radius test above documents (-1.05 to -0.75 in
    // moments.ts) also reds this line -- "expected 1.9366393318012565 to be close to
    // 2, received difference is 0.06336066819874353, but expected 5e-7" -- proving
    // separateTanks really did nudge A's own parked position once the margin was
    // removed, not just B's. Verified live and reverted (see this task's report).
    expect(final[0].pos.x).toBeCloseTo(2.0, 6);
    expect(final[0].pos.y).toBe(0);
    // B: has crossed y = 0 -- A's own path line -- by more than one EMIT_SPACING, and
    // kept driving past it, so the capture's final frame shows trail on both sides of
    // the crossing (not just a hair over the line with nothing printed beyond it).
    // Negative control: cutting the moment's own `ticks` (moments.ts) from 70 to 52 --
    // just past B's own tick-51 crossing -- leaves B at y = 0.05, still `> 0` but under
    // EMIT_SPACING, and reds this line: "expected 0.05000000000000032 to be greater
    // than 0.25". Verified live and reverted (see this task's report).
    expect(final[1].pos.x).toBeCloseTo(0.75, 6);
    expect(final[1].pos.y).toBeGreaterThan(EMIT_SPACING);
  });
});

describe('trail-skins moment specifics', () => {
  it('both tanks drive level in parallel lanes, crossing EMIT_SPACING several times, never within collision range', () => {
    const tl = simulateMoment(MOMENTS['trail-skins']);
    for (let t = 0; t <= MOMENTS['trail-skins'].ticks; t++) {
      const a = tl.worlds[t].tanks[0];
      const b = tl.worlds[t].tanks[1];
      // Same start x, same speed, same heading every tick -> always level; a and b's
      // own x therefore stay equal for the whole clip.
      expect(a.pos.x).toBe(b.pos.x);
      expect(a.pos.y).toBe(0.75);
      expect(b.pos.y).toBe(-0.75);
      const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      expect(dist).toBeGreaterThan(TANK_RADIUS * 2);
    }
    const finalX = tl.worlds[MOMENTS['trail-skins'].ticks].tanks[0].pos.x;
    // Several EMIT_SPACING crossings for EACH tank's own trail. Negative control: a
    // shorter `ticks` (e.g. 3, 0.15 world units) reds this line -- same shape as
    // trail-stop's own EMIT_SPACING assertion, verified live and reverted (see this
    // task's report).
    expect(finalX).toBeGreaterThan(EMIT_SPACING * 5);
  });
});
