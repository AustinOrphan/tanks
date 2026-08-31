import { describe, it, expect } from 'vitest';
import { brownDecision } from './brown';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { aimLead, profileAimSpread, profileHazardSpread, dangerAvoidMove, mineThreatensPlayer } from './targeting';
import { AI_AIM_SPREAD, AI_HAZARD_SPREAD } from '../constants';
import { configFor } from '../config';
import type { ResolvedTankConfig } from '../config';
import type { Tank, Vec2, Bullet, Wall } from '../types';
import { vdist } from '../types';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// CONFIG-CONSUMPTION tests: each one injects a variant ResolvedTankConfig via
// the decision functions' cfg parameter and asserts behaviour actually changes.
// This is what separates "the config is consumed" from "the config is carried":
// every test here fails if its field stops being read (verified by mutation --
// reverting each consumption to its old hardcoded form kills the matching test).
// The consumptions covered here: grey's aggression-derived patience, teal's
// direct/bank weight gates, BOTH mine-inclination gates (grey and teal),
// cfg.mineCapacity, and brown's cfg.weapon. The `behavior` routing consumption
// lives in decideAi and cannot be reached by injection (configFor is
// module-resolved there); its guards are the roster.test behaviour pins plus
// dispatch.test's per-kind expectations, which fail together if a roster
// profile is swapped.
//
// Each variant is paired with a same-fixture default-cfg control, so a fixture
// drift that breaks the baseline cannot leave the variant assertion passing
// vacuously.
// ---------------------------------------------------------------------------

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks: [], bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: -100000,
    unarmedTrigger: 'none' as const, corpseBlocksShells: false, muzzleClearsTanks: true, coopAttempts: true, mode: 'campaign-coop', friendlyFire: false, ...over,
  };
}
/** A cfg whose ai block is the shipped one with the given fields overridden. */
function withAi(base: ResolvedTankConfig, over: Partial<ResolvedTankConfig['ai']>): ResolvedTankConfig {
  return { ...base, ai: { ...base.ai, ...over } };
}

describe('aggression drives dodge patience (greyDecision)', () => {
  // The dispatch.test regression fixture: a threat bullet parked in grey's danger
  // corridor, clear LOS to a far player -- a firing solution exists but the shipped
  // profile (aggression 0.25 -> 45 ticks patience) suppresses it on the first tick.
  const fixture = () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 20, y: 0 });
    const threat: Bullet = {
      id: 999, ownerId: 2, type: 'normal', pos: { x: -1, y: 0 }, vel: { x: 5, y: 0 },
      bouncesLeft: 1, alive: true,
    };
    return { grey, w: world({ tanks: [grey, player], bullets: [threat] }) };
  };

  it('control: the shipped profile suppresses fire on the first dodge tick', () => {
    const { grey, w } = fixture();
    const d = greyDecision(w, grey);
    expect(d.fire).toBe(false);
    expect(d.nextTimer).toBe(1); // the patience counter is running
  });

  it('aggression 1.0 -> zero patience: fires immediately under the same threat', () => {
    const { grey, w } = fixture();
    const d = greyDecision(w, grey, withAi(configFor('grey'), { aggression: 1 }));
    expect(d.fire).toBe(true);
  });
});

describe('shot-type weights gate what teal attempts (tealDecision)', () => {
  // Bank-only geometry, verbatim from teal.test: a blocker kills the direct line,
  // a top wall affords a pi/4 bank via the bounce point (2,2).
  const bankFixture = () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)];
    return { teal, w: world({ tanks: [teal, player], walls }) };
  };
  // Direct-only geometry: clear LOS, no walls at all, so no bank can exist.
  const directFixture = () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    return { teal, w: world({ tanks: [teal, player] }) };
  };

  it('control: both fixtures produce a shot under the shipped profile', () => {
    const bank = bankFixture();
    expect(tealDecision(bank.w, bank.teal).fire).toBe(true);
    const direct = directFixture();
    expect(tealDecision(direct.w, direct.teal).fire).toBe(true);
  });

  it('bankShotWeight 0 deletes the bank shot: same geometry, no fire', () => {
    const { teal, w } = bankFixture();
    const d = tealDecision(w, teal, withAi(configFor('teal'), { bankShotWeight: 0 }));
    expect(d.fire).toBe(false);
    // `hasSolution`, not `nextState`, is the discriminator now. This fixture hides the
    // player behind cover, and since issue #359 a profile that cannot bank cannot PERCEIVE
    // an opponent it has no line to -- so teal reaches its no-target branch ('idle') rather
    // than its repositioning one. Both mean "no fire" here; hasSolution states the reason
    // directly and does not move if that branch is relabelled.
    expect(d.hasSolution).toBe(false);
    // It keeps roaming either way: the no-target branch is not a freeze.
    expect(d.desiredMove).not.toEqual({ x: 0, y: 0 });
  });

  it('directShotWeight 0 deletes the direct shot: clear LOS, no fire', () => {
    const { teal, w } = directFixture();
    const d = tealDecision(w, teal, withAi(configFor('teal'), { directShotWeight: 0 }));
    expect(d.fire).toBe(false);
  });
});

describe('minePlacementChance gates mine proposals -- by MAGNITUDE since the draw', () => {
  // The player inside tactical mine range, no dodge, cooldown ready: the shipped
  // grey profile proposes a mine here (control -- the fixture's draw, seed 5 id 1
  // bucket 0 = 0.0444, passes every shipped chance), a chance-less profile must
  // not. The magnitude's rate is pinned separately below.
  const fixture = () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 3, y: 0 });
    return { grey, w: world({ tanks: [grey, player] }) };
  };

  it('control: the shipped profile proposes a mine', () => {
    const { grey, w } = fixture();
    expect(greyDecision(w, grey).mine).toBe(true);
  });

  it('minePlacementChance undefined -> no proposal, same fixture', () => {
    const { grey, w } = fixture();
    const d = greyDecision(w, grey, withAi(configFor('grey'), { minePlacementChance: undefined }));
    expect(d.mine).toBe(false);
  });

  it("teal's gate is the same consumption, not a copy that could rot separately", () => {
    // Player inside tactical mine range of a roaming teal; control proposes.
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 3, y: 0 });
    const w = world({ tanks: [teal, player] });
    expect(tealDecision(w, teal).mine).toBe(true);
    const d = tealDecision(w, teal, withAi(configFor('teal'), { minePlacementChance: undefined }));
    expect(d.mine).toBe(false);
  });
});

describe('mineCapacity bounds proposals (grey)', () => {
  it('capacity 0 -> no proposal from the fixture whose control proposes', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 3, y: 0 });
    const w = world({ tanks: [grey, player] });
    expect(greyDecision(w, grey).mine).toBe(true); // control
    const d = greyDecision(w, grey, { ...configFor('grey'), mineCapacity: 0 });
    expect(d.mine).toBe(false);
  });
});

describe('brown consumes cfg.weapon (not a hardcoded shell type)', () => {
  it('an injected fast weapon changes the decision fireType; control stays normal', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world({ tanks: [brown, player] });
    expect(brownDecision(w, brown).fireType).toBe('normal'); // control
    const base = configFor('brown');
    const d = brownDecision(w, brown, { ...base, weapon: { ...base.weapon, bulletType: 'fast' } });
    expect(d.fireType).toBe('fast');
  });
});

describe('aimAccuracy scales the jitter from the AI_AIM_SPREAD anchor', () => {
  it('profileAimSpread: accuracy 1.0 IS the anchor; lower accuracy widens by 1/accuracy', () => {
    expect(profileAimSpread(withAi(configFor('grey'), { aimAccuracy: 1 }))).toBe(AI_AIM_SPREAD);
    expect(profileAimSpread(withAi(configFor('grey'), { aimAccuracy: 0.5 }))).toBeCloseTo(AI_AIM_SPREAD * 2, 12);
  });

  it('observed through greyDecision: a low-accuracy cfg jitters beyond the anchor; a perfect one never does', () => {
    // Max |deviation from the pure intercept| across 200 jitter re-roll windows.
    // Under the old uniform code (every call site passing AI_AIM_SPREAD) the
    // low-accuracy max stays <= the anchor and this test FAILS -- proven by
    // mutation before commit. The perfect-accuracy bound doubles as the
    // anchor's meaning: accuracy 1.0 reproduces the pre-pass jitter exactly.
    const maxDev = (accuracy: number): number => {
      let max = 0;
      for (let i = 0; i < 200; i++) {
        const grey = tank(1, 'grey', { x: 0, y: 0 });
        const player = tank(2, 'player', { x: 20, y: 0 });
        const w = world({ tanks: [grey, player], tick: i * 20 }); // AI_JITTER_TICKS re-roll windows
        const d = greyDecision(w, grey, withAi(configFor('grey'), { aimAccuracy: accuracy }));
        const pure = aimLead(grey.pos, player.pos, { x: 0, y: 0 }, configFor('grey').weapon.speed);
        max = Math.max(max, Math.abs(d.turretAngle - pure));
      }
      return max;
    };
    expect(maxDev(1)).toBeLessThanOrEqual(AI_AIM_SPREAD + 1e-12);
    expect(maxDev(0.4)).toBeGreaterThan(AI_AIM_SPREAD * 1.5); // 2.5x spread; max draw comfortably exceeds 1.5x
    expect(maxDev(0.4)).toBeLessThanOrEqual(AI_AIM_SPREAD / 0.4 + 1e-12);
  });
});

describe("minePlacementChance's MAGNITUDE is the proposal rate per draw bucket", () => {
  it('proposal fraction tracks the chance across 400 draw buckets (0.3 and 0.8)', () => {
    // The assertion that separates the draw from the old sign gate: a sign gate
    // proposes in 100% of eligible windows regardless of magnitude and lands far
    // outside these bounds -- proven by mutation (reverting grey's gate to
    // `(chance ?? 0) > 0` fails this at fraction 1.0).
    for (const chance of [0.3, 0.8]) {
      let proposals = 0;
      const windows = 400;
      for (let i = 0; i < windows; i++) {
        const grey = tank(1, 'grey', { x: 0, y: 0 });
        const player = tank(2, 'player', { x: 3, y: 0 });
        const w = world({ tanks: [grey, player], tick: i * 30 }); // WANDER_TICKS windows
        const d = greyDecision(w, grey, withAi(configFor('grey'), { minePlacementChance: chance }));
        if (d.mine) proposals++;
      }
      expect(proposals / windows).toBeGreaterThan(chance - 0.12);
      expect(proposals / windows).toBeLessThan(chance + 0.12);
    }
  });

  it("teal's draw is pinned too: fraction tracks the chance through tealDecision", () => {
    // Review: with the rate pinned only through greyDecision, reverting TEAL's
    // gate to sign-only left the whole suite green. Same loop, teal's decision.
    let proposals = 0;
    const windows = 400;
    for (let i = 0; i < windows; i++) {
      const teal = tank(1, 'teal', { x: 0, y: 0 });
      const player = tank(2, 'player', { x: 3, y: 0 });
      const w = world({ tanks: [teal, player], tick: i * 30 });
      if (tealDecision(w, teal, withAi(configFor('teal'), { minePlacementChance: 0.3 })).mine) proposals++;
    }
    expect(proposals / windows).toBeGreaterThan(0.3 - 0.12);
    expect(proposals / windows).toBeLessThan(0.3 + 0.12);
  });

  it('chance 1 proposes in every eligible bucket; chance 0 in none', () => {
    let always = 0, never = 0;
    for (let i = 0; i < 50; i++) {
      const grey = tank(1, 'grey', { x: 0, y: 0 });
      const player = tank(2, 'player', { x: 3, y: 0 });
      const w = world({ tanks: [grey, player], tick: i * 30 });
      if (greyDecision(w, grey, withAi(configFor('grey'), { minePlacementChance: 1 })).mine) always++;
      if (greyDecision(w, grey, withAi(configFor('grey'), { minePlacementChance: 0 })).mine) never++;
    }
    expect(always).toBe(50);
    expect(never).toBe(0);
  });
});

describe('estimationAccuracy scales the perceived hazard radius from the AI_HAZARD_SPREAD anchor (directive B)', () => {
  it('profileHazardSpread: accuracy 1.0 IS the anchor; lower accuracy widens by 1/accuracy', () => {
    expect(profileHazardSpread(withAi(configFor('grey'), { estimationAccuracy: 1 }))).toBe(AI_HAZARD_SPREAD);
    expect(profileHazardSpread(withAi(configFor('grey'), { estimationAccuracy: 0.5 })))
      .toBeCloseTo(AI_HAZARD_SPREAD * 2, 12);
  });

  // ---------------------------------------------------------------------------
  // RED-FIRST (directive B, "sometimes fatal"): a specific seeded draw perturbs the
  // PERCEIVED radius past the trigger threshold, in both directions. Both fixtures use
  // AI_HAZARD_PRIME=5303 draws hand-derived the same way targeting.test.ts's
  // estimationError pin is: nextRng(world.seed + tank.id*5303 + floor(tick/WANDER_TICKS)).
  //
  // UNDER-estimation (id=6, seed=1, tick=0 -> bucket 0): nextRng(1 + 6*5303 + 0).value =
  // nextRng(31819).value = 0.013678029412403703, a near-minimal draw. At the injected
  // estimationAccuracy 0.3 (spread = AI_HAZARD_SPREAD/0.3 = 1.333...), offset =
  // (0.013678029412403703*2-1) * 1.333... = -1.2968585882253238 -- perceived
  // AI_MINE_FLEE_RADIUS shrinks from 3.25 to 1.9531414117746762.
  //
  // OVER-estimation (id=5, seed=1, tick=150 -> bucket 5): nextRng(1 + 5*5303 + 5).value =
  // nextRng(26521).value = 0.9985110608395189, a near-maximal draw. Same spread, offset =
  // (0.9985110608395189*2-1) * 1.333... = 1.3296281477860251 -- perceived flee radius
  // widens from 3.25 to 4.579628147786025.
  //
  // Both were verified to actually kill the OLD (unperturbed) code before being written:
  // against `dangerAvoidMove(w, t)` called with no radius arguments (today's exact
  // constant, the behaviour before this wiring existed), the fatal fixture's mine at 2.4
  // IS fled (dangerAvoidMove returns non-null) and the over-reaction fixture's mine at 4.0
  // is NOT fled (returns null) -- the opposite of what the wired greyDecision/tealDecision
  // now produce below.
  // ---------------------------------------------------------------------------

  it('UNDER-estimation: the tank does not dodge a mine sitting inside its own actual kill radius -- the DECISION half of "sometimes fatal" (death itself is not simulated here)', () => {
    const grey = tank(6, 'grey', { x: 0, y: 0 });
    const cfg = withAi(configFor('grey'), { estimationAccuracy: 0.3 });
    const m = { id: 70, ownerId: 6, pos: { x: 2.4, y: 0 }, timer: 3, armed: true, detonated: false };
    const w = world({ seed: 1, tick: 0, tanks: [grey], mines: [m] });

    // Ground the "fatal" claim: this mine is inside the tank's TRUE lethal blast radius
    // (MINE_BLAST_RADIUS + TANK_RADIUS = 2.5) right now, not merely inside the flee margin.
    expect(vdist(grey.pos, m.pos)).toBeLessThanOrEqual(2.5);
    // And the TRUE (unperturbed) radius would flee it -- proves the old code caught this.
    expect(dangerAvoidMove(w, grey)).not.toBeNull();

    const d = greyDecision(w, grey, cfg);
    // desiredMove is the undodging seek/wander baseline (grey has no player in this
    // fixture, so seekMove reduces to wanderMove), not the escape vector (-1, 0) that
    // fleeing this mine would produce.
    expect(d.desiredMove.x).not.toBeCloseTo(-1, 3);
  });

  it("UNDER-estimation is the same consumption through tealDecision, not a copy that could rot separately", () => {
    const teal = tank(6, 'teal', { x: 0, y: 0 });
    const cfg = withAi(configFor('teal'), { estimationAccuracy: 0.3 });
    const m = { id: 70, ownerId: 6, pos: { x: 2.4, y: 0 }, timer: 3, armed: true, detonated: false };
    const w = world({ seed: 1, tick: 0, tanks: [teal], mines: [m] });
    expect(dangerAvoidMove(w, teal)).not.toBeNull(); // control: true radius flees
    const d = tealDecision(w, teal, cfg);
    expect(d.desiredMove.x).not.toBeCloseTo(-1, 3);
  });

  it('OVER-estimation: the tank dodges a mine the TRUE radius says is safe (wasted caution, not merely cosmetic scatter)', () => {
    const grey = tank(5, 'grey', { x: 0, y: 0 });
    const cfg = withAi(configFor('grey'), { estimationAccuracy: 0.3 });
    const m = { id: 71, ownerId: 5, pos: { x: 4, y: 0 }, timer: 3, armed: true, detonated: false };
    const w = world({ seed: 1, tick: 150, tanks: [grey], mines: [m] });

    // The TRUE radius (3.25) does not reach this mine -- proves the old code ignored it.
    expect(dangerAvoidMove(w, grey)).toBeNull();

    const d = greyDecision(w, grey, cfg);
    // desiredMove IS the escape vector away from (4, 0): straight along -x.
    expect(d.desiredMove.x).toBeCloseTo(-1, 3);
    expect(d.desiredMove.y).toBeCloseTo(0, 3);
  });
});

describe('mineThreatensPlayer/friendlyInMineBlast wiring: the OFFENSE side of estimation error', () => {
  it("grey's mine-threat gate uses the SAME perceived tacticalRadius the dodge gate drew this tick", () => {
    // Same UNDER-estimation draw as above (id=6, seed=1, tick=0): perceived
    // AI_MINE_TACTICAL_RADIUS shrinks from 8.5 to 8.5 - 1.2968585882253238 =
    // 7.203141411774676. A player just inside the TRUE tactical radius but outside the
    // perceived one is missed -- the tank proposes no mine, even though the true radius
    // (and every other gate) would say yes.
    const grey = tank(6, 'grey', { x: 0, y: 0 });
    const cfg = withAi(configFor('grey'), { estimationAccuracy: 0.3, minePlacementChance: 1 });
    const player = tank(2, 'player', { x: 8, y: 0 }); // inside true 8.5, outside perceived 7.2
    const wTrue = world({ seed: 1, tick: 0, tanks: [grey, player] });
    expect(mineThreatensPlayer(wTrue, grey)).toBe(true); // control: true radius says yes
    const d = greyDecision(wTrue, grey, cfg);
    expect(d.mine).toBe(false); // perceived radius says no
  });
});
