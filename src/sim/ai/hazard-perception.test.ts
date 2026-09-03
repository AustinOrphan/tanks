// The perceived hazard picture (issue #223): what a tank BELIEVES, against what is true.
//
// What this file pins that nothing else can. `bot-difficulty.test.ts` pins the presets'
// SHAPE and `hazard-competence.test.ts` pins that `estimationAccuracy` reaches a mine's
// perceived RADIUS. Neither can see the three axes #223 added, because none of them existed
// when those files were written: a build that resolves `awarenessDelay`, `safetyMargin` and
// `hazardRefreshTime` correctly and then throws all three away passes both of those files
// completely green.
//
// The measured quantity is deliberately the CONSEQUENCE wherever a consequence exists -- a
// threat missed, a mine unnoticed, a dodge that does or does not happen -- rather than the
// intermediate number, for the reason hazard-competence.test.ts gives: the numbers are the
// thing #223's sweep exists to move, and pinning them literally would pin the wrong half.
import { describe, it, expect } from 'vitest';
import {
  perceiveHazards, backdateHazards, awarenessDelayTicks, hazardRefreshTicks, hazardBucket,
  hazardPerceptionSample,
} from './hazard-perception';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { incomingThreats, dangerAvoidMove } from './targeting';
import { withBotDifficulty, BOT_DIFFICULTIES, MIN_COMPETENCE_AWARENESS_DELAY, MIN_COMPETENCE_HAZARD_REFRESH } from './bot-difficulty';
import { configFor } from '../config';
import { resolveWorldRules } from '../rules';
import {
  DT, TICK_HZ, MINE_TIMER, WANDER_TICKS,
  AI_MINE_FLEE_RADIUS, AI_MINE_TACTICAL_RADIUS, DANGER_CORRIDOR,
} from '../constants';
import type { Tank, Bullet, Mine, Vec2 } from '../types';
import type { World } from '../world';
import type { ResolvedTankConfig } from '../config/types';

function tank(id: number, pos: Vec2, kind: Tank['kind'] = 'grey'): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}
function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
/** `timer` is the fuse REMAINING, so age is MINE_TIMER - timer. Default: freshly dropped. */
function mine(id: number, pos: Vec2, timer = MINE_TIMER): Mine {
  return { id, ownerId: 99, pos, timer, armed: true, detonated: false };
}
function world(over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 1, tanks: [], bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: 0, rules: resolveWorldRules(), ...over,
  };
}
/** A config with one AI field overridden, so an axis can be probed at a chosen value. */
function withAi(cfg: ResolvedTankConfig, over: Partial<ResolvedTankConfig['ai']>): ResolvedTankConfig {
  return { ...cfg, ai: { ...cfg.ai, ...over } };
}

describe('hazardRefreshTicks: the perception cadence is a profile field, not a constant', () => {
  it('converts the authored span the way every other span in the schema is converted', () => {
    // 0.5s at 60Hz is 30 ticks, which is exactly WANDER_TICKS -- the constant this
    // mechanism was hardcoded to before #223. Asserted against BOTH so the equality is a
    // loud two-file edit if either side is retuned, the same treatment
    // DODGE_PATIENCE_TICKS gets in config/roster.test.ts.
    expect(hazardRefreshTicks(configFor('grey'))).toBe(Math.round(0.5 * TICK_HZ));
    expect(hazardRefreshTicks(configFor('grey'))).toBe(WANDER_TICKS);
  });

  it('floors at one tick, because it is a divisor', () => {
    // Validation refuses a non-positive authored span and the preset floor keeps the
    // scaled value above it, so this is the third guard on the same division. It is here
    // because a zero window buckets every tick to the same value and freezes one hazard
    // read for the entire round -- a silent, permanent misjudgement.
    const frozen = withAi(configFor('grey'), { hazardRefreshTime: 0.0001 });
    expect(hazardRefreshTicks(frozen)).toBe(1);
    expect(Number.isFinite(hazardBucket(world({ tick: 500 }), frozen))).toBe(true);
  });

  it('buckets the tick by the profile span, so a slower profile holds a read longer', () => {
    const slow = withAi(configFor('grey'), { hazardRefreshTime: 1 });   // 60 ticks
    const quick = withAi(configFor('grey'), { hazardRefreshTime: 0.2 }); // 12 ticks
    expect(hazardBucket(world({ tick: 59 }), slow)).toBe(hazardBucket(world({ tick: 0 }), slow));
    expect(hazardBucket(world({ tick: 60 }), slow)).not.toBe(hazardBucket(world({ tick: 0 }), slow));
    expect(hazardBucket(world({ tick: 12 }), quick)).not.toBe(hazardBucket(world({ tick: 0 }), quick));
  });
});

describe('awarenessDelayTicks: seeded, bounded, and held for the refresh span', () => {
  const cfg = configFor('grey');

  it('never exceeds the profile span and is never negative, over a wide sweep', () => {
    // Population stated: 40 tank ids x 200 refresh buckets = 8000 draws. Stepping by a
    // whole bucket (hazardRefreshTicks, 30) samples each draw exactly once rather than
    // counting the same one thirty times.
    const span = hazardRefreshTicks(cfg);
    const max = cfg.ai.awarenessDelay * TICK_HZ;
    let drawn = 0;
    let sawNonZero = false;
    for (let id = 1; id <= 40; id++) {
      for (let b = 0; b < 200; b++) {
        const d = awarenessDelayTicks(world({ tick: b * span }), tank(id, { x: 0, y: 0 }), cfg);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.round(max));
        if (d > 0) sawNonZero = true;
        drawn++;
      }
    }
    expect(drawn).toBe(8000);
    // Non-vacuous: a build that always returned 0 would satisfy every bound above.
    expect(sawNonZero).toBe(true);
  });

  it('is IDENTICAL across a whole refresh span and changes at the boundary', () => {
    // #223's "perceived hazard state is stable within its refresh/decision window". Without
    // this the delay is frame-to-frame noise, which averages itself away over a dodge --
    // the exact failure mode the issue names.
    const t = tank(3, { x: 0, y: 0 });
    const span = hazardRefreshTicks(cfg);
    const inWindow = new Set<number>();
    for (let tick = 0; tick < span; tick++) inWindow.add(awarenessDelayTicks(world({ tick }), t, cfg));
    expect(inWindow.size).toBe(1);
    // ...and the NEXT window is a fresh draw. Scanned rather than asserted on the very next
    // bucket: two consecutive uniform draws can legitimately round to the same tick count,
    // so "the boundary re-draws" is proved by a differing value existing at all nearby.
    const later = new Set<number>();
    for (let b = 1; b <= 12; b++) later.add(awarenessDelayTicks(world({ tick: b * span }), t, cfg));
    expect(later.size).toBeGreaterThan(1);
  });

  it('gives different tanks different delays in the same tick', () => {
    const w = world({ tick: 0 });
    const seen = new Set(
      Array.from({ length: 12 }, (_, i) => awarenessDelayTicks(w, tank(i + 1, { x: 0, y: 0 }), cfg)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is exactly zero for a profile whose span rounds to no ticks', () => {
    // The neutrality point the golden trace's re-pin is demonstrated at (tools/baseline/
    // trace.ts): 0.001s can never round to a whole tick, so the whole mechanism is
    // provably inert there rather than merely small.
    const inert = withAi(cfg, { awarenessDelay: 0.001 });
    for (let b = 0; b < 50; b++) {
      expect(awarenessDelayTicks(world({ tick: b * 30 }), tank(1, { x: 0, y: 0 }), inert)).toBe(0);
    }
  });
});

describe('backdateHazards: the stale picture itself', () => {
  it('returns the SAME world object at a zero delay, not an equal copy', () => {
    // Referential identity, deliberately, for `withBotDifficulty`'s reason: it is what makes
    // a zero delay provably free of both cost and drift, and it is the property the golden
    // trace's neutrality demonstration rests on.
    const w = world({ bullets: [bullet(1, 9, { x: 0, y: 0 }, { x: 6, y: 0 })], mines: [mine(2, { x: 1, y: 1 })] });
    expect(backdateHazards(w, 0)).toBe(w);
    expect(backdateHazards(w, -3)).toBe(w);
  });

  it('moves a shell BACK along its own velocity by exactly the delay', () => {
    // Exact arithmetic, not a direction check: `stepBullets` integrates pos += vel * DT, so
    // the perceived position is the one the shell genuinely held `delay` ticks ago, and a
    // sign error here would make a bot react to where a shell is GOING, i.e. better than
    // truth rather than worse.
    const b = bullet(1, 9, { x: 4, y: 2 }, { x: 6, y: -3 });
    const seen = backdateHazards(world({ bullets: [b] }), 6);
    expect(seen.bullets[0].pos.x).toBeCloseTo(4 - 6 * 6 * DT, 12);
    expect(seen.bullets[0].pos.y).toBeCloseTo(2 + 3 * 6 * DT, 12);
    // Velocity is untouched: the shell is where it was, still doing what it is doing.
    expect(seen.bullets[0].vel).toEqual(b.vel);
  });

  it('mutates nothing, and shares by reference exactly what it does not rewrite', () => {
    // Both halves of `backdateHazards`'s guarantee, pinned together on one fixture so the
    // doc comment cannot drift from the code in either direction. An earlier draft of that
    // comment claimed a caller "cannot write through it into the real one", which was false
    // on three counts -- dead shells, surviving mines, and a rewritten shell's `vel` are all
    // the originals. The claim is now the narrower true one, and this is what holds it there.
    const live = bullet(1, 9, { x: 4, y: 2 }, { x: 6, y: -3 });
    const dead = { ...bullet(2, 9, { x: 0, y: 0 }, { x: 1, y: 1 }), alive: false };
    const settled = mine(3, { x: 9, y: 9 }, MINE_TIMER - 1);
    const w = world({ bullets: [live, dead], mines: [settled] });
    const seen = backdateHazards(w, 6);

    // MUTATES NOTHING: not the world, not its arrays, not anything reachable from them.
    expect(live.pos).toEqual({ x: 4, y: 2 });
    expect(w.bullets).toHaveLength(2);
    expect(w.mines).toHaveLength(1);
    expect(seen.bullets).not.toBe(w.bullets);
    expect(seen.mines).not.toBe(w.mines);

    // NOT a deep clone. Only a LIVE shell is rewritten, and only its `pos`.
    expect(seen.bullets[0]).not.toBe(live);
    expect(seen.bullets[0].pos).not.toBe(live.pos);
    expect(seen.bullets[0].vel).toBe(live.vel); // shared, deliberately -- only pos is replaced
    expect(seen.bullets[1]).toBe(dead);         // a dead shell passes straight through
    expect(seen.mines[0]).toBe(settled);        // a surviving mine IS the original

    // Tanks, walls and spawns are shared BY REFERENCE: awareness delay is a hazard axis only.
    expect(seen.tanks).toBe(w.tanks);
    expect(seen.walls).toBe(w.walls);
    expect(seen.spawns).toBe(w.spawns);
  });

  it('hides a mine younger than the delay and keeps an older one -- perceived FUSE STATE', () => {
    // The dimension beyond a radius offset that #223 asks for. A mine dropped inside the
    // delay window has not been noticed yet, which is a decision change (nothing to flee)
    // rather than a cosmetic one.
    const fresh = mine(1, { x: 1, y: 0 }, MINE_TIMER);        // age 0
    const settled = mine(2, { x: 2, y: 0 }, MINE_TIMER - 1);  // age 1s = 60 ticks
    const w = world({ mines: [fresh, settled] });
    expect(backdateHazards(w, 6).mines.map((m) => m.id)).toEqual([2]);
    // The boundary is inclusive at exactly the delay, and nothing is hidden at zero.
    const exactly = mine(3, { x: 3, y: 0 }, MINE_TIMER - 6 * DT);
    expect(backdateHazards(world({ mines: [exactly] }), 6).mines.map((m) => m.id)).toEqual([3]);
    expect(backdateHazards(w, 0).mines).toHaveLength(2);
  });
});

describe('perceiveHazards: one belief, every hazard type', () => {
  const cfg = configFor('grey');

  it('offsets all three radii by the SAME error, so a bad read is coherent', () => {
    // The property estimationError's own doc comment argues for, now asserted rather than
    // implied: "having a bad read this window" applies across every hazard at once, not as
    // an independent coin flip per site.
    const p = perceiveHazards(world({ tick: 7 }), tank(1, { x: 0, y: 0 }), cfg);
    const offset = p.radiusError + p.safetyMargin;
    expect(p.fleeRadius - AI_MINE_FLEE_RADIUS).toBeCloseTo(offset, 12);
    expect(p.dangerCorridor - DANGER_CORRIDOR).toBeCloseTo(offset, 12);
    expect(p.tacticalRadius - AI_MINE_TACTICAL_RADIUS).toBeCloseTo(offset, 12);
    // Non-vacuous: the offset is a real perturbation, not zero.
    expect(Math.abs(p.radiusError)).toBeGreaterThan(0);
  });

  it('carries the profile safety margin into every radius', () => {
    // A build that resolved `safetyMargin` and never read it passes every difficulty test
    // in bot-difficulty.test.ts. This is where that axis becomes a distance.
    const t = tank(1, { x: 0, y: 0 });
    const w = world({ tick: 7 });
    const base = perceiveHazards(w, t, withAi(cfg, { safetyMargin: 0 }));
    const cautious = perceiveHazards(w, t, withAi(cfg, { safetyMargin: 0.4 }));
    expect(cautious.fleeRadius - base.fleeRadius).toBeCloseTo(0.4, 12);
    expect(cautious.dangerCorridor - base.dangerCorridor).toBeCloseTo(0.4, 12);
    expect(cautious.tacticalRadius - base.tacticalRadius).toBeCloseTo(0.4, 12);
    // ...and the two share the identical estimation draw, so the delta is the margin ALONE.
    expect(cautious.radiusError).toBe(base.radiusError);
  });

  it('reads the estimation error on the PROFILE cadence, not on a fixed one', () => {
    // The link `hazard-competence.test.ts` cannot see: a build where `estimationError`
    // ignores its cadence argument and keeps bucketing by WANDER_TICKS passes there, and
    // makes `hazardRefreshTime` a dead field. Two ticks inside one profile's window and
    // across another's must therefore disagree about whether the read changed.
    const slow = withAi(cfg, { hazardRefreshTime: 1 });   // 60-tick window
    const quick = withAi(cfg, { hazardRefreshTime: 0.2 }); // 12-tick window
    const t = tank(4, { x: 0, y: 0 });
    const at = (tick: number, c: ResolvedTankConfig) => perceiveHazards(world({ tick }), t, c).radiusError;
    expect(at(0, slow)).toBe(at(45, slow));       // one window for the slow profile...
    expect(at(0, quick)).not.toBe(at(45, quick)); // ...three windows on for the quick one
  });

  it('holds the whole snapshot steady across its refresh span', () => {
    // #223's stability criterion at the level a decision actually reads.
    const t = tank(2, { x: 0, y: 0 });
    const span = hazardRefreshTicks(cfg);
    const first = perceiveHazards(world({ tick: 0 }), t, cfg);
    for (let tick = 1; tick < span; tick++) {
      const p = perceiveHazards(world({ tick }), t, cfg);
      expect(p.radiusError).toBe(first.radiusError);
      expect(p.delayTicks).toBe(first.delayTicks);
      expect(p.fleeRadius).toBe(first.fleeRadius);
    }
  });
});

describe('difficulty moves the whole hazard picture, monotonically', () => {
  const base = configFor('player'); // the profile a versus bot actually inherits

  it('orders every one of the three axes #223 added, easy -> normal -> hard', () => {
    const [easy, normal, hard] = BOT_DIFFICULTIES.map((d) => withBotDifficulty(base, d).ai);
    // Longer staleness is worse, so easy is above normal is above hard.
    expect(easy.awarenessDelay).toBeGreaterThan(normal.awarenessDelay);
    expect(normal.awarenessDelay).toBeGreaterThan(hard.awarenessDelay);
    // More clearance is better, so the ordering runs the other way.
    expect(easy.safetyMargin).toBeLessThan(normal.safetyMargin);
    expect(normal.safetyMargin).toBeLessThan(hard.safetyMargin);
    // A longer window means living with a bad read for longer, so it orders like the delay.
    expect(easy.hazardRefreshTime).toBeGreaterThan(normal.hazardRefreshTime);
    expect(normal.hazardRefreshTime).toBeGreaterThan(hard.hazardRefreshTime);
  });

  it('never lets HARD reach a current picture, however extreme the profile', () => {
    // #223's binding limit on the axes it added: "faster and more consistent, but never
    // perfect". Both floors are checked against a profile already at them, not just the
    // shipped one -- the shipped profile is nowhere near, so testing only that would leave
    // the clamps themselves unexercised.
    const brittle = withAi(base, { awarenessDelay: 0.06, hazardRefreshTime: 0.11 });
    const hard = withBotDifficulty(brittle, 'hard').ai;
    expect(hard.awarenessDelay).toBeGreaterThanOrEqual(MIN_COMPETENCE_AWARENESS_DELAY);
    expect(hard.awarenessDelay).toBeGreaterThan(0);
    expect(hard.hazardRefreshTime).toBeGreaterThanOrEqual(MIN_COMPETENCE_HAZARD_REFRESH);
    // ...and the delay stays a REAL delay at the shipped profile: at least one whole tick
    // is reachable, so `hard` still sometimes reacts to a shell that has already moved.
    const shippedHard = withBotDifficulty(base, 'hard');
    const delays = new Set(
      Array.from({ length: 60 }, (_, i) =>
        awarenessDelayTicks(world({ tick: i * hazardRefreshTicks(shippedHard) }), tank(1, { x: 0, y: 0 }), shippedHard)),
    );
    expect(Math.max(...delays)).toBeGreaterThan(0);
  });

  it('makes an EASY bot miss a real threat a HARD bot sees, THROUGH a decision', () => {
    // The composition test: config deltas are not decision deltas. A shell is placed so
    // that the TRUE corridor flags it and a stale, corner-cutting read does not; greyDecision
    // is entered at both presets and only the outcome is read.
    //
    // Population: every tick of one refresh window x 20 tank ids, counting the ticks on
    // which each preset produces no dodge against a shell the true world says is incoming.
    // A single tick would be a fixture, not a property -- the delay is a DRAW, so any one
    // tick can legitimately land at zero.
    const shell = () => bullet(50, 99, { x: -3, y: 0.55 }, { x: 9, y: 0 });
    const missRate = (difficulty: 'easy' | 'hard'): number => {
      let missed = 0;
      let total = 0;
      for (let id = 1; id <= 20; id++) {
        for (let tick = 0; tick < 30; tick++) {
          const t = tank(id, { x: 0, y: 0 });
          const w = world({ tick, tanks: [t], bullets: [shell()] });
          // Control: the TRUE corridor flags this shell, so a miss is a misjudgement rather
          // than an empty fixture.
          expect(incomingThreats(w, t)).toHaveLength(1);
          const cfg = withBotDifficulty(configFor('grey'), difficulty);
          if (greyDecision(w, t, cfg).avoid === null) missed++;
          total++;
        }
      }
      expect(total).toBe(600);
      return missed / total;
    };
    const easy = missRate('easy');
    const hard = missRate('hard');
    expect(easy).toBeGreaterThan(hard);
    // ...and easy's misjudgement is COMMON enough to be a behaviour rather than a rounding
    // artefact. Without this, 0.3% > 0.2% would satisfy the ordering above.
    expect(easy).toBeGreaterThan(0.05);
  });

  it('makes an EASY bot walk past a mine a HARD bot flees, THROUGH a decision', () => {
    // The mine half of the same claim, and the one that reaches the safety margin: the mine
    // sits just outside the true flee radius, so only the perceived radius decides.
    const at = (difficulty: 'easy' | 'hard', id: number, tick: number): boolean => {
      const t = tank(id, { x: 0, y: 0 });
      const m = mine(70, { x: AI_MINE_FLEE_RADIUS + 0.15, y: 0 }, MINE_TIMER - 1);
      const w = world({ tick, tanks: [t], mines: [m] });
      // Control: the TRUE radius does NOT reach this mine, so any flee is over-estimation.
      expect(dangerAvoidMove(w, t)).toBeNull();
      return greyDecision(w, t, withBotDifficulty(configFor('grey'), difficulty)).avoid !== null;
    };
    let easyFlees = 0;
    let hardFlees = 0;
    for (let id = 1; id <= 40; id++) {
      for (let b = 0; b < 5; b++) {
        if (at('easy', id, b * 51)) easyFlees++;   // easy's window is 51 ticks
        if (at('hard', id, b * 21)) hardFlees++;   // hard's is 21
      }
    }
    // Hard keeps more room than easy does, so it treats a mine just outside the true radius
    // as worth avoiding more often. 200 draws per arm.
    expect(hardFlees).toBeGreaterThan(easyFlees);
  });
});

describe('the decision functions solve from the PERCEIVED world, not the real one', () => {
  // The composition claim the radius error cannot make. A shell dead-centre on the tank has
  // perpendicular distance 0, so NO corridor width -- perceived or true -- can make it go
  // unflagged; the only thing that can is the lookahead horizon, and the only thing that
  // moves the horizon is where the shell is BELIEVED to be. So this fixture isolates
  // time-to-impact error from the pre-existing radius error entirely.
  //
  // The arithmetic, stated so the fixture is readable rather than magic: `incomingThreats`
  // drops a shell once `along > speed * THREAT_HORIZON`. Speed is 9, the horizon 1s, and the
  // shell starts 8.5 units back -- inside, by 0.5. Back-dating d ticks adds 9 * d / 60 to
  // `along`, so the shell falls outside at d > 3.33, i.e. at 4 whole ticks and beyond.
  const CROSSOVER_TICKS = 4;
  const stale = () => withAi(configFor('grey'), {
    // High enough that the perceived corridor stays positive at every draw (DANGER_CORRIDOR
    // 0.8 against a spread of AI_HAZARD_SPREAD / 0.9), so the radius error provably cannot
    // be what makes a threat vanish here.
    estimationAccuracy: 0.9,
    // 0.5s, so the draw spans both sides of the crossover and each tick's case is decided by
    // its own delay rather than by the whole arm.
    awarenessDelay: 0.5,
  });
  const shell = () => bullet(50, 99, { x: -8.5, y: 0 }, { x: 9, y: 0 });

  const check = (decide: (w: World, t: Tank, c: ResolvedTankConfig) => Vec2 | null) => {
    const cfg = stale();
    let dodged = 0;
    let missed = 0;
    for (let id = 1; id <= 25; id++) {
      for (let b = 0; b < 4; b++) {
        const t = tank(id, { x: 0, y: 0 });
        const w = world({ tick: b * hazardRefreshTicks(cfg), tanks: [t], bullets: [shell()] });
        // Control: the shell IS incoming in the real world, at the true corridor. A build
        // that read the real world could never miss it, which is the mutation this kills.
        expect(incomingThreats(w, t)).toHaveLength(1);
        const delay = perceiveHazards(w, t, cfg).delayTicks;
        const avoid = decide(w, t, cfg);
        // Exact, not statistical: the crossover is arithmetic, so every draw is predictable.
        expect(avoid === null).toBe(delay >= CROSSOVER_TICKS);
        if (avoid === null) missed++; else dodged++;
      }
    }
    // Both sides of the crossover are exercised, so neither branch passes vacuously.
    expect(missed).toBeGreaterThan(0);
    expect(dodged).toBeGreaterThan(0);
  };

  it('grey ignores a real, incoming shell its stale picture has not caught up with', () => {
    check((w, t, c) => greyDecision(w, t, c).avoid);
  });

  it('teal does the same, through its own wiring rather than a copy that could rot', () => {
    // The same claim at the other decision function, for the reason profile.test.ts states
    // about its own pair: grey and teal wire the perceived world independently, so one of
    // them regressing is invisible to a test that only enters through the other.
    check((w, t, c) => tealDecision(w, t, c).avoid);
  });
});

describe('the developer trace compares actual against perceived', () => {
  it('reports the divergence a stale picture creates, and zero when there is none', () => {
    // #223 asks for "a developer trace comparing actual and perceived hazard state". It is
    // pure and called by nothing in `step`, so this is what keeps it honest.
    const ids = (w: World, corridor: number) => incomingThreats(w, tank(1, { x: 0, y: 0 }), corridor).map((b) => b.id);
    const t = tank(1, { x: 0, y: 0 });
    const b = bullet(50, 99, { x: -3, y: 0 }, { x: 9, y: 0 });
    const cfgStale = withAi(configFor('grey'), { awarenessDelay: 0.5 });
    const w = world({ tick: 0, tanks: [t], bullets: [b], mines: [mine(70, { x: 2, y: 0 }, MINE_TIMER - 1)] });

    const stale = hazardPerceptionSample(w, t, cfgStale, ids);
    expect(stale.actualFleeRadius).toBe(AI_MINE_FLEE_RADIUS);
    expect(stale.actualDangerCorridor).toBe(DANGER_CORRIDOR);
    expect(stale.perceivedFleeRadius).not.toBe(stale.actualFleeRadius);
    expect(stale.delayTicks).toBeGreaterThan(0);
    // The shell really is somewhere else in the believed world, by the delay's own distance.
    expect(stale.maxShellPositionError).toBeCloseTo(9 * stale.delayTicks * DT, 9);
    expect(stale.actualMinesInRange).toBe(1);

    // ...and with a picture that is current, the shell error is exactly zero. Same fixture,
    // so a non-zero reading above cannot be an artefact of the shell's own geometry.
    const current = hazardPerceptionSample(w, t, withAi(configFor('grey'), { awarenessDelay: 0.001 }), ids);
    expect(current.delayTicks).toBe(0);
    expect(current.maxShellPositionError).toBe(0);
    expect(current.missedThreats).toBe(0);
    expect(current.phantomThreats).toBe(0);
  });
});
