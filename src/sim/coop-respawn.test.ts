import { describe, it, expect } from 'vitest';
import { createWorld, resolveStatus, stepRespawns, stepInputs, countPlayerTanks } from './world';
import type { World } from './world';
import type { Tank, Spawn } from './types';
import type { SimEvent } from './events';
import { RESPAWN_DELAY_TICKS, RESPAWN_SHIELD_TICKS } from './constants';

/**
 * Coop's per-tank respawn machinery: `countPlayerTanks`, `resolveStatus`'s guard-first
 * split into `resolveStatusCoop`, and `stepRespawns`. See the coop semantics plan
 * (docs/superpowers/plans/2026-08-15-coop-semantics.md), which this file pins as
 * written -- the shared-pool mechanics under simultaneous death, the pending-respawn
 * guard, and the 1P regression the guard-first split depends on.
 *
 * Deliberately calls resolveStatus/stepRespawns DIRECTLY, not through step()/stepInputs
 * -- this is a unit file in CLAUDE.md's sense (movement.test.ts, bullets.test.ts) and
 * cannot see whether stepInputs actually wires stepRespawns in; that composition is
 * pinned separately in step-pipeline.test.ts.
 */

function makeTank(kind: Tank['kind'], id: number, x: number, y: number, alive = true): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}

const A_ID = 1;
const B_ID = 2;

const PLAYER_SPAWNS: Spawn[] = [
  { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
  { kind: 'player', pos: { x: 20, y: 5 }, angle: Math.PI },
];

/** Two player-kind tanks, no enemies -- isolates resolveStatusCoop's death/respawn path
 * from its win check (allEnemiesDead needs enemies.length > 0). */
function twoPlayerWorld(lives: number): World {
  return createWorld({
    walls: [],
    tanks: [makeTank('player', A_ID, 5, 5), makeTank('player', B_ID, 20, 5)],
    spawns: PLAYER_SPAWNS,
    lives,
  });
}

const tankById = (w: World, id: number) => w.tanks.find((t) => t.id === id)!;

function destroyed(tankId: number, ownerId = 999): SimEvent {
  return { type: 'tank-destroyed', tankId, kind: 'player', by: { source: 'shell', ownerId }, pos: { x: 0, y: 0 } };
}

describe('countPlayerTanks', () => {
  it('counts kind === player tanks only, ignoring alive/dead', () => {
    const w = createWorld({
      walls: [],
      tanks: [
        makeTank('player', 1, 0, 0, false),
        makeTank('player', 2, 0, 0),
        makeTank('brown', 3, 0, 0),
      ],
      spawns: [],
      lives: 3,
    });
    expect(countPlayerTanks(w)).toBe(2);
  });

  it('is 0 for an all-enemy world and 1 for a single-player world', () => {
    expect(countPlayerTanks(createWorld({ walls: [], tanks: [makeTank('brown', 1, 0, 0)], spawns: [], lives: 3 }))).toBe(0);
    expect(countPlayerTanks(createWorld({ walls: [], tanks: [makeTank('player', 1, 0, 0)], spawns: [], lives: 3 }))).toBe(1);
  });
});

describe('resolveStatus: coop guard (countPlayerTanks(world) >= 2)', () => {
  it('a single player death drains the pool by 1 and schedules a respawn, without reviving immediately', () => {
    const w = twoPlayerWorld(3);
    w.tick = 100;
    const a = tankById(w, A_ID);
    a.pos = { x: 12, y: 9 }; // away from its own spawn, so revival is provably a MOVE
    a.alive = false;
    const events: SimEvent[] = [destroyed(A_ID)];

    resolveStatus(w, events);

    expect(w.lives).toBe(2);
    expect(a.alive).toBe(false); // not revived yet -- stepRespawns' job, not resolveStatus's
    expect(a.respawnAtTick).toBe(100 + RESPAWN_DELAY_TICKS);
    expect(a.pos).toEqual({ x: 12, y: 9 }); // untouched until the revival tick
    expect(w.status).toBe('playing');
    expect(events.some((e) => e.type === 'lose')).toBe(false);
  });

  it('does not stamp a respawn a second time for a tank already carrying one', () => {
    // resolveStatus can run again on a later tick before the respawn resolves; the
    // corpse's tank-destroyed event is not re-emitted, but guard the idempotency anyway
    // (the plan's stated reason: respawnAtTick !== undefined skips the tally).
    const w = twoPlayerWorld(5);
    const a = tankById(w, A_ID);
    a.alive = false;
    a.respawnAtTick = 999;
    resolveStatus(w, [destroyed(A_ID)]);
    expect(w.lives).toBe(5); // untouched -- the guard skipped the tally entirely
    expect(a.respawnAtTick).toBe(999);
  });

  it('simultaneous double death at pool 2: one revives, the other stays down permanently', () => {
    const w = twoPlayerWorld(2);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    a.alive = false;
    b.alive = false;
    const events: SimEvent[] = [destroyed(A_ID), destroyed(B_ID)];

    resolveStatus(w, events);

    expect(w.lives).toBe(0);
    expect(a.respawnAtTick).toBeDefined(); // first decrement, 2 -> 1, still > 0
    expect(b.respawnAtTick).toBeUndefined(); // second decrement, 1 -> 0, not > 0
    expect(w.status).toBe('playing'); // pendingRespawn (A's) blocks the lose
    expect(events.some((e) => e.type === 'lose')).toBe(false);
  });

  it('simultaneous double death at pool 1: a shared pool of 1 cannot survive two deaths', () => {
    const w = twoPlayerWorld(1);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    a.alive = false;
    b.alive = false;
    const events: SimEvent[] = [destroyed(A_ID), destroyed(B_ID)];

    resolveStatus(w, events);

    expect(w.lives).toBe(0);
    expect(a.respawnAtTick).toBeUndefined();
    expect(b.respawnAtTick).toBeUndefined();
    expect(w.status).toBe('lose');
    expect(events.some((e) => e.type === 'lose')).toBe(true);
  });

  it('a respawn scheduled on an EARLIER tick survives a LATER death that drains the pool to 0', () => {
    // The least obvious branch: pendingRespawn, not world.lives > 0, is what guards
    // against calling `lose` mid-window -- a scheduled respawn was already paid for.
    const w = twoPlayerWorld(2);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);

    // Tick 100: A dies alone. Pool 2 -> 1, A gets a respawn scheduled for tick 220.
    w.tick = 100;
    a.alive = false;
    resolveStatus(w, [destroyed(A_ID)]);
    expect(w.lives).toBe(1);
    expect(a.respawnAtTick).toBe(220);

    // Tick 150: B dies too, BEFORE A's respawn (220) has arrived -- both are currently
    // down. Only B's death is in THIS tick's event list.
    w.tick = 150;
    b.alive = false;
    const events: SimEvent[] = [destroyed(B_ID)];
    resolveStatus(w, events);

    expect(w.lives).toBe(0); // pool 1 -> 0 from B's death
    expect(b.respawnAtTick).toBeUndefined(); // 0 is not > 0, no respawn for B
    expect(a.respawnAtTick).toBe(220); // A's earlier-scheduled respawn is untouched
    // noneStanding is true (both currently dead) but pendingRespawn is true (A's) --
    // the run must not end while a paid-for respawn is still owed.
    expect(w.status).toBe('playing');
    expect(events.some((e) => e.type === 'lose')).toBe(false);
  });

  it('a mutual kill still wins ahead of any death handling, in coop too', () => {
    const w = createWorld({
      walls: [],
      tanks: [
        makeTank('player', A_ID, 5, 5, false),
        makeTank('player', B_ID, 20, 5),
        makeTank('brown', 3, 10, 10, false),
      ],
      spawns: PLAYER_SPAWNS,
      lives: 1, // would otherwise be a lose-worthy pool if A's death were processed
    });
    const events: SimEvent[] = [destroyed(A_ID)];

    resolveStatus(w, events);

    expect(w.status).toBe('win');
    expect(w.lives).toBe(1); // untouched -- win returns before the death tally
    expect(tankById(w, A_ID).respawnAtTick).toBeUndefined();
    expect(events.some((e) => e.type === 'win')).toBe(true);
    expect(events.some((e) => e.type === 'lose')).toBe(false);
  });

  it('players.length < 2 regression pin: 1-player and 0-player worlds are byte-identical to the pre-guard body', () => {
    // Guards the guard: proves the coop branch is genuinely unreachable at N < 2, not
    // merely untested. Compares status, lives, respawn state and the full event stream
    // against hand-reasoned pre-change behaviour -- a targeted subset, not a whole-World
    // toEqual; the forward byte-identity guarantee for the 1P path is carried by the
    // golden trace's BASELINE_HASH, not by this pin.
    const onePlayer = createWorld({
      walls: [],
      tanks: [makeTank('player', A_ID, 5, 5, false), makeTank('brown', 3, 10, 10, false)],
      spawns: [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }],
      lives: 2,
    });
    const events1: SimEvent[] = [destroyed(A_ID)];
    resolveStatus(onePlayer, events1);
    // Pre-change body: player dead, enemy also dead -> allEnemiesDead wins first.
    expect(onePlayer.status).toBe('win');
    expect(onePlayer.lives).toBe(2);
    expect(tankById(onePlayer, A_ID).respawnAtTick).toBeUndefined();
    expect(events1).toEqual([destroyed(A_ID), { type: 'win' }]);

    const zeroPlayer = createWorld({
      walls: [],
      tanks: [makeTank('brown', 3, 10, 10, false)],
      spawns: [],
      lives: 2,
    });
    const events0: SimEvent[] = [];
    resolveStatus(zeroPlayer, events0);
    // Pre-change body: `player` is undefined -> the `if (player && !player.alive)`
    // branch never runs; allEnemiesDead wins.
    expect(zeroPlayer.status).toBe('win');
    expect(events0).toEqual([{ type: 'win' }]);

    // And the ordinary single-player LOSS path, untouched: last life, no enemies dead.
    const losing = createWorld({
      walls: [],
      tanks: [makeTank('player', A_ID, 5, 5, false), makeTank('brown', 3, 10, 10)],
      spawns: [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }],
      lives: 1,
    });
    const eventsL: SimEvent[] = [destroyed(A_ID)];
    resolveStatus(losing, eventsL);
    expect(losing.status).toBe('lose');
    expect(losing.lives).toBe(0);
    expect(eventsL).toEqual([destroyed(A_ID), { type: 'lose' }]);
  });
});

describe('stepRespawns', () => {
  function deadWorld(respawnAtTick: number | undefined, tick: number): World {
    const w = twoPlayerWorld(3);
    const a = tankById(w, A_ID);
    a.alive = false;
    a.pos = { x: 12, y: 9 }; // off its own spawn
    a.bodyAngle = 1.2;
    a.turretAngle = 1.2;
    a.fireCooldown = 7;
    a.mineCooldown = 4;
    a.aiState = 'aim';
    a.aiTimer = 3;
    a.aimTicks = 9;
    a.respawnAtTick = respawnAtTick;
    w.tick = tick;
    return w;
  }

  it('does nothing before the revival tick arrives', () => {
    const w = deadWorld(220, 219);
    const events: SimEvent[] = [];
    stepRespawns(w, events);
    const a = tankById(w, A_ID);
    expect(a.alive).toBe(false);
    expect(a.respawnAtTick).toBe(220);
    expect(events).toEqual([]);
  });

  it('revives exactly at the scheduled tick, at the tank\'s OWN spawns[idx] cell, with a shield', () => {
    const w = deadWorld(220, 220);
    const events: SimEvent[] = [];
    stepRespawns(w, events);
    const a = tankById(w, A_ID);
    expect(a.alive).toBe(true);
    expect(a.pos).toEqual(PLAYER_SPAWNS[0].pos); // index-aligned with world.tanks[0]
    expect(a.bodyAngle).toBe(PLAYER_SPAWNS[0].angle);
    expect(a.turretAngle).toBe(PLAYER_SPAWNS[0].angle);
    expect(a.respawnAtTick).toBeUndefined();
    expect(a.shieldUntilTick).toBe(220 + RESPAWN_SHIELD_TICKS);
    expect(a.fireCooldown).toBe(0);
    expect(a.mineCooldown).toBe(0);
    expect(a.aiState).toBe('idle');
    expect(a.aiTimer).toBe(0);
    expect(a.aimTicks).toBe(0);
    expect(a.desiredMove).toEqual({ x: 0, y: 0 });
  });

  it('revives P2 (tanks[1]) at ITS appended spawn, not P1\'s -- the index invariant, insurance', () => {
    // Review probed this correct by construction (index-based, no special-casing) but
    // every shipped revival test exercised only tanks[0]; this pins the P2 half so a
    // future special-case or index bug cannot regress it silently. Breaks if
    // stepRespawns ever resolves the spawn by anything other than the tank's own index.
    const w = twoPlayerWorld(3);
    const b = tankById(w, B_ID);
    b.alive = false;
    b.pos = { x: 3, y: 3 }; // off both spawns
    b.respawnAtTick = 220;
    w.tick = 220;
    stepRespawns(w, []);
    expect(b.alive).toBe(true);
    expect(b.pos).toEqual(PLAYER_SPAWNS[1].pos); // index 1, never PLAYER_SPAWNS[0]
    expect(b.bodyAngle).toBe(PLAYER_SPAWNS[1].angle);
  });

  it('emits a respawn event carrying controlledBy and the revival position', () => {
    const w = deadWorld(220, 220);
    const a = tankById(w, A_ID);
    a.controlledBy = 0;
    const events: SimEvent[] = [];
    stepRespawns(w, events);
    expect(events).toEqual([{ type: 'respawn', tankId: A_ID, controlledBy: 0, pos: PLAYER_SPAWNS[0].pos }]);
  });

  it('also revives past the scheduled tick (a late call still catches an overdue corpse)', () => {
    const w = deadWorld(220, 500);
    stepRespawns(w, []);
    expect(tankById(w, A_ID).alive).toBe(true);
  });

  it('does not touch activeMineIds, and does not clear world-level mines/bullets/blasts', () => {
    // The one correctness fix that is not just carrying resetArena's pattern forward --
    // a per-tank respawn that zeroed activeMineIds while the tank's own mines are still
    // live in world.mines would desync dropMine's cap check.
    const w = deadWorld(220, 220);
    const a = tankById(w, A_ID);
    a.activeMineIds = [42];
    w.mines = [{ id: 42, ownerId: A_ID, pos: { x: 1, y: 1 }, timer: 1, armed: true, detonated: false }];
    w.bullets = [{ id: 7, ownerId: B_ID, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 0, alive: true }];
    w.blasts = [{ id: 1, ownerId: 99, credit: { source: 'blast', ownerId: 99 }, pos: { x: 2, y: 2 }, age: 0 }];
    stepRespawns(w, []);
    expect(a.activeMineIds).toEqual([42]);
    expect(w.mines).toHaveLength(1);
    expect(w.bullets).toHaveLength(1);
    expect(w.blasts).toHaveLength(1);
  });

  it('leaves a still-alive player, and an enemy, entirely untouched', () => {
    const w = deadWorld(220, 220);
    const b = tankById(w, B_ID);
    b.pos = { x: 99, y: 99 };
    const before = { ...b, pos: { ...b.pos } };
    stepRespawns(w, []);
    expect(tankById(w, B_ID)).toEqual(before);
  });

  it('does nothing at all when countPlayerTanks(world) < 2 -- 1P never reaches this stage in the real pipeline (the gate lives in stepInputs, pinned in the describe block directly below)', () => {
    // stepRespawns itself has no internal player-count gate -- calling it directly on a
    // 1-player world with a stamped respawnAtTick WOULD revive it. That is fine: the
    // gate is stepInputs' job (`if (countPlayerTanks(draft) >= 2) stepRespawns(...)`),
    // not stepRespawns' own, matching resolveStatus's guard-first pattern one level up.
    const w = createWorld({
      walls: [],
      tanks: [makeTank('player', A_ID, 12, 9, false)],
      spawns: [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }],
      lives: 3,
    });
    const a = tankById(w, A_ID);
    a.respawnAtTick = 0;
    w.tick = 0;
    stepRespawns(w, []);
    expect(a.alive).toBe(true); // reachable directly; the real game never calls it here
  });
});

/**
 * COMPOSITION, not a unit test of stepRespawns' own body (that is the describe block
 * above, which calls it directly). This is the CLAUDE.md distinction step-pipeline.test.ts
 * draws for the rest of the pipeline: a unit file that calls a stage directly cannot see
 * whether stepInputs actually wires that stage in. Every test above this point calls
 * stepRespawns or resolveStatus directly and would keep passing if stepInputs' own
 * `if (countPlayerTanks(draft) >= 2) stepRespawns(draft, events);` line were deleted --
 * this is the one that would not.
 */
describe('stepInputs composition: stepRespawns is actually wired in, not merely correct in isolation', () => {
  it('a corpse whose respawnAtTick lands on the very next tick revives THROUGH stepInputs -- not just when stepRespawns is called directly', () => {
    const w = twoPlayerWorld(3);
    const a = tankById(w, A_ID);
    a.pos = { x: 12, y: 9 }; // off its own spawn, so revival is provably a MOVE
    a.alive = false;
    // stepInputs increments tick BEFORE running this stage, so +1 lands exactly on it.
    a.respawnAtTick = w.tick + 1;
    w.roundStartTick = -100000; // irrelevant to stepRespawns itself, kept realistic anyway

    const r = stepInputs(w, []);

    const revived = tankById(r.world, A_ID);
    expect(revived.alive).toBe(true);
    expect(revived.pos).toEqual(PLAYER_SPAWNS[0].pos);
    expect(revived.respawnAtTick).toBeUndefined();
    expect(revived.shieldUntilTick).toBe(r.world.tick + RESPAWN_SHIELD_TICKS);
  });

  it('does NOT revive one tick early -- the composed pipeline respects the same tick check stepRespawns enforces on its own', () => {
    const w = twoPlayerWorld(3);
    const a = tankById(w, A_ID);
    a.pos = { x: 12, y: 9 };
    a.alive = false;
    a.respawnAtTick = w.tick + 2; // one tick LATER than stepInputs is about to reach
    const r = stepInputs(w, []);
    expect(tankById(r.world, A_ID).alive).toBe(false);
  });
});

/**
 * The plan's flagged residual: does an AI hold a STALE reference to a dead target, or
 * reacquire cleanly, at the exact tick a tracked-dead tank revives?
 *
 * FINDING (static, from reading brown.ts/grey.ts/teal.ts/index.ts): no Tank object
 * reference is ever cached across ticks anywhere in ai/. Every decision function does
 * a fresh `world.tanks.find((t) => t.kind === 'player' && t.alive)` against the
 * CURRENT (per-tick cloned) world -- there is no reference TO hold stale. Reacquisition
 * is clean by construction the instant a player-kind tank's `alive` flips back to true.
 *
 * What the static read does NOT rule out: two SCALAR fields on the enemy tank persist
 * across a change in which player `.find` returns -- `aimTicks` (the reaction-time
 * counter, index.ts) and `aiState` (brown/grey/teal's own FSM). Neither resets when the
 * tracked player's IDENTITY changes, only when `hasSolution` goes false. The probe
 * below is the red-first check the plan asked for, run through the real pipeline
 * (stepInputs), not asserted from reading the code alone.
 */
describe('AI retargeting at the exact revival tick (plan residual, probed here)', () => {
  const A_TICK = 999;

  function fixture(shielded: boolean): World {
    const reactionTicks = 48; // STATIC_BASIC (brown): reactionTime 0.8s * TICK_HZ 60
    const enemy: Tank = {
      id: 10, kind: 'brown', pos: { x: 0, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
      desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
      // Pre-set as if this enemy had already held a solution against P2 (P1 was dead)
      // for one tick short of its reaction threshold.
      aiState: 'aim', aiTimer: 0, aimTicks: reactionTicks - 1,
    };
    const p1: Tank = {
      id: 1, kind: 'player', pos: { x: 5, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
      desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
      aiState: 'idle', aiTimer: 0, controlledBy: 0,
      // As if stepRespawns revived this tank on the tick about to run (A_TICK + 1).
      shieldUntilTick: shielded ? A_TICK + 1 + RESPAWN_SHIELD_TICKS : undefined,
    };
    const p2: Tank = {
      id: 2, kind: 'player', pos: { x: 100, y: 100 }, bodyAngle: 0, turretAngle: 0, alive: true,
      desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
      aiState: 'idle', aiTimer: 0, controlledBy: 1,
    };
    const w = createWorld({ walls: [], tanks: [p1, p2, enemy], spawns: PLAYER_SPAWNS, lives: 3 });
    w.tick = A_TICK;
    w.roundStartTick = -100000; // past countdown+grace, input/AI both live
    return w;
  }

  it('the carried-over aimTicks/aiState let the enemy fire at the revived tank on the very FIRST tick -- confirming retargeting is not gated by a fresh observation span', () => {
    const w = fixture(true);
    const r = stepInputs(w, []);
    expect(r.events.some((e) => e.type === 'fire' && e.ownerId === 10)).toBe(true);
  });

  it('the shield protects the revived tank for its whole span regardless -- and the fixture is genuinely lethal once the shield lapses', () => {
    let w = fixture(true);
    let diedAtTick: number | null = null;
    for (let i = 0; i < 200 && diedAtTick === null; i++) {
      const r = stepInputs(w, []);
      w = r.world;
      const p1 = w.tanks.find((t) => t.id === 1)!;
      if (!p1.alive) diedAtTick = w.tick;
    }
    expect(diedAtTick).not.toBeNull(); // the fixture really is lethal -- not a fluke miss
    expect(diedAtTick!).toBeGreaterThan(A_TICK + RESPAWN_SHIELD_TICKS); // only after the shield lapsed
  });

  it('an otherwise-identical UNSHIELDED tank dies well within the same span -- the shield, not luck, is what protects it', () => {
    let w = fixture(false);
    let diedAtTick: number | null = null;
    for (let i = 0; i < RESPAWN_SHIELD_TICKS && diedAtTick === null; i++) {
      const r = stepInputs(w, []);
      w = r.world;
      const p1 = w.tanks.find((t) => t.id === 1)!;
      if (!p1.alive) diedAtTick = w.tick;
    }
    expect(diedAtTick).not.toBeNull();
    expect(diedAtTick!).toBeLessThan(A_TICK + RESPAWN_SHIELD_TICKS);
  });
});
