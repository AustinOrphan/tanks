import { describe, it, expect } from 'vitest';
import { MOMENTS, simulateMoment, PIVOT_POSITION_BOUND, PIVOT_TURRET_EPS } from './moments';
import type { World } from '../../src/sim/world';
import {
  RESPAWN_DELAY_TICKS, MINE_PROXIMITY_RADIUS, MINE_TIMER, TANK_SPEED, DT, TICK_HZ, TANK_RADIUS,
  AI_TURRET_TURN_RATE, AI_TURRET_RAMP_TICKS, AI_LAST_SEEN_TICKS,
} from '../../src/sim/constants';
import { step } from '../../src/sim/world';
import { lineOfSight } from '../../src/sim/ai/targeting';
import { EMIT_SPACING } from '../../src/render/tread-trails';

describe('every moment pins its events to exact ticks', () => {
  for (const [name, def] of Object.entries(MOMENTS)) {
    it(`${name}: each expected event fires on its declared tick — and on no other`, () => {
      const tl = simulateMoment(def);
      expect(tl.worlds).toHaveLength(def.ticks + 1);
      for (const { type, tick } of def.expect) {
        expect(tl.events[tick].map((e) => e.type)).toContain(type);
      }
      // The negative half: the pinned ticks are THE ticks. An event that also fires
      // elsewhere makes "staged on a known tick" false, and a fixture drift that moves
      // it shows up here rather than as a silently mistimed gif.
      //
      // Compared against the SET of ticks declared for each type, not against one of
      // them. The single-tick form this replaces could not express a moment that stages
      // the same event more than once -- `ai-commitment` fires seven times, because two
      // AIs tracking through a crossing cannot avoid brown's reaction gate -- and would
      // have reported every legitimate repeat as a stray. Identical for the moments that
      // declare one tick per type, which is all of the others.
      const declared = new Map<string, Set<number>>();
      for (const { type, tick } of def.expect) {
        if (!declared.has(type)) declared.set(type, new Set());
        declared.get(type)!.add(tick);
      }
      for (const [type, ticks] of declared) {
        const elsewhere = tl.events
          .flatMap((evs, t) => evs.filter((e) => e.type === type).map(() => t))
          .filter((t) => !ticks.has(t));
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
    // pos.x: muzzle PLANE pin (SHELL_MUZZLE_FORWARD = 0.85, where the flash goes) --
    // NOT the shell's spawn centre, which issue #237 moved back to 0.525. The number did
    // not move because the plane did not; only the constant it belongs to changed.
    // Different tank id or spawn point would fail this
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
    // Owner-revised issue #275: the fuse warning occupies the fuse's FINAL window,
    // so expiry timing is exactly what it always was -- the warning added no time.
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

describe('ai-tracking moment specifics', () => {
  it('the stationary AI holds position and bodyAngle exactly still while its turret sweeps then reverses', () => {
    // PEAK_TICK is MEASURED (throwaway vite-node probe, moments.ts's own comment):
    // turretAngle climbs every tick through tick 28 (the player's closest approach to
    // x = 0) and falls every tick after. Negative control: shortening the moment's
    // own AI_TRACKING_PLAYER_X0 offset toward 0 (e.g. -0.2) moves the closest approach
    // -- and so this pivot tick -- earlier, reddening this exact loop at the tick
    // where the two phases no longer agree with 28 -- verified live and reverted (see
    // this task's report).
    //
    // Pins the SHAPE of the sweep, not a tick-by-tick trajectory. Three separate AI changes
    // have now altered that trajectory without altering what this clip is FOR: #330's turret
    // deadband froze the single tick where the sweep reverses, #344's aim hold froze seven and
    // turned the fall into bursts, and #347 gave the turret acceleration so it ramps. A strict
    // per-tick `>` / `<` passes on a tree with none of them and fails on a tree with any, which
    // makes whichever lands next break main -- not hypothetical, it happened twice.
    //
    // What the moment exists to demonstrate survives all of them: a stationary hull, and a
    // turret that sweeps one way through a wide arc and comes back.
    const tl = simulateMoment(MOMENTS['ai-tracking']);
    const deltas: number[] = [];
    for (let t = 1; t <= MOMENTS['ai-tracking'].ticks; t++) {
      const prev = tl.worlds[t - 1].tanks[0];
      const cur = tl.worlds[t].tanks[0];
      // Brown hardcodes desiredMove {0, 0} on every path (brown.ts) -- the hull never
      // drives. Negative control: swapping tanks[0] for the PLAYER (tanks[1], which
      // does drive) fails this immediately at t = 1 -- verified live and reverted
      // (see this task's report).
      expect(cur.pos.x).toBe(0);
      expect(cur.pos.y).toBe(0);
      expect(cur.bodyAngle).toBe(0);
      deltas.push(cur.turretAngle - prev.turretAngle);
    }

    // Exactly one reversal: the turret goes out and comes back, and does not dither.
    const signs = deltas.map(Math.sign).filter((x) => x !== 0);
    expect(signs.filter((x, i) => i > 0 && x !== signs[i - 1]).length).toBe(1);

    // And it actually sweeps: a frozen turret would satisfy the flip count vacuously.
    const angles = tl.worlds.map((w) => (w.tanks[0].turretAngle * 180) / Math.PI);
    expect(Math.max(...angles)).toBeGreaterThan(55);

    // Never faster than one tick's budget: rate-limited, never a snap.
    const cap = AI_TURRET_TURN_RATE * DT;
    expect(Math.max(...deltas.map(Math.abs))).toBeLessThanOrEqual(cap + 1e-9);

    // ISSUE #347: the turret RAMPS UP rather than starting at the cap. The opening steps
    // each grow by about one acceleration budget until the cap is reached, which is the
    // whole point of the change and is what this moment is used to film. On a bang-bang
    // tree the very first step IS the cap and this fails immediately.
    const aMax = cap / AI_TURRET_RAMP_TICKS;
    // Deriving the expected first step FROM the constant would make this pass at any ramp,
    // including a ramp of 1 -- which is bang-bang. This is the assertion that actually
    // discriminates: on a tree without acceleration the opening step IS the full cap.
    expect(Math.abs(deltas[0])).toBeLessThan(cap);
    expect(Math.abs(deltas[0])).toBeCloseTo(aMax, 9);
    for (let i = 1; i < AI_TURRET_RAMP_TICKS; i++) {
      expect(Math.abs(deltas[i])).toBeGreaterThan(Math.abs(deltas[i - 1]));
      expect(Math.abs(deltas[i])).toBeLessThanOrEqual(cap + 1e-9);
    }
  });

  it('never fires: the 48-tick reaction gate (STATIC_BASIC reactionTime * TICK_HZ) is never reached in 47 ticks', () => {
    // Negative control: MEASURED (throwaway vite-node probe) -- extending this exact
    // fixture to 55 ticks fires a 'fire' event at tick 50, reddening this assertion.
    // moments.ts's own ticks comment documents the same probe. Verified live and
    // reverted (see this task's report).
    const tl = simulateMoment(MOMENTS['ai-tracking']);
    expect(tl.events.flat()).toEqual([]);
  });
});


describe('ai-last-seen moment specifics', () => {
  const DEF = MOMENTS['ai-last-seen'];
  const deg = (r: number) => (r * 180) / Math.PI;
  // MEASURED on this fixture (throwaway vite-node probe, moments.ts's own comment): the
  // last tick the AI can see the player, and the first it cannot. Derived here rather
  // than hardcoded so a geometry change reds the assertions below with a real reason
  // instead of silently re-anchoring them.
  /**
   * The run of consecutive ticks on which the turret sits exactly on `bearing`. Derived
   * rather than hardcoded so an unrelated change to how fast a turret slews moves the
   * plateau's start without reddening every assertion about its meaning.
   */
  function plateau(tl: ReturnType<typeof simulateMoment>, bearing: number) {
    const on = (t: number) => Math.abs(tl.worlds[t].tanks[0].turretAngle - bearing) < 1e-9;
    let best = { start: 0, end: -1 };
    let run = -1;
    for (let t = 1; t <= DEF.ticks; t++) {
      if (on(t)) { if (run < 0) run = t; if (t - run > best.end - best.start) best = { start: run, end: t }; }
      else run = -1;
    }
    return best;
  }

  function sightBreak(tl: ReturnType<typeof simulateMoment>): number {
    for (let t = 1; t <= DEF.ticks; t++) {
      const w = tl.worlds[t];
      if (!lineOfSight(w.tanks[0].pos, w.tanks[1].pos, w.walls)) return t;
    }
    throw new Error('sight never breaks -- this moment has nothing to show');
  }

  it('loses sight at tick 29 and never regains it, which is what the rest of the clip is about', () => {
    const tl = simulateMoment(DEF);
    expect(sightBreak(tl)).toBe(29);
    // Negative control: widening the wall gap (LAST_SEEN_WALL.aabb.minX past the
    // sightline, e.g. 1.5) pushes this break later and reds the tick; shortening the
    // slab's maxX to 1.0 lets sight come back mid-clip and reds the loop below --
    // verified live and reverted.
    for (let t = 29; t <= DEF.ticks; t++) {
      const w = tl.worlds[t];
      expect(lineOfSight(w.tanks[0].pos, w.tanks[1].pos, w.walls)).toBe(false);
    }
  });

  it('holds the bearing to the position it LAST OBSERVED, while the player moves somewhere else', () => {
    const tl = simulateMoment(DEF);
    const brk = sightBreak(tl);
    const observed = tl.worlds[brk - 1].tanks[1].pos;
    const bearing = Math.atan2(observed.y, observed.x);
    const { start, end } = plateau(tl, bearing);
    // MEASURED: 46..118, 73 ticks. Deliberately NOT written as `for (t = 46; ...)`.
    // ai-tracking's comment records what an exact per-tick trajectory costs here -- three
    // separate unrelated AI changes (a deadband, an aim hold, turret acceleration) each
    // moved the tick a turret arrives on its target, and a hardcoded arrival tick makes
    // whichever lands next break main for a reason that has nothing to do with memory.
    // The plateau is therefore DERIVED and bounded: it must run to the tick before the
    // span expires, must start promptly, and must be long.
    expect(end).toBe(brk + AI_LAST_SEEN_TICKS - 1);
    expect(start).toBeLessThanOrEqual(brk + 25);
    expect(end - start + 1).toBeGreaterThanOrEqual(60);
    // Not vacuous, in the two ways it could be. The player MOVES across the same span
    // (a frozen target would let a tracking turret sit still too)...
    const xs = Array.from({ length: end - start + 1 }, (_, i) => tl.worlds[start + i].tanks[1].pos.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.1);
    // ...and once the player has reached its patrol band the held bearing is never the
    // bearing to where the player actually is, so no frame there can be read as the
    // turret being on target by coincidence. MEASURED: 15.83deg to 32.21deg.
    //
    // The plateau's OPENING ticks are excluded deliberately, and the window is counted
    // back from the end so that exclusion does not depend on when the turret arrives.
    // Right after sight breaks the player is still next to the point it was last seen
    // at, so a small separation there is geometry, not omniscience -- and pinning the
    // opening re-coupled this to the slew rate, which is how removing turret
    // acceleration reddened this line at 12.54deg while nothing about memory changed.
    for (let t = Math.max(start, end - 59); t <= end; t++) {
      const p = tl.worlds[t].tanks[1].pos;
      expect(Math.abs(deg(bearing) - deg(Math.atan2(p.y, p.x)))).toBeGreaterThan(15);
    }
    // And the remembered POINT is the observed one, not a live handle on the target:
    // storing the Tank rather than a copy would make these two equal at every tick.
    for (let t = brk; t <= end; t++) {
      const ai = tl.worlds[t].tanks[0];
      expect(ai.aiLastSeenPos).toEqual({ x: observed.x, y: observed.y });
      if (t > 60) expect(ai.aiLastSeenPos).not.toEqual(tl.worlds[t].tanks[1].pos);
    }
  });

  it('gives up after exactly AI_LAST_SEEN_TICKS and hands off to the search sweep', () => {
    const tl = simulateMoment(DEF);
    const brk = sightBreak(tl);
    const zero = tl.worlds.findIndex((w, t) => t >= brk && (w.tanks[0].aiLastSeenTicks ?? 0) === 0);
    // Derived from the constant, so re-tuning AI_LAST_SEEN_TICKS moves this with it
    // rather than reddening a hardcoded 119.
    expect(zero).toBe(brk + AI_LAST_SEEN_TICKS);
    // The handoff is VISIBLE, not just bookkeeping. Stated as "still, then moving"
    // rather than "the angle changed": with memoryAim dropped from stepAi's chain the
    // turret is already sweeping before expiry, so a bare `not.toBe` passes on exactly
    // the tree this moment exists to distinguish -- checked, and it did.
    const travel = (a: number, b: number) => {
      let sum = 0;
      for (let t = a + 1; t <= b; t++) {
        sum += Math.abs(tl.worlds[t].tanks[0].turretAngle - tl.worlds[t - 1].tanks[0].turretAngle);
      }
      return sum;
    };
    expect(travel(Math.min(60, zero - 40), zero - 1)).toBe(0);
    expect(travel(zero, zero + 20)).toBeGreaterThan(0.1);
  });

  it('the plateau is caused by the memory, not by the geometry', () => {
    // The negative control this moment exists to survive, run as a test rather than
    // described in a comment -- `ai-tracking` was authored against a knob that turned
    // out to be inert (46 of its 47 frames byte-identical across the sweep), and this
    // is what would catch the same mistake here.
    //
    // Same fixture, same inputs, memory suppressed after every step so the aim chain
    // falls through to searchAim. Deleting memoryAim from stepAi's chain would make the
    // two arms identical and red both bounds below.
    let w = DEF.build();
    const suppressed: number[] = [];
    for (let t = 0; t < DEF.ticks; t++) {
      w = step(w, DEF.input(t)).world;
      w.tanks[0].aiLastSeenTicks = 0;
      w.tanks[0].aiLastSeenPos = undefined;
      suppressed.push(w.tanks[0].turretAngle);
    }
    const longestFlat = (xs: number[]) => {
      let best = 1, cur = 1;
      for (let i = 1; i < xs.length; i++) { cur = xs[i] === xs[i - 1] ? cur + 1 : 1; if (cur > best) best = cur; }
      return best;
    };
    const live = simulateMoment(DEF).worlds.slice(1).map((x) => x.tanks[0].turretAngle);
    // MEASURED: 73 live against 21 suppressed. Stated as a ratio and a floor rather than
    // as `toBe(73)`, for the reason the plateau test above gives at length: the exact
    // length depends on how fast a turret slews, which is not what this test is about.
    // The suppressed arm is NOT motionless either -- a drawn search heading can be
    // reached and then held for the rest of its AI_SEARCH_HOLD_TICKS window -- so the
    // discriminating property is the contrast, not stillness.
    expect(longestFlat(live)).toBeGreaterThanOrEqual(60);
    expect(longestFlat(live)).toBeGreaterThan(2 * longestFlat(suppressed));
    expect(Math.max(...live.map((v, i) => Math.abs(deg(v) - deg(suppressed[i]))))).toBeGreaterThan(60);
  });

  it('never fires: sight breaks 19 ticks before brown could arm a shot', () => {
    // brown's gate needs aimTicks >= 48 (STATIC_BASIC's 0.8s reaction) and its first
    // firing OPPORTUNITY past it is tick 50 -- ai-tracking's comment derives both. Sight
    // breaks at 29 here, which resets aimTicks before the gate can close. Negative
    // control: MEASURED on the ai-tracking fixture, whose sight never breaks -- extending
    // it to 55 ticks fires at tick 50.
    expect(simulateMoment(DEF).events.flat()).toEqual([]);
  });
});


describe('ai-commitment moment specifics', () => {
  const DEF = MOMENTS['ai-commitment'];
  const deg = (r: number) => (r * 180) / Math.PI;
  const ais = (w: World) => [w.tanks[0], w.tanks[1]];

  it('each AI commits to a DIFFERENT opponent, and neither changes for the whole clip', () => {
    const tl = simulateMoment(DEF);
    const [a0, b0] = ais(tl.worlds[1]);
    // Distribution: not the same opponent. `rangeCost` ranks by distance from
    // preferredDistance (10), and the fixture is built so each AI's own-side player is
    // 12 away and the far one 13.4 -- see moments.ts. An equidistant fixture makes both
    // AIs pick the same player, which is what the first draft did.
    expect(a0.aiTargetId).not.toBe(b0.aiTargetId);
    expect(new Set([a0.aiTargetId, b0.aiTargetId])).toEqual(new Set([3, 4]));
    // Stickiness: held for every tick, across a crossing that reverses which player is
    // on which side. Dropping the commitment span makes these retarget mid-clip.
    for (let t = 1; t <= DEF.ticks; t++) {
      const [a, b] = ais(tl.worlds[t]);
      expect(a.aiTargetId, `tank 1 at tick ${t}`).toBe(a0.aiTargetId);
      expect(b.aiTargetId, `tank 2 at tick ${t}`).toBe(b0.aiTargetId);
    }
  });

  it('the players really do cross, so the held target is not held by default', () => {
    // Without this the test above passes on a fixture where nothing moves and there was
    // never anything to retarget TO.
    const start = simulateMoment(DEF).worlds[1];
    const end = simulateMoment(DEF).worlds[DEF.ticks];
    const p1 = (w: World) => w.tanks[2].pos.x;
    const p2 = (w: World) => w.tanks[3].pos.x;
    expect(p1(start)).toBeLessThan(p2(start));
    expect(p1(end)).toBeGreaterThan(p2(end)); // they have swapped sides
    expect(Math.abs(p1(end) - p1(start))).toBeGreaterThan(5);
  });

  it('the turrets sweep APART as their targets cross, which is what makes it readable', () => {
    // The artefact itself. Two AIs retargeting per-tick would converge on whichever
    // opponent was momentarily better placed; holding separate targets through a crossing
    // drives them apart. MEASURED: 16.4deg apart at tick 1, 121.2deg at tick 178.
    const tl = simulateMoment(DEF);
    const gap = (t: number) => {
      const [a, b] = ais(tl.worlds[t]);
      return Math.abs(deg(a.turretAngle) - deg(b.turretAngle));
    };
    expect(gap(1)).toBeLessThan(30);
    expect(gap(DEF.ticks)).toBeGreaterThan(100);
    expect(gap(DEF.ticks) - gap(1)).toBeGreaterThan(80);
  });

  it('both AI hulls hold station, so every pixel of motion is turret or player', () => {
    // Brown hardcodes desiredMove {0,0} (brown.ts). Swapping either index for a PLAYER
    // (tanks[2] or tanks[3], which do drive) fails this immediately.
    const tl = simulateMoment(DEF);
    for (let t = 1; t <= DEF.ticks; t++) {
      for (const ai of ais(tl.worlds[t])) {
        expect(ai.pos.x === -3 || ai.pos.x === 3).toBe(true);
        expect(ai.pos.y).toBe(0);
        expect(ai.bodyAngle).toBe(0);
      }
    }
  });

  it('nobody dies inside the clip, so no respawn moves a tank mid-measurement', () => {
    // 178 is chosen for this: MEASURED, the first tank-destroyed is tick 182, from a
    // shell fired at 170/174. A death would reset the victim's position AND
    // roundStartTick, corrupting every assertion above it.
    const tl = simulateMoment(DEF);
    expect(tl.events.flat().map((e) => e.type).filter((t) => t !== 'fire')).toEqual([]);
  });
});
