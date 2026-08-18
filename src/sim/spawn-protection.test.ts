import { describe, it, expect } from 'vitest';
import { createWorld, applyPlayerInput, applyPlayerInputs, stepInputs } from './world';
import type { World } from './world';
import type { Tank, Spawn, InputState } from './types';
import type { SimEvent } from './events';
import { COUNTDOWN_TICKS, GRACE_TICKS, RESPAWN_SHIELD_TICKS } from './constants';
import { decidePlayerInput, mulberry32 } from './ai/player-profile';
import type { PlayerAiState } from './ai/player-profile';

/**
 * Spawn protection's ACTION half: "a brief period of invincibility on respawn where
 * shots can't be fired and mines can't be placed... only movement [is unrestricted]".
 * DAMAGE immunity (isDamageImmune, shieldUntilTick washing over a hit) already existed
 * and is pinned elsewhere (bullets.test.ts, mines.test.ts); this file is the NEW half --
 * isActionLocked (types.test.ts pins the predicate itself) wired into driveTank's
 * canAct (world.ts), the single site every kind==='player' tank's fire/mine input is
 * consumed, human or bot.
 *
 * Deliberately NOT the round countdown/grace (`roundPhase`, COUNTDOWN_TICKS/GRACE_TICKS)
 * -- that is a per-WORLD gate applied uniformly to every tank; every fixture here pushes
 * `roundStartTick` far into the past so the round-phase gate reads 'live' throughout,
 * isolating the per-TANK shield gate this file actually tests.
 */

function makeTank(kind: Tank['kind'], id: number, x: number, y: number, overrides: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
    ...overrides,
  };
}

function alwaysLive(world: World): World {
  world.roundStartTick = -(COUNTDOWN_TICKS + GRACE_TICKS) - 1;
  return world;
}

const idle: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };

describe('the human input path: a shielded tank cannot fire or lay a mine', () => {
  function fixture(shieldUntilTick: number | undefined, tick: number): World {
    const player = makeTank('player', 1, 5, 5, { shieldUntilTick });
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }];
    const w = alwaysLive(createWorld({ walls: [], tanks: [player], spawns, lives: 3 }));
    w.tick = tick;
    return w;
  }

  it('fire is refused while shielded: no bullet, no fire event, cooldown NOT spent', () => {
    const w = fixture(100, 50); // 50 < 100 -- locked
    const events: SimEvent[] = [];
    const fireAt: InputState = { move: { x: 0, y: 0 }, aim: { x: 10, y: 5 }, fire: true, mine: false };
    applyPlayerInput(w, fireAt, events);
    expect(w.bullets.length).toBe(0);
    expect(events.some((e) => e.type === 'fire')).toBe(false);
    expect(w.tanks[0].fireCooldown).toBe(0); // a refused shot must not burn the cooldown
  });

  it('mine-laying is refused while shielded: no mine, no mine-dropped event, cooldown NOT spent', () => {
    const w = fixture(100, 50);
    const events: SimEvent[] = [];
    const mineAt: InputState = { move: { x: 0, y: 0 }, aim: { x: 10, y: 5 }, fire: false, mine: true };
    applyPlayerInput(w, mineAt, events);
    expect(w.mines.length).toBe(0);
    expect(events.some((e) => e.type === 'mine-dropped')).toBe(false);
    expect(w.tanks[0].mineCooldown).toBe(0);
  });

  it('movement is NOT gated by the shield -- only fire/mine are', () => {
    const w = fixture(100, 50);
    const player = w.tanks[0];
    const moveInput: InputState = { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };
    applyPlayerInput(w, moveInput, []);
    expect(player.desiredMove).toEqual({ x: 1, y: 0 }); // driveTank sets this unconditionally in 'live'
  });

  it('turret aim is NOT gated by the shield -- it slews toward the cursor exactly as when unshielded', () => {
    const w = fixture(100, 50);
    const player = w.tanks[0]; // pos (5,5), turretAngle starts at 0
    // Aim straight "up" (+y): aimDir = (0,5)-(5,5)... i.e. (5,10)-(5,5) = (0,5) -> pi/2,
    // a real turn from the starting 0 -- unlike aiming along +x, which needs none.
    const aimInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 5, y: 10 }, fire: false, mine: false };
    applyPlayerInput(w, aimInput, []);
    expect(player.turretAngle).toBeGreaterThan(0); // slewed toward pi/2, one tick's worth
  });

  it('fire works again the tick the shield expires (boundary: tick === shieldUntilTick unlocks, matching isDamageImmune)', () => {
    const w = fixture(100, 100); // 100 < 100 is false -- unlocked
    const events: SimEvent[] = [];
    const fireAt: InputState = { move: { x: 0, y: 0 }, aim: { x: 10, y: 5 }, fire: true, mine: false };
    applyPlayerInput(w, fireAt, events);
    expect(w.bullets.length).toBe(1);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
  });

  it('a tank with no shieldUntilTick at all fires normally (the common case, unaffected)', () => {
    const w = fixture(undefined, 50);
    const events: SimEvent[] = [];
    const fireAt: InputState = { move: { x: 0, y: 0 }, aim: { x: 10, y: 5 }, fire: true, mine: false };
    applyPlayerInput(w, fireAt, events);
    expect(w.bullets.length).toBe(1);
  });

  it('`invincible` alone does NOT lock fire/mine -- the dev playtest cheat is a damage cheat, not an action lock', () => {
    const w = fixture(undefined, 50);
    w.tanks[0].invincible = true;
    const events: SimEvent[] = [];
    const fireAt: InputState = { move: { x: 0, y: 0 }, aim: { x: 10, y: 5 }, fire: true, mine: false };
    applyPlayerInput(w, fireAt, events);
    expect(w.bullets.length).toBe(1);
  });
});

describe('the bot input path: the sim gate blocks a shielded bot exactly as it blocks a human, at the same choke point', () => {
  // A bot-claimed slot's InputState (game/loop.ts wiring) is generated by
  // ai/player-profile.ts's decidePlayerInput and consumed through the SAME
  // applyPlayerInputs -> driveTank path a human's InputState is -- there is no second
  // gate anywhere else to maintain. Proven here rather than argued: the fixture puts a
  // real opponent in sight, past reactionTime, so the bot's OWN computed decision
  // actually wants to fire -- a vacuous fixture (one that never wants to fire anyway)
  // would pass this test whether or not the gate existed at all.
  function fixture(shieldUntilTick: number | undefined): { world: World; bot: Tank } {
    const bot = makeTank('player', 1, 5, 5, { shieldUntilTick });
    const enemy = makeTank('brown', 2, 8, 5); // dead ahead, well within weapon range, clear LOS
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
      { kind: 'brown', pos: { x: 8, y: 5 }, angle: 0 },
    ];
    const world = alwaysLive(createWorld({ walls: [], tanks: [bot, enemy], spawns, lives: 3 }));
    world.tick = 50;
    return { world, bot };
  }

  // STATIC_BASIC (the player's resolved profile): reactionTime 0.8s * TICK_HZ 60 = 48
  // ticks. Pre-seeding state.aimTicks at that threshold stands in for 48 prior ticks of
  // an already-held solution, matching coop-respawn.test.ts's own established shortcut
  // for the identical reaction-gate arithmetic.
  const REACTION_TICKS = 48;
  function heldSolutionState(): PlayerAiState {
    return { aimTicks: REACTION_TICKS, wanderHeading: 0, wanderTicksLeft: 1000, mineInclined: false };
  }

  it('control: unshielded, the bot decision fires -- proves the fixture is genuinely lethal, not merely inert', () => {
    const { world, bot } = fixture(undefined);
    const input = decidePlayerInput(world, bot.id, mulberry32(1), heldSolutionState());
    expect(input.fire).toBe(true); // the bot's own decision wants to fire
    const events: SimEvent[] = [];
    applyPlayerInputs(world, [input], events);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
    expect(world.bullets.length).toBe(1);
  });

  it('shielded: the SAME bot decision still wants to fire, but the sim refuses it', () => {
    const { world, bot } = fixture(1000); // locked well past world.tick (50)
    const input = decidePlayerInput(world, bot.id, mulberry32(1), heldSolutionState());
    // Non-vacuous: decidePlayerInput knows nothing about shieldUntilTick, so its own
    // output is identical to the control above -- the gate lives downstream, in driveTank.
    expect(input.fire).toBe(true);
    const events: SimEvent[] = [];
    applyPlayerInputs(world, [input], events);
    expect(events.some((e) => e.type === 'fire')).toBe(false);
    expect(world.bullets.length).toBe(0);
    expect(bot.fireCooldown).toBe(0); // refused, not spent
  });

  it('shielded: mine-laying is refused the same way when the bot is inclined to lay one', () => {
    const { world, bot } = fixture(1000);
    // Force the mine inclination directly rather than searching for a seed that draws
    // one -- state.mineInclined is the caller-owned field decidePlayerInput reads, and
    // this is exactly the same "pre-seed the state" shortcut used for aimTicks above.
    const state: PlayerAiState = { aimTicks: 0, wanderHeading: 0, wanderTicksLeft: 1000, mineInclined: true };
    bot.pos = { x: 5, y: 5 };
    const enemy = world.tanks.find((t) => t.id === 2)!;
    enemy.pos = { x: 10, y: 5 }; // within tacticalRadius, outside minimumDistance
    const input = decidePlayerInput(world, bot.id, mulberry32(2), state);
    expect(input.mine).toBe(true); // non-vacuous: the bot's own decision wants to mine
    const events: SimEvent[] = [];
    applyPlayerInputs(world, [input], events);
    expect(events.some((e) => e.type === 'mine-dropped')).toBe(false);
    expect(world.mines.length).toBe(0);
  });
});

describe('spawn protection reaches coop POOL mode too, an existing per-tank respawn path', () => {
  // `?dev=1&coopPool=1` (World.coopAttempts = false): resolveStatusCoop's POOL MODE
  // block already drains a shared life and schedules a per-tank respawn on any player
  // death, and stepRespawns already stamps shieldUntilTick for every revival regardless
  // of mode -- so this feature is reachable here through machinery that predates it,
  // not a new code path. Exercised through the REAL pipeline (stepInputs), not a direct
  // stepRespawns call, so the ordering (respawn, then input, same tick) is genuine.
  function poolWorld(): World {
    const p1 = makeTank('player', 1, 5, 5, { controlledBy: 0 });
    const p2 = makeTank('player', 2, 15, 5, { alive: false, respawnAtTick: 1, controlledBy: 1 });
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
      { kind: 'player', pos: { x: 15, y: 5 }, angle: 0 },
    ];
    return alwaysLive(createWorld({ walls: [], tanks: [p1, p2], spawns, lives: 3, coopAttempts: false }));
  }

  it('the revived tank cannot fire on the very tick it revives', () => {
    const world = poolWorld();
    const fireAt: InputState = { move: { x: 0, y: 0 }, aim: { x: 16, y: 5 }, fire: true, mine: false };
    const r = stepInputs(world, [idle, fireAt]);
    const revived = r.world.tanks.find((t) => t.id === 2)!;
    expect(revived.alive).toBe(true);
    expect(revived.shieldUntilTick).toBeDefined();
    expect(r.events.some((e) => e.type === 'fire' && e.ownerId === 2)).toBe(false);
  });

  it('the same tank fires normally once its shield has lapsed', () => {
    let world = poolWorld();
    // Run the shield out. RESPAWN_SHIELD_TICKS worth of idle ticks after the revival
    // tick, plus one more to cross the boundary.
    const fireAt: InputState = { move: { x: 0, y: 0 }, aim: { x: 16, y: 5 }, fire: true, mine: false };
    for (let i = 0; i < RESPAWN_SHIELD_TICKS + 1; i++) {
      const r = stepInputs(world, [idle, idle]);
      world = r.world;
    }
    const r = stepInputs(world, [idle, fireAt]);
    expect(r.events.some((e) => e.type === 'fire' && e.ownerId === 2)).toBe(true);
  });
});
