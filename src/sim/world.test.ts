import { describe, it, expect } from 'vitest';
import { createWorld, cloneWorld, step } from './world';
import type { World } from './world';
import type { Tank, Wall, Spawn, InputState } from './types';
import { angleOf, vsub, slewAngle } from './types';
import { PLAYER_TURRET_TURN_RATE, AI_TURRET_DEADBAND, DT } from './constants';

function makeTank(id: number, x: number, y: number): Tank {
  return {
    id,
    kind: 'player',
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

function makeWall(id: number): Wall {
  return { id, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'solid', destroyed: false };
}

function makeWorld(): World {
  const tanks = [makeTank(5, 2, 3)];
  const walls = [makeWall(9)];
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: 2, y: 3 }, angle: 0 }];
  return createWorld({ walls, tanks, spawns, lives: 3 });
}

const noInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };

describe('createWorld', () => {
  it('starts playing with empty bullet/mine arrays and given lives', () => {
    const w = makeWorld();
    expect(w.status).toBe('playing');
    expect(w.tick).toBe(0);
    expect(w.bullets).toEqual([]);
    expect(w.mines).toEqual([]);
    expect(w.lives).toBe(3);
  });

  it('sets nextId above the highest wall/tank id', () => {
    const w = makeWorld();
    expect(w.nextId).toBe(10); // max(9, 5) + 1
  });
});

describe('cloneWorld', () => {
  it('is a true deep copy', () => {
    const w = makeWorld();
    const c = cloneWorld(w);
    c.tanks[0].pos.x = 999;
    c.walls[0].aabb.minX = 999;
    c.lives = 1;
    expect(w.tanks[0].pos.x).toBe(2);
    expect(w.walls[0].aabb.minX).toBe(0);
    expect(w.lives).toBe(3);
  });

  it('carries corpseBlocksShells/muzzleClearsTanks across the clone -- a dropped field would silently', () => {
    // reset to false/true (the defaults) every tick, since stepInputs clones on every
    // call. Neither the golden trace nor a direct resolveBulletHits/spawnBullet unit
    // test can see that: the trace shows 0 reachability for the muzzle case and the
    // corpse default IS false, so a drop reproduces both. This is the only place that
    // proves the field survives the clone at all.
    const tanks = [makeTank(5, 2, 3)];
    const walls = [makeWall(9)];
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 2, y: 3 }, angle: 0 }];
    const w = createWorld({
      walls, tanks, spawns, lives: 3, corpseBlocksShells: true, muzzleClearsTanks: false,
    });
    const c = cloneWorld(w);
    expect(c.corpseBlocksShells).toBe(true);
    expect(c.muzzleClearsTanks).toBe(false);
  });
});

describe('step (skeleton)', () => {
  it('returns a NEW deep world, leaving the input untouched', () => {
    const w = makeWorld();
    const result = step(w, noInput);
    expect(result.world).not.toBe(w);
    result.world.tanks[0].pos.x = 777;
    expect(w.tanks[0].pos.x).toBe(2);
    expect(result.events).toEqual([]);
  });

  it('increments tick each call', () => {
    let w = makeWorld();
    w = step(w, noInput).world;
    expect(w.tick).toBe(1);
    w = step(w, noInput).world;
    expect(w.tick).toBe(2);
  });

  it('is deterministic: identical worlds + input give identical results', () => {
    const a = step(makeWorld(), noInput).world;
    const b = step(makeWorld(), noInput).world;
    expect(a).toEqual(b);
  });

  it('does not let corpseBlocksShells/muzzleClearsTanks decay across repeated real ticks', () => {
    // stepInputs clones every tick (cloneWorld) -- a field cloneWorld dropped would read
    // as `undefined` (falsy) from tick 2 onward even though tick 1 was built correctly,
    // which neither a single-clone test nor the golden trace would catch.
    const tanks = [makeTank(5, 2, 3)];
    const walls = [makeWall(9)];
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 2, y: 3 }, angle: 0 }];
    let w = createWorld({
      walls, tanks, spawns, lives: 3, corpseBlocksShells: true, muzzleClearsTanks: false,
    });
    for (let i = 0; i < 5; i++) w = step(w, noInput).world;
    expect(w.corpseBlocksShells).toBe(true);
    expect(w.muzzleClearsTanks).toBe(false);
  });
});

describe('driveTank: a literal {0,0} aim is not a neutral', () => {
  // Empirical confirmation of the N-player design's trace claim (docs/superpowers/
  // plans/2026-08-16-players-n.md), not merely reasoned from source: `aimDir =
  // vsub(input.aim, player.pos)` in driveTank (world.ts) is the literal difference
  // between the input's aim and the tank's OWN position, and the turret-slew guard
  // only skips when that difference is EXACTLY {0,0}. `noInput.aim` is the literal
  // {0,0} many input sources default to before they have real info (see
  // input/input.ts's own `let aim: Vec2 = {0, 0}`, and gamepad.ts's identical
  // default) -- for a tank spawned anywhere but the world origin, that default is
  // NOT the neutral it looks like: it is a real, nonzero aimDir pointing at (0,0).
  //
  // This is the mechanism, independent of which SOURCE produces the literal {0,0} --
  // pinned here once, permanently, since driveTank itself is not changing. The
  // source that must AVOID reproducing it (the no-pad branch of
  // createGamepadInputSource, which every co-player slot now uses -- n-player arc
  // PR3) is pinned separately, close to its own code: gamepad.test.ts.
  it('slews the turret toward world-origin when input.aim is {0,0} and the tank is not spawned there', () => {
    const w = makeWorld(); // tank at (2, 3), turretAngle 0 -- see makeTank/makeWorld above
    const result = step(w, noInput);
    const tank = result.world.tanks[0];

    expect(tank.turretAngle).not.toBe(0);
    // The EXACT expected value, not just "changed": one tick's worth of slew from 0
    // toward the origin-facing angle, at the same rate/dt driveTank itself uses.
    const targetAngle = angleOf(vsub({ x: 0, y: 0 }, { x: 2, y: 3 }));
    const expectedAngle = slewAngle(0, targetAngle, PLAYER_TURRET_TURN_RATE * DT);
    expect(tank.turretAngle).toBeCloseTo(expectedAngle, 12);
  });

  // Issue #330 added a deadband to the AI turret slew (ai/index.ts's stepAi) on purpose,
  // and just as deliberately did NOT add one here: a deadband on live player input reads
  // as input lag, not polish. This proves the player path still uses plain slewAngle by
  // placing the tank's current angle just inside AI_TURRET_DEADBAND of the target -- if the
  // player path had somehow gained the same deadband, this would freeze instead of moving.
  it('the player turret is NOT deadbanded (issue #330 is AI-only): a sub-deadband error still slews', () => {
    const w = makeWorld(); // tank at (2, 3)
    const targetAngle = angleOf(vsub({ x: 0, y: 0 }, { x: 2, y: 3 }));
    const before = targetAngle - AI_TURRET_DEADBAND / 2; // inside the AI deadband, if it applied here
    w.tanks[0].turretAngle = before;
    const result = step(w, noInput);
    const tank = result.world.tanks[0];
    // A deadbanded player would have stayed at `before`. Plain slewAngle instead closes
    // the (sub-tick-budget) gap exactly, reaching targetAngle in this one tick.
    expect(tank.turretAngle).not.toBe(before);
    expect(tank.turretAngle).toBeCloseTo(targetAngle, 10);
  });
});
