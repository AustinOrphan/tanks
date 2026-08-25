import { describe, it, expect } from 'vitest';
import { createWorld, resolveStatus, stepInputs, stepRespawns } from './world';
import type { World } from './world';
import { createWorldFor, ARENAS } from './arena';
import type { Tank, Spawn } from './types';
import type { SimEvent } from './events';

/**
 * The shared-attempts ruling (owner, 2026-08-16, verbatim): "lives are more like
 * shared attempts. If all players in co op die, then a life/attempt is lost. If one
 * player dies, the remaining can continue on and if they clear the level, all players
 * spawn in on the next level." See docs/superpowers/plans/2026-08-16-coop-attempts.md.
 *
 * `World.coopAttempts` (default TRUE) is what selects this body inside
 * resolveStatusCoop (world.ts); `false` (set only by `?dev=1&coopPool=1`, see
 * devflags.ts/levels.ts) restores the shipped shared-POOL model pinned in
 * coop-respawn.test.ts, which this file deliberately does not touch or duplicate --
 * see the "POOL MODE, explicitly requested" describe block below for why a handful of
 * its assertions are re-proven HERE instead, against an explicit `coopAttempts: false`
 * world, rather than by editing that file.
 *
 * Deliberately calls resolveStatus DIRECTLY for the death/wipe/lose assertions (a unit
 * file in CLAUDE.md's sense, same convention coop-respawn.test.ts uses) and
 * stepInputs for the composition-level claims that a unit call cannot see.
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

/** world.tanks[i] <-> world.spawns[i], the invariant resetArena's own comment
 * documents -- the third entry is the enemy's, since coopWorld's tank array is
 * [A, B, enemy]. Only PLAYER_SPAWNS (the first two) is exported for tests that build
 * a 2-player-only world. */
const ALL_SPAWNS: Spawn[] = [...PLAYER_SPAWNS, { kind: 'brown', pos: { x: 10, y: 10 }, angle: 0 }];

/** Two player-kind tanks and one enemy, so the win check (allEnemiesDead) has
 * something to hold false while a wipe/death is being tested, and something to kill
 * for the survivor-carries-to-a-win case. `coopAttempts` defaults true (the field's
 * own default), matching every real call site until `?dev=1&coopPool=1` overrides it. */
function coopWorld(lives: number, coopAttempts = true, enemyAlive = true): World {
  return createWorld({
    walls: [],
    tanks: [
      makeTank('player', A_ID, 5, 5),
      makeTank('player', B_ID, 20, 5),
      makeTank('brown', 3, 10, 10, enemyAlive),
    ],
    spawns: ALL_SPAWNS,
    lives,
    coopAttempts,
  });
}

const tankById = (w: World, id: number) => w.tanks.find((t) => t.id === id)!;

function destroyed(tankId: number, ownerId = 999): SimEvent {
  return { type: 'tank-destroyed', tankId, kind: 'player', by: { source: 'shell', ownerId }, pos: { x: 0, y: 0 } };
}

describe('World.coopAttempts: defaults to true', () => {
  it('createWorld defaults coopAttempts to true when omitted, cloneWorld carries it', () => {
    const w = createWorld({ walls: [], tanks: [], spawns: [], lives: 3 });
    expect(w.coopAttempts).toBe(true);
    const r = stepInputs(w, []);
    expect(r.world.coopAttempts).toBe(true);
  });

  it('createWorld honors an explicit false (pool mode)', () => {
    const w = createWorld({ walls: [], tanks: [], spawns: [], lives: 3, coopAttempts: false });
    expect(w.coopAttempts).toBe(false);
    expect(stepInputs(w, []).world.coopAttempts).toBe(false);
  });
});

describe('resolveStatusCoop: ATTEMPTS mode -- review insurance cases', () => {
  it('mutual annihilation: the last enemy dies the same call both players do -- WIN, not a wipe', () => {
    // The win check is a STATE check that returns before either coop branch runs, so
    // a same-tick trade cannot spend an attempt. Breaks if the wipe branch is ever
    // hoisted above the win check.
    const w = coopWorld(2, true, true);
    tankById(w, A_ID).alive = false;
    tankById(w, B_ID).alive = false;
    tankById(w, 3).alive = false; // the only enemy, dead in the same tick
    resolveStatus(w, [destroyed(A_ID), destroyed(B_ID)]);
    expect(w.status).toBe('win');
    expect(w.lives).toBe(2); // no attempt spent
  });

  it('N=4: three dead, one survivor carries -- no decrement, no reset, corpses persist', () => {
    const w = createWorld({
      walls: [],
      tanks: [
        makeTank('player', 1, 5, 5), makeTank('player', 2, 8, 5),
        makeTank('player', 4, 11, 5), makeTank('player', 5, 14, 5),
        makeTank('brown', 3, 10, 10),
      ],
      spawns: [
        { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }, { kind: 'player', pos: { x: 8, y: 5 }, angle: 0 },
        { kind: 'player', pos: { x: 11, y: 5 }, angle: 0 }, { kind: 'player', pos: { x: 14, y: 5 }, angle: 0 },
        { kind: 'brown', pos: { x: 10, y: 10 }, angle: 0 },
      ],
      lives: 3,
    });
    for (const id of [1, 2, 4]) tankById(w, id).alive = false;
    resolveStatus(w, [destroyed(1), destroyed(2), destroyed(4)]);
    expect(w.status).toBe('playing');
    expect(w.lives).toBe(3); // untouched -- one player still stands
    for (const id of [1, 2, 4]) expect(tankById(w, id).alive).toBe(false); // corpses stay
    expect(tankById(w, 5).alive).toBe(true);
  });
});

describe('resolveStatusCoop: ATTEMPTS mode (world.coopAttempts, the default)', () => {
  it('a single player death alone costs nothing: no lives decrement, no respawnAtTick, the corpse stays down', () => {
    const w = coopWorld(3);
    const a = tankById(w, A_ID);
    a.pos = { x: 12, y: 9 }; // away from spawn -- provably untouched, not merely alive:false
    a.alive = false;
    const events: SimEvent[] = [destroyed(A_ID)];

    resolveStatus(w, events);

    expect(w.lives).toBe(3); // untouched -- a lone death is not a spent attempt
    expect(a.alive).toBe(false); // the corpse stays down
    expect(a.respawnAtTick).toBeUndefined(); // attempts mode never schedules one
    expect(a.pos).toEqual({ x: 12, y: 9 }); // untouched -- no resetArena, no respawn
    expect(w.status).toBe('playing');
    expect(events.some((e) => e.type === 'lose')).toBe(false);
  });

  it('the survivor fights on: a still-alive B is untouched by A\'s death', () => {
    const w = coopWorld(3);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    a.alive = false;
    resolveStatus(w, [destroyed(A_ID)]);
    expect(b.alive).toBe(true);
    expect(b.pos).toEqual(PLAYER_SPAWNS[1].pos);
  });

  it('the survivor can still win with a dead partner on the board -- the win check ignores dead players', () => {
    const w = coopWorld(3, true, false); // enemy already dead
    const a = tankById(w, A_ID);
    a.alive = false; // A already down when the last enemy falls
    const events: SimEvent[] = [];

    resolveStatus(w, events);

    expect(w.status).toBe('win');
    expect(events.some((e) => e.type === 'win')).toBe(true);
    expect(w.lives).toBe(3); // win short-circuits before any death handling
    expect(a.alive).toBe(false); // win does not revive the corpse
  });

  it('a full wipe (both players dead, at least one lives remaining) costs EXACTLY one life, not one per dead player', () => {
    const w = coopWorld(2);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    a.alive = false;
    b.alive = false;
    const events: SimEvent[] = [destroyed(A_ID), destroyed(B_ID)]; // both in ONE tick

    resolveStatus(w, events);

    expect(w.lives).toBe(1); // 2 -> 1, a single decrement despite two death events
    expect(w.status).toBe('playing');
    expect(events.some((e) => e.type === 'lose')).toBe(false);
  });

  it('a wipe completed across two DIFFERENT ticks (A down already, B dies later) still costs exactly one life', () => {
    // The state-based check ("is anyone standing RIGHT NOW"), not an event tally --
    // this is the case an event-driven design would double-count or miscount.
    const w = coopWorld(2);
    const a = tankById(w, A_ID);
    a.alive = false;
    resolveStatus(w, [destroyed(A_ID)]); // A alone: no-op, per the lone-death rule
    expect(w.lives).toBe(2);

    const b = tankById(w, B_ID);
    b.alive = false;
    resolveStatus(w, [destroyed(B_ID)]); // NOW nobody is standing
    expect(w.lives).toBe(1); // exactly one decrement for the whole wipe
  });

  it('a full wipe with lives remaining calls resetArena: revives players AND enemies, restores walls, clears bullets/mines/blasts, re-arms the round', () => {
    const w = coopWorld(2);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    const enemy = tankById(w, 3);
    a.alive = false;
    a.pos = { x: 1, y: 1 };
    b.alive = false;
    b.pos = { x: 2, y: 2 };
    // A destroyed wall, a leftover bullet/mine/blast, all of which resetArena must clear.
    w.walls = [{ id: 99, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'destructible', destroyed: true }];
    w.bullets = [{ id: 1, ownerId: 999, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 0, alive: true }];
    w.mines = [{ id: 2, ownerId: 999, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }];
    w.blasts = [{ id: 3, ownerId: 999, credit: { source: 'blast', ownerId: 999 }, pos: { x: 0, y: 0 }, age: 0 }];
    w.tick = 500;
    const beforeRoundStart = w.roundStartTick;

    resolveStatus(w, [destroyed(A_ID), destroyed(B_ID)]);

    expect(w.lives).toBe(1);
    expect(w.status).toBe('playing');
    // Every tank -- players AND the enemy -- alive again, at its OWN spawns[idx].
    expect(a.alive).toBe(true);
    expect(a.pos).toEqual(PLAYER_SPAWNS[0].pos);
    expect(b.alive).toBe(true);
    expect(b.pos).toEqual(PLAYER_SPAWNS[1].pos);
    expect(enemy.alive).toBe(true); // resetArena is whole-board, not player-only
    expect(w.walls[0].destroyed).toBe(false);
    expect(w.bullets).toEqual([]);
    expect(w.mines).toEqual([]);
    expect(w.blasts).toEqual([]);
    expect(w.roundStartTick).toBeGreaterThan(beforeRoundStart);
    expect(w.roundStartTick).toBe(w.tick + 1); // re-arms countdown/grace, resetArena's own convention
  });

  it('a round reset clears the AI turret angular velocity (issue #347)', () => {
    // resetArena snaps every turret to its spawn angle. Without clearing the velocity the
    // enemy comes back pointing the right way but still SWINGING at whatever rate it died
    // carrying, so the new round opens with a turret already in motion for no reason -- and
    // accelSlew would then have to brake it before it could track anything.
    const w = coopWorld(2);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    const enemy = tankById(w, 3);
    enemy.turretVel = 0.03; // mid-swing when the wipe lands
    a.alive = false;
    b.alive = false;

    resolveStatus(w, [destroyed(A_ID), destroyed(B_ID)]);

    expect(enemy.alive).toBe(true);
    expect(enemy.turretVel ?? 0).toBe(0);
  });

  it('a full wipe at lives === 1 drains to 0 and calls lose -- WITHOUT resetArena (tanks stay dead, in place)', () => {
    const w = coopWorld(1);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    a.alive = false;
    a.pos = { x: 1, y: 1 };
    b.alive = false;
    b.pos = { x: 2, y: 2 };
    w.walls = [{ id: 99, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'destructible', destroyed: true }];
    const events: SimEvent[] = [destroyed(A_ID), destroyed(B_ID)];

    resolveStatus(w, events);

    expect(w.lives).toBe(0);
    expect(w.status).toBe('lose');
    expect(events.some((e) => e.type === 'lose')).toBe(true);
    // No resetArena on the zero-lives branch: the corpses are left exactly where they fell.
    expect(a.alive).toBe(false);
    expect(a.pos).toEqual({ x: 1, y: 1 });
    expect(b.alive).toBe(false);
    expect(b.pos).toEqual({ x: 2, y: 2 });
    expect(w.walls[0].destroyed).toBe(true); // untouched
  });

  it('does not stamp respawnAtTick on the wipe path either -- attempts mode never uses it', () => {
    const w = coopWorld(2);
    tankById(w, A_ID).alive = false;
    tankById(w, B_ID).alive = false;
    resolveStatus(w, [destroyed(A_ID), destroyed(B_ID)]);
    expect(tankById(w, A_ID).respawnAtTick).toBeUndefined();
    expect(tankById(w, B_ID).respawnAtTick).toBeUndefined();
  });

  it('stepRespawns is naturally inert in attempts mode: a lone corpse is never revived mid-round through the real pipeline', () => {
    // No second gate added anywhere -- resolveStatusCoop's attempts branch never sets
    // respawnAtTick, so stepRespawns (still called unconditionally by stepInputs at
    // countPlayerTanks >= 2) simply finds nothing to do every tick.
    // enemyAlive = false: this test is about respawn SCHEDULING, and a live enemy makes it
    // about enemy marksmanship instead. With the brown shooting, whether B survives all 300
    // ticks decides whether the round wipes and restarts -- and a round restart revives A
    // through a completely different path than the stepRespawns one under test here. Issue
    // #344's aim hold shifted that outcome and reddened this, which is the tell that the
    // enemy was load-bearing for a reason the test never intended.
    let w = coopWorld(3, true, false);
    const a = tankById(w, A_ID);
    a.alive = false;
    let world = w;
    for (let i = 0; i < 300; i++) {
      const r = stepInputs(world, [{ move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false }, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false }]);
      world = r.world;
    }
    const revivedA = world.tanks.find((t) => t.id === A_ID)!;
    expect(revivedA.alive).toBe(false); // still down 300 ticks later -- 5s at TICK_HZ, well past RESPAWN_DELAY_TICKS (120)
    expect(revivedA.respawnAtTick).toBeUndefined();
    // stepRespawns called directly on this same corpse (no respawnAtTick set) is
    // ALSO a no-op -- confirms the inertness is because nothing is ever scheduled, not
    // because of a second gate stopping stepRespawns itself from running.
    const events: SimEvent[] = [];
    stepRespawns(world, events);
    expect(world.tanks.find((t) => t.id === A_ID)!.alive).toBe(false);
    expect(events).toEqual([]);
  });

  it('players.length < 2 regression: attempts mode is inert at 1P -- the coop guard in resolveStatus is unchanged', () => {
    const onePlayer = createWorld({
      walls: [],
      tanks: [makeTank('player', A_ID, 5, 5, false), makeTank('brown', 3, 10, 10)],
      // A spawn per tank -- resetArena (reachable here, since the lone enemy stays
      // alive and the death branch fires, unlike coop-respawn.test.ts's own version
      // of this fixture, which keeps the enemy dead too so allEnemiesDead wins first
      // and resetArena is never reached).
      spawns: [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }, { kind: 'brown', pos: { x: 10, y: 10 }, angle: 0 }],
      lives: 2,
      coopAttempts: true,
    });
    const events: SimEvent[] = [destroyed(A_ID)];
    resolveStatus(onePlayer, events);
    // The 1P body: player dead, lives -1, resetArena (lives still > 0 after decrement).
    expect(onePlayer.lives).toBe(1);
    expect(onePlayer.status).toBe('playing');
    expect(onePlayer.tanks.find((t) => t.id === A_ID)!.alive).toBe(true); // resetArena revived it
  });
});

describe('resolveStatusCoop: POOL MODE, explicitly requested (world.coopAttempts: false) -- pool-mode regression, without touching coop-respawn.test.ts', () => {
  // coop-respawn.test.ts pins the shipped pool model against worlds built via bare
  // createWorld() calls that predate this field -- under the new default (true) those
  // worlds now exercise ATTEMPTS mode instead, which is why 3 of its 22 tests read
  // differently post-this-PR (reported, not silently fixed there; see the plan doc's
  // "deviations" section). The assertions below are the SAME shipped-model claims,
  // reproduced against a world that explicitly asks for pool mode -- proving the
  // POOL MODE branch inside resolveStatusCoop still behaves exactly as before when it
  // is actually selected, which is what "byte-untouched" claims about.
  it('a single player death drains the pool by 1 and schedules a respawn (pool mode\'s own rule, still true when explicitly selected)', () => {
    const w = coopWorld(3, false);
    w.tick = 100;
    const a = tankById(w, A_ID);
    a.pos = { x: 12, y: 9 };
    a.alive = false;
    const events: SimEvent[] = [destroyed(A_ID)];

    resolveStatus(w, events);

    expect(w.lives).toBe(2);
    expect(a.alive).toBe(false);
    expect(a.respawnAtTick).toBe(100 + 120); // RESPAWN_DELAY_TICKS
    expect(w.status).toBe('playing');
  });

  it('simultaneous double death at pool 2: one revives, the other stays down permanently (still true when explicitly selected)', () => {
    const w = coopWorld(2, false);
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    a.alive = false;
    b.alive = false;
    const events: SimEvent[] = [destroyed(A_ID), destroyed(B_ID)];

    resolveStatus(w, events);

    expect(w.lives).toBe(0);
    expect(a.respawnAtTick).toBeDefined();
    expect(b.respawnAtTick).toBeUndefined();
    expect(w.status).toBe('playing'); // pendingRespawn blocks the lose
  });

  it('resetArena is unreachable from pool mode: a full wipe with lives remaining schedules per-tank respawns instead, never calling resetArena', () => {
    // Pool mode has no full-wipe branch at all -- verify directly: walls/bullets a
    // resetArena call would clear are left untouched even when both players are down
    // with lives still in the pool.
    const w = coopWorld(3, false);
    w.walls = [{ id: 99, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'destructible', destroyed: true }];
    w.bullets = [{ id: 1, ownerId: 999, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 0, alive: true }];
    const a = tankById(w, A_ID);
    const b = tankById(w, B_ID);
    a.alive = false;
    b.alive = false;
    resolveStatus(w, [destroyed(A_ID), destroyed(B_ID)]);

    expect(w.walls[0].destroyed).toBe(true); // NOT restored -- resetArena never ran
    expect(w.bullets).toHaveLength(1); // NOT cleared
    // Both got their own scheduled respawn instead (pool 3 -> 2 -> 1, both > 0).
    expect(a.respawnAtTick).toBeDefined();
    expect(b.respawnAtTick).toBeDefined();
  });
});

describe('resetArena via a full wipe, verified at N=2 and N=4 on a real shipped arena', () => {
  // Real createWorldFor output: real walls, real enemy roster, real spawns array --
  // the index invariant (world.tanks[i] <-> world.spawns[i]) this exercises is the
  // same one stepRespawns' own P2 test insures, extended here to the whole-board
  // resetArena path and to N=4.
  function realCoopWorld(playerCount: number, lives: number): World {
    return createWorldFor(ARENAS[0], 1, undefined, lives, undefined, undefined, playerCount, true);
  }

  for (const n of [2, 4]) {
    it(`N=${n}: a full wipe with lives remaining revives every player AND every enemy at its own spawns[idx], restores walls, clears mines/bullets/blasts`, () => {
      const w = realCoopWorld(n, 3);
      const players = w.tanks.filter((t) => t.kind === 'player');
      expect(players).toHaveLength(n);
      const enemies = w.tanks.filter((t) => t.kind !== 'player');
      expect(enemies.length).toBeGreaterThan(0);

      // Move and kill every player; damage a wall; leave a mine/bullet/blast behind.
      const events: SimEvent[] = [];
      for (const p of players) {
        p.pos = { x: p.pos.x + 3, y: p.pos.y + 3 };
        p.alive = false;
        events.push(destroyed(p.id));
      }
      const destructible = w.walls.find((wall) => wall.kind === 'destructible');
      if (destructible) destructible.destroyed = true;
      w.bullets = [{ id: 501, ownerId: 999, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 0, alive: true }];
      w.mines = [{ id: 502, ownerId: 999, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }];
      w.blasts = [{ id: 503, ownerId: 999, credit: { source: 'blast', ownerId: 999 }, pos: { x: 0, y: 0 }, age: 0 }];

      resolveStatus(w, events);

      expect(w.lives).toBe(2);
      expect(w.status).toBe('playing');
      // Index invariant: every tank (players in their controlledBy order, THEN
      // enemies -- world.tanks[i] <-> world.spawns[i] for the whole array) lands back
      // on its own spawn cell, alive.
      for (let i = 0; i < w.tanks.length; i++) {
        expect(w.tanks[i].alive, `tank ${i} (${w.tanks[i].kind})`).toBe(true);
        expect(w.tanks[i].pos, `tank ${i} (${w.tanks[i].kind})`).toEqual(w.spawns[i].pos);
      }
      expect(w.walls.some((wall) => wall.destroyed)).toBe(false);
      expect(w.bullets).toEqual([]);
      expect(w.mines).toEqual([]);
      expect(w.blasts).toEqual([]);
    });
  }
});
