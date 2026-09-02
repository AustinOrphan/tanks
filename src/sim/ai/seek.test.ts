import { describe, it, expect } from 'vitest';
import { resolveWorldRules } from '../rules';
import { seekMove, wanderMove } from './targeting';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { configFor } from '../config';
import type { ResolvedTankConfig } from '../config';
import { WANDER_TICKS } from '../constants';
import type { Tank, Vec2, Wall } from '../types';
import { vdot, vlen, vnorm, vsub } from '../types';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// The distance-band movement layer: preferredDistance, minimumDistance and
// retreatChance made real. Unit tests on seekMove's geometry, then decision-
// level tests through the injectable cfg proving the fields are consumed where
// gameplay actually reads them. Mutation-proven: reverting the grey/teal call
// sites to bare wanderMove kills the decision tests below.
// ---------------------------------------------------------------------------

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function world(tanks: Tank[], over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: -100000,
    rules: resolveWorldRules(), ...over,
  };
}
function withAi(base: ResolvedTankConfig, over: Partial<ResolvedTankConfig['ai']>): ResolvedTankConfig {
  return { ...base, ai: { ...base.ai, ...over } };
}
/** Component of `dir` along the unit vector from `from` toward `to`. */
function towardness(dir: Vec2, from: Vec2, to: Vec2): number {
  return vdot(dir, vnorm(vsub(to, from)));
}
const GREY = configFor('grey'); // band 9/6, retreatChance 0.75

describe('seekMove geometry', () => {
  it('beyond preferredDistance: heading gains a dominant toward-player component', () => {
    // Grey at 15 units, band 9/6: must approach. The wander blend caps how
    // aligned the heading can be, but the toward component must dominate --
    // with bias 0.5 the worst case is cos(large wander angle) yet the blend
    // still points broadly at the player. Assert > 0 strictly and that it beats
    // pure wander's towardness for the same tick (the layer must ADD approach).
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 15, y: 0 });
    const w = world([grey, player]);
    const dir = seekMove(w, grey, GREY);
    expect(vlen(dir)).toBeCloseTo(1, 9);
    expect(towardness(dir, grey.pos, player.pos)).toBeGreaterThan(0);
    expect(towardness(dir, grey.pos, player.pos))
      .toBeGreaterThan(towardness(wanderMove(w, grey), grey.pos, player.pos));
  });

  it('inside minimumDistance with retreatChance 1: heading points away', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 3, y: 0 }); // 3 < min 6
    const w = world([grey, player]);
    const dir = seekMove(w, grey, withAi(GREY, { retreatChance: 1 }));
    expect(towardness(dir, grey.pos, player.pos)).toBeLessThan(0);
  });

  it('inside minimumDistance with retreatChance 0: never retreats -- plain wander', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 3, y: 0 });
    const w = world([grey, player]);
    expect(seekMove(w, grey, withAi(GREY, { retreatChance: 0 }))).toEqual(wanderMove(w, grey));
  });

  it("the retreat draw consumes retreatChance's MAGNITUDE at the documented rate", () => {
    // Across 400 draw windows, the fraction of windows where the tank actually
    // retreats (returns something other than the hold-ground wander) must track
    // the chance value -- the assertion that separates consuming the MAGNITUDE
    // from consuming the sign. The discriminator is exact: a failed draw returns
    // wanderMove verbatim; a passed draw returns the away-blend, which differs.
    // (First draft counted towardness < 0, but plain wander points away half
    // the time -- a wrong-by-construction denominator that measured 0.65 at
    // chance 0.25.) Bounds +/-0.12; a sign-only gate (fraction 1.0) or an
    // ignored field (0.0) lands far outside them.
    for (const chance of [0.25, 0.75]) {
      let retreats = 0;
      const windows = 400;
      for (let i = 0; i < windows; i++) {
        const grey = tank(1, 'grey', { x: 0, y: 0 });
        const player = tank(2, 'player', { x: 3, y: 0 });
        const w = world([grey, player], { tick: i * WANDER_TICKS });
        const dir = seekMove(w, grey, withAi(GREY, { retreatChance: chance }));
        const held = wanderMove(w, grey);
        if (dir.x !== held.x || dir.y !== held.y) retreats++;
      }
      expect(retreats / windows).toBeGreaterThan(chance - 0.12);
      expect(retreats / windows).toBeLessThan(chance + 0.12);
    }
  });

  it('inside the band, and with no live player: exactly wanderMove', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const inBand = world([grey, tank(2, 'player', { x: 7.5, y: 0 })]); // 6 < 7.5 < 9
    expect(seekMove(inBand, grey, GREY)).toEqual(wanderMove(inBand, grey));
    const dead = world([grey, tank(2, 'player', { x: 20, y: 0 }, { alive: false })]);
    expect(seekMove(dead, grey, GREY)).toEqual(wanderMove(dead, grey));
  });

  it('a seek direction into a wall falls back to wander (never a zero-displacement step)', () => {
    // Player far to the +x; a wall flush against grey's nose in that direction.
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 15, y: 0 });
    // Nose flush against the wall -- the exact degenerate case the docstring
    // names: one movementSpeed*DT step along the seek direction lands the hull
    // inside it (probe reach = step 0.05 + TANK_RADIUS 0.5 > the 0.5 gap).
    const wall: Wall = { id: 9, aabb: { minX: 0.5, minY: -2, maxX: 2.5, maxY: 2 }, kind: 'solid', destroyed: false };
    const w = world([grey, player], { walls: [wall] });
    const dir = seekMove(w, grey, GREY);
    expect(dir).toEqual(wanderMove(w, grey));
  });

  it('is deterministic: same world state, same answer, call after call', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 15, y: 0 });
    const w = world([grey, player]);
    expect(seekMove(w, grey, GREY)).toEqual(seekMove(w, grey, GREY));
  });

  it('the retreat draw is uncorrelated with the wander heading, OBSERVED through seekMove', () => {
    // Review killed the first version of this test: it restated the recipe on
    // literals without calling seekMove, so reverting the draw's prime to the
    // wander stream's (* 1000) left it green -- the exact correlation it warned
    // about. This version observes the property through the public function: if
    // the draw reused the wander stream, then at chance 0.5 "retreated this
    // window" would EQUAL "wander heading in the lower half-circle" for every
    // window (both are `value < 0.5` of the same rng), agreement 1.0. With the
    // fresh prime the measured agreement over these 400 seeded windows is
    // 0.5175. The 0.75 ceiling fails the collision and passes the real stream
    // with wide margin; the 0.25 floor kills a hypothetical anti-correlated
    // stream too.
    let agree = 0;
    const windows = 400;
    for (let i = 0; i < windows; i++) {
      const grey = tank(1, 'grey', { x: 0, y: 0 });
      const player = tank(2, 'player', { x: 3, y: 0 });
      const w = world([grey, player], { tick: i * WANDER_TICKS });
      const dir = seekMove(w, grey, withAi(GREY, { retreatChance: 0.5 }));
      const held = wanderMove(w, grey);
      const retreated = dir.x !== held.x || dir.y !== held.y;
      // wander value < 0.5 <=> its heading's atan2 >= 0 (verified numerically
      // for this exact stream while writing the test).
      const headingLow = Math.atan2(held.y, held.x) >= 0;
      if (retreated === headingLow) agree++;
    }
    expect(agree / windows).toBeLessThan(0.75);
    expect(agree / windows).toBeGreaterThan(0.25);
  });
});

describe('the decisions consume the band through their cfg', () => {
  it('grey approaches a too-distant player (the call site is live, not wander)', () => {
    // Mutation-proven: reverting grey.ts's move line to `avoid ?? wanderMove(...)`
    // fails this -- at this seed/tick the wander heading points broadly AWAY.
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 15, y: 0 });
    const w = world([grey, player]);
    const d = greyDecision(w, grey);
    expect(d.desiredMove).toEqual(seekMove(w, grey, GREY));
    expect(towardness(d.desiredMove, grey.pos, player.pos)).toBeGreaterThan(0);
  });

  it('teal likewise, through its own band (7.5/4)', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 14, y: 0 });
    const w = world([teal, player]);
    const d = tealDecision(w, teal);
    expect(d.desiredMove).toEqual(seekMove(w, teal, configFor('teal')));
  });

  it('an injected band flips the SAME fixture from approach to retreat', () => {
    // The field-consumption proof at the decision level: nothing but ai.preferred/
    // minimum/retreatChance differs between the two calls.
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 7, y: 0 });
    const w = world([grey, player]);
    const far = greyDecision(w, grey, withAi(GREY, { preferredDistance: 5, minimumDistance: 1 }));
    expect(towardness(far.desiredMove, grey.pos, player.pos)).toBeGreaterThan(0);
    const crowded = greyDecision(w, grey, withAi(GREY, { preferredDistance: 30, minimumDistance: 29, retreatChance: 1 }));
    expect(towardness(crowded.desiredMove, grey.pos, player.pos)).toBeLessThan(0);
  });

  it("the DEFAULT cfg is the tank's own kind: grey holds in ITS band where teal's would approach", () => {
    // d = 8 sits inside grey's band (9/6, wander) but beyond teal's preferred
    // (7.5, approach) -- the one region where the two kinds' bands disagree on
    // this axis. Review: without this, swapping greyDecision's default to
    // configFor('teal') survived every seek test (both default-cfg fixtures sat
    // where ALL bands approach).
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 8, y: 0 });
    const w = world([grey, player]);
    expect(greyDecision(w, grey).desiredMove).toEqual(wanderMove(w, grey));
  });

  it('dodging still outranks seeking: a threat bullet overrides the approach', () => {
    // The precedence the design doc promises (avoid ?? seek): same far-player
    // fixture plus a bullet bearing down -- the move must be the dodge, not the
    // approach (assert it matches neither seek nor wander).
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 15, y: 0 });
    const threat = { id: 9, ownerId: 2, type: 'normal' as const, pos: { x: -1, y: 0 }, vel: { x: 5, y: 0 }, bouncesLeft: 1, alive: true };
    const w = world([grey, player], { bullets: [threat] });
    const d = greyDecision(w, grey);
    expect(d.desiredMove).not.toEqual(seekMove(w, grey, GREY));
    expect(Math.abs(vdot(d.desiredMove, vnorm(threat.vel)))).toBeLessThan(0.5); // broadly lateral to the shot
  });
});
