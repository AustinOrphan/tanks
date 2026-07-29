import { describe, it, expect } from 'vitest';
import { createWorld, applyPlayerInput, resolveStatus, step } from './world';
import type { World } from './world';
import type { Tank, Spawn, InputState } from './types';
import type { SimEvent } from './events';
import { FIRE_COOLDOWN_TICKS, COUNTDOWN_TICKS, GRACE_TICKS, PLAYER_TURRET_TURN_RATE, DT } from './constants';
import { stepAi } from './ai';

function makeTank(kind: Tank['kind'], id: number, x: number, y: number): Tank {
  return {
    id,
    kind,
    pos: { x, y },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

// TWO enemies, not one. With a single enemy `enemies.every(dead)` and
// `enemies.some(dead)` are the same predicate, so a one-enemy fixture cannot
// tell a correct win condition from one that fires on the first kill -- and the
// shipped arena has three enemies.
function makeWorld(): World {
  const player = makeTank('player', 1, 5, 5);
  const brown = makeTank('brown', 2, 5, 15);
  const grey = makeTank('grey', 3, 15, 15);
  const spawns: Spawn[] = [
    { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
    { kind: 'brown', pos: { x: 5, y: 15 }, angle: 0 },
    { kind: 'grey', pos: { x: 15, y: 15 }, angle: 0 },
  ];
  const world = createWorld({ walls: [], tanks: [player, brown, grey], spawns, lives: 3 });
  // This file's tests (all written before round phases existed) are about pipeline/
  // cooldown/status mechanics, not round phases -- push roundStartTick far into the
  // past so world.tick=0 already reads as 'live'. The round-phase-specific tests below
  // set roundStartTick explicitly instead of relying on this helper.
  world.roundStartTick = -(COUNTDOWN_TICKS + GRACE_TICKS) - 1;
  return world;
}

const fireInput: InputState = {
  move: { x: 0, y: 0 },
  aim: { x: 10, y: 5 }, // straight to the +x of the player at (5,5) -> angle 0
  fire: true,
  mine: false,
};

describe('applyPlayerInput', () => {
  it('aims the turret at the cursor independent of body facing', () => {
    const w = makeWorld();
    const player = w.tanks[0];
    player.bodyAngle = Math.PI; // body faces the other way
    applyPlayerInput(w, { ...fireInput, fire: false }, []);
    expect(player.turretAngle).toBeCloseTo(0, 10);
    expect(player.bodyAngle).toBe(Math.PI); // unchanged
  });

  it('fires once, spends the cooldown, then refuses until it elapses', () => {
    const w = makeWorld();
    const events: SimEvent[] = [];
    applyPlayerInput(w, fireInput, events);
    expect(w.bullets.length).toBe(1);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
    expect(w.tanks[0].fireCooldown).toBe(FIRE_COOLDOWN_TICKS);

    // Immediately press fire again: cooldown not yet elapsed -> no new shell.
    applyPlayerInput(w, fireInput, []);
    expect(w.bullets.length).toBe(1);
  });

  // Turrets now turn at a finite rate (slewAngle, types.ts) instead of snapping. A mouse
  // jump straight behind the tank (a full 180-degree flip) is the extreme case: current=0,
  // target=pi, which is the antipodal tie in slewAngle -- deterministic but arbitrary in
  // direction (see slewAngle's doc comment). Empirically (and by the tie-break rule: a raw
  // delta of exactly +pi is left unchanged by the wrap correction, so it resolves
  // positive/CCW), this steps positive: tick 1 lands at +maxDelta, not at pi.
  it('a mouse jump straight behind the tank does NOT snap the turret there in one tick; it slews at PLAYER_TURRET_TURN_RATE', () => {
    const w = makeWorld();
    const player = w.tanks[0]; // pos (5,5), turretAngle starts at 0 (makeTank default)
    const maxDelta = PLAYER_TURRET_TURN_RATE * DT; // 8.0/60 = 0.13333... rad/tick
    // Aim point behind the player along -x: aimDir = (0,5)-(5,5) = (-5,0) -> angle = pi.
    const behindInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 5 }, fire: false, mine: false };

    applyPlayerInput(w, behindInput, []); // tick 1
    expect(player.turretAngle).toBeCloseTo(maxDelta, 12); // one tick's worth, not pi

    // It takes ceil(pi / maxDelta) = ceil(23.5619...) = 24 ticks to arrive at the target.
    // 22 more calls brings the total to tick 23 (23*maxDelta ~= 3.0667 < pi -> not arrived).
    for (let i = 0; i < 22; i++) applyPlayerInput(w, behindInput, []);
    expect(player.turretAngle).toBeCloseTo(23 * maxDelta, 10);
    expect(player.turretAngle).toBeLessThan(Math.PI); // tick 23: not yet arrived
    applyPlayerInput(w, behindInput, []); // tick 24: remaining (~0.0749) <= maxDelta -> snaps to target exactly
    expect(player.turretAngle).toBeCloseTo(Math.PI, 12);
  });
});

describe('resolveStatus', () => {
  it('restarts the arena (revives enemies, restores walls) and decrements lives while lives remain', () => {
    const w = makeWorld();
    const player = w.tanks[0];
    const enemy = w.tanks[1]; // brown, spawn-aligned at index 1
    player.alive = false;
    player.pos = { x: 99, y: 99 };
    enemy.alive = false; // one of the two enemies was destroyed earlier this life
    // a destructible wall blown open earlier this life
    w.walls.push({ id: 99, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'destructible', destroyed: true });
    resolveStatus(w, []);
    expect(w.lives).toBe(2);
    expect(player.alive).toBe(true);
    expect(player.pos).toEqual({ x: 5, y: 5 }); // player back at spawn
    expect(enemy.alive).toBe(true); // arena restarted -> enemy revived
    expect(enemy.pos).toEqual({ x: 5, y: 15 }); // enemy back at its spawn
    expect(w.walls[0].destroyed).toBe(false); // destroyed wall restored
    expect(w.status).toBe('playing');
  });

  it('emits lose and sets status when the player dies at 1 life', () => {
    const w = makeWorld();
    w.lives = 1;
    w.tanks[0].alive = false;
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.lives).toBe(0);
    expect(w.status).toBe('lose');
    expect(events).toContainEqual({ type: 'lose' });
  });

  it('emits win only when EVERY enemy is destroyed, not the first', () => {
    const w = makeWorld();
    w.tanks[1].alive = false; // one of two enemies down
    let events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('playing');
    expect(events).toEqual([]);

    w.tanks[2].alive = false; // now the last one
    events = [];
    resolveStatus(w, events);
    expect(w.status).toBe('win');
    expect(events).toContainEqual({ type: 'win' });
  });

  it('does not re-emit win when called again on an already-won world', () => {
    const w = makeWorld();
    w.tanks[1].alive = false;
    w.tanks[2].alive = false;
    resolveStatus(w, []);
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    resolveStatus(w, events);
    expect(events).toEqual([]); // one win, one victory stinger
  });

  it('counts a mutual kill as a win rather than discarding it', () => {
    // Trading your last kill for a life used to lose the win entirely:
    // resetArena revived the enemies before the win check ran, so the player
    // silently paid a life and the arena restarted.
    const w = makeWorld();
    w.tanks[0].alive = false;
    w.tanks[1].alive = false;
    w.tanks[2].alive = false;
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('win');
    expect(w.lives).toBe(3); // no life deducted
    expect(events).toContainEqual({ type: 'win' });
  });

  it('does nothing while both sides have live tanks', () => {
    const w = makeWorld();
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('playing');
    expect(events).toEqual([]);
  });
});

describe('step() composition (full pipeline)', () => {
  const PLAYER_ID = 1;
  const BROWN_ID = 2;
  // Ownership-scoped, not index/count-scoped: since Task 22 wired stepAi into step(),
  // Brown (clear LOS to the player at this fixture's positions, no walls) legitimately
  // fires its own shell through this same pipeline by tick 2 (idle -> aim -> fire). A bare
  // world.bullets.length/[0] no longer identifies "the player's shell" once more than one
  // tank can be firing through the pipeline, so these helpers pick it out by ownerId
  // instead of relying on "the AI happens not to shoot" (which relocating Brown would).
  const playerShells = (wld: World) => wld.bullets.filter((b) => b.ownerId === PLAYER_ID);

  it('runs the whole pipeline in one tick: fires, threads the fire event, and advances the shell', () => {
    const w = makeWorld();
    const r1 = step(w, fireInput);
    expect(playerShells(r1.world)).toHaveLength(1);
    expect(r1.events.some((e) => e.type === 'fire')).toBe(true);
    const bx1 = playerShells(r1.world)[0].pos.x; // spawned at x=5, advanced +x this same tick
    expect(bx1).toBeGreaterThan(5);
    // next tick (no new fire): the player's existing shell keeps advancing along +x
    const r2 = step(r1.world, { ...fireInput, fire: false });
    expect(playerShells(r2.world)).toHaveLength(1);
    expect(playerShells(r2.world)[0].pos.x).toBeGreaterThan(bx1);
    // Deliberate coverage (not incidental): Brown has clear LOS to the player and, now
    // that AI is live, reaches its 'fire' state and produces its own shell by tick 2 --
    // this is the only place in the suite where the player's and an enemy's fire paths
    // both run through one pipeline in the same ticks.
    expect(r2.world.bullets.some((b) => b.ownerId === BROWN_ID)).toBe(true);
  });

  it('reports win through the pipeline when the last enemy is already dead', () => {
    const w = makeWorld();
    w.tanks[1].alive = false;
    w.tanks[2].alive = false; // every enemy dead going in
    const r = step(w, { ...fireInput, fire: false });
    expect(r.world.status).toBe('win');
    expect(r.events).toContainEqual({ type: 'win' });
  });

  it('latches a finished game: once status is not playing, step() skips the pipeline', () => {
    const w = makeWorld();
    w.tanks[1].alive = false;
    w.tanks[2].alive = false;
    const won = step(w, { ...fireInput, fire: false }).world;
    expect(won.status).toBe('win');
    // further input is ignored: firing produces no shell, status stays win
    const after = step(won, fireInput);
    expect(after.world.bullets.length).toBe(0);
    expect(after.world.status).toBe('win');
  });
});

describe('round phases (player path via applyPlayerInput)', () => {
  // Fresh worlds here (NOT makeWorld(), which deliberately bypasses round phases) so
  // roundStartTick is the real createWorld default of 0.
  function freshWorld(): World {
    const player = makeTank('player', 1, 5, 5);
    const brown = makeTank('brown', 2, 5, 15);
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
      { kind: 'brown', pos: { x: 5, y: 15 }, angle: 0 },
    ];
    return createWorld({ walls: [], tanks: [player, brown], spawns, lives: 3 });
  }

  it('countdown: commanded movement is blocked and fire spawns no bullet, but the turret still tracks the aim point', () => {
    const w = freshWorld();
    const player = w.tanks[0];
    player.turretAngle = Math.PI; // starts facing away from the aim point (angle 0)
    const events: SimEvent[] = [];
    applyPlayerInput(w, { move: { x: 1, y: 0 }, aim: fireInput.aim, fire: true, mine: false }, events);
    expect(player.desiredMove).toEqual({ x: 0, y: 0 });
    expect(w.bullets.length).toBe(0);
    expect(events.some((e) => e.type === 'fire')).toBe(false);
    // Turret DOES update during countdown: aiming is the whole point of the phase. But it
    // only SLEWS, one tick's worth toward the target -- current=pi, target=0 is the
    // antipodal tie in slewAngle (see its doc comment); here the raw (target - current) =
    // -pi is already in range and left unchanged by the wrap correction, so it resolves
    // negative: current - maxDelta, not straight to the target.
    const maxDelta = PLAYER_TURRET_TURN_RATE * DT;
    expect(player.turretAngle).toBeCloseTo(Math.PI - maxDelta, 10);
  });

  it('the tick countdown ends on is fully live: it moves, fires AND mines', () => {
    // GRACE_TICKS is 0, so there is no longer a window where you may drive but not
    // shoot. This is the assertion that fails if grace is switched back on without
    // anyone deciding to -- the old version of this test asserted the opposite.
    expect(GRACE_TICKS).toBe(0);
    const w = freshWorld();
    // roundStartTick is 1 (the first tick step() will simulate), so the first tick
    // after the countdown is COUNTDOWN_TICKS + 1, not COUNTDOWN_TICKS.
    w.tick = COUNTDOWN_TICKS + 1;
    const player = w.tanks[0];
    applyPlayerInput(w, { move: { x: 1, y: 0 }, aim: fireInput.aim, fire: true, mine: true }, []);
    expect(player.desiredMove).toEqual({ x: 1, y: 0 });
    expect(w.bullets.length).toBe(1);
    expect(w.mines.length).toBe(1);
  });

  it('boundary: the last countdown tick suppresses fire; the very next tick fires', () => {
    const lastCountdown = freshWorld();
    lastCountdown.tick = COUNTDOWN_TICKS; // elapsed = COUNTDOWN_TICKS - 1, still counting
    applyPlayerInput(lastCountdown, fireInput, []);
    expect(lastCountdown.bullets.length).toBe(0);

    const firstLive = freshWorld();
    firstLive.tick = COUNTDOWN_TICKS + 1;
    applyPlayerInput(firstLive, fireInput, []);
    expect(firstLive.bullets.length).toBe(1);
  });

  it('boundary: the last countdown tick still blocks movement; the first grace tick allows it', () => {
    const lastCountdown = freshWorld();
    lastCountdown.tick = COUNTDOWN_TICKS; // elapsed = COUNTDOWN_TICKS - 1
    applyPlayerInput(lastCountdown, { move: { x: 1, y: 0 }, aim: fireInput.aim, fire: false, mine: false }, []);
    expect(lastCountdown.tanks[0].desiredMove).toEqual({ x: 0, y: 0 });

    const firstGrace = freshWorld();
    firstGrace.tick = COUNTDOWN_TICKS + 1;
    applyPlayerInput(firstGrace, { move: { x: 1, y: 0 }, aim: fireInput.aim, fire: false, mine: false }, []);
    expect(firstGrace.tanks[0].desiredMove).toEqual({ x: 1, y: 0 });
  });

  it('RESPAWN: after resetArena runs (death with lives remaining), the round phases restart -- no tank can fire immediately after, even though world.tick is large', () => {
    const w = freshWorld();
    w.tick = 500000; // large absolute tick, deep into a long game
    const player = w.tanks[0];
    const brown = w.tanks[1]; // clear LOS to the player, no walls in this fixture
    player.alive = false; // this life just ended, lives remain (default lives=3)
    resolveStatus(w, []); // -> resetArena(w): revives both tanks AND resets roundStartTick

    expect(w.lives).toBe(2);
    expect(player.alive).toBe(true);
    // The NEXT tick step() will simulate, not the tick the reset happened on --
    // step() increments before evaluating the phase.
    expect(w.roundStartTick).toBe(500001);

    // Player: fire input on the very next evaluation still spawns nothing.
    applyPlayerInput(w, fireInput, []);
    expect(w.bullets.some((b) => b.ownerId === player.id)).toBe(false);

    // AI: Brown has a clear shot (no walls, revived at its spawn) but must not fire either.
    // Two calls so Brown's own idle->aim->fire state machine has a chance to reach 'fire'
    // (world.tick is untouched by stepAi, so the round phase is identical both times --
    // still countdown -- making this a real test of the gate, not just of Brown's own delay).
    stepAi(w, []);
    stepAi(w, []);
    expect(w.bullets.some((b) => b.ownerId === brown.id)).toBe(false);
  });
});

describe('cooldown cadence', () => {
  // Nothing pinned the CADENCE before -- only that a cooldown was spent -- so a
  // systematic off-by-one sat in every cooldown in the game unnoticed. Storing
  // seconds and subtracting DT each tick accumulates rounding, landing a hair
  // above zero after the intended count and costing one extra tick: 0.4s
  // delivered 25 ticks (0.41667s) and 0.5s delivered 31 (0.51667s).

  it('lets the player fire again after exactly FIRE_COOLDOWN, not a tick later', () => {
    const w = makeWorld();
    applyPlayerInput(w, fireInput, []);
    expect(w.bullets.length).toBe(1);

    // Tick it down without firing, then take the first shot it allows.
    let ticks = 0;
    for (let i = 0; i < 200; i++) {
      ticks++;
      applyPlayerInput(w, fireInput, []);
      if (w.bullets.length > 1) break;
    }
    expect(ticks).toBe(FIRE_COOLDOWN_TICKS);
    expect(ticks).toBe(24);
  });

  it('counts cooldowns in whole ticks, so repeated decrements cannot drift', () => {
    // The integer invariant is the fix. A float cooldown re-introduces the bug
    // the moment it is decremented more than a handful of times.
    const w = makeWorld();
    applyPlayerInput(w, fireInput, []);
    for (let i = 0; i < 10; i++) {
      applyPlayerInput(w, fireInput, []);
      expect(Number.isInteger(w.tanks[0].fireCooldown)).toBe(true);
    }
  });
});
