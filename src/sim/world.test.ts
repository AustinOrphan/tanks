import { describe, it, expect } from 'vitest';
import { createWorld, cloneWorld, step, stepInputs } from './world';
import type { World } from './world';
import { resolveWorldRules, WORLD_RULE_KEYS, type WorldRules } from './rules';
import type { Tank, Wall, Spawn, InputState } from './types';
import { angleOf, vsub, slewAngle } from './types';
import { PLAYER_TURRET_TURN_RATE, DT } from './constants';

/**
 * One value per rule that is NOT its shipped default. Typed against WorldRules itself, so
 * a rule added later is a compile error HERE until it has a non-default sample -- and the
 * sweeps below then cover it with no edit of their own (issue #472: "a rule added later is
 * covered without editing the test"). The control test proves each sample really differs
 * from its default: a sample that equalled the default would let a clone that quietly
 * re-resolves from defaults pass every assertion.
 */
const NON_DEFAULT_RULES: { [K in keyof WorldRules]: WorldRules[K] } = {
  mode: 'ffa',
  friendlyFire: true,
  unarmedTrigger: 'both',
  aiTargetPerception: 'line-of-sight',
  corpseBlocksShells: true,
  muzzleClearsTanks: false,
  coopAttempts: false,
  arenaGeometry: { cols: 1, rows: 1, cellSize: 1, grid: ['.'], legend: {} },
};

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

/** Two live players on an open floor, under every non-default rule at once. */
function nonDefaultWorld(): World {
  const tanks = [makeTank(5, 2, 3), makeTank(6, 12, 3)];
  const walls = [makeWall(9)];
  const spawns: Spawn[] = [
    { kind: 'player', pos: { x: 2, y: 3 }, angle: 0 },
    { kind: 'player', pos: { x: 12, y: 3 }, angle: 0 },
  ];
  return createWorld({ walls, tanks, spawns, lives: 3, ...NON_DEFAULT_RULES });
}

describe('createWorld resolves the rules through the one boundary', () => {
  it('control: every NON_DEFAULT_RULES sample differs from the shipped default (population: all WORLD_RULE_KEYS)', () => {
    // Without this, a sample that happened to equal its default would make the survival
    // assertions below vacuous for that key. Swept, so a key added later is checked too.
    expect(WORLD_RULE_KEYS.length).toBeGreaterThan(0);
    const defaults = resolveWorldRules();
    for (const key of WORLD_RULE_KEYS) {
      expect(NON_DEFAULT_RULES[key], key).not.toEqual(defaults[key]);
    }
  });

  it('an init that states no rule gets exactly resolveWorldRules() -- the same object shape, every key', () => {
    expect(makeWorld().rules).toEqual(resolveWorldRules());
  });

  it('an init that states every rule gets every stated value, frozen (population: all WORLD_RULE_KEYS)', () => {
    const w = nonDefaultWorld();
    for (const key of WORLD_RULE_KEYS) expect(w.rules[key], key).toEqual(NON_DEFAULT_RULES[key]);
    expect(Object.isFrozen(w.rules)).toBe(true);
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

  it('carries the rules as ONE object: the same reference, every rule intact (population: all WORLD_RULE_KEYS)', () => {
    // The clone used to copy each rule by name, and #471 was the field it forgot: an
    // OPTIONAL `aiTargetPerception`, read downstream as `?? 'full'`, so the loss surfaced
    // as the shipped default rather than as `undefined`. The rules are frozen, so one
    // shared reference is both the cheapest copy and the one that cannot omit a key.
    // Reference identity is asserted first because it is the stronger claim; the
    // per-key sweep is what would localise a regression to a rule if that ever broke.
    const w = nonDefaultWorld();
    const c = cloneWorld(w);
    expect(c.rules).toBe(w.rules);
    for (const key of WORLD_RULE_KEYS) expect(c.rules[key], key).toEqual(NON_DEFAULT_RULES[key]);
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

  it('preserves every resolved rule exactly across repeated real stepInputs ticks (population: all WORLD_RULE_KEYS, 5 ticks)', () => {
    // stepInputs clones every tick, so a rule the clone lost -- or re-resolved from its
    // default -- would read back wrong from tick 1 even though tick 0 was built
    // correctly. Neither a single-clone test nor the golden trace can see that: the trace
    // runs every world on the shipped defaults, which is exactly the value a lost rule
    // reverts to. Two live players keep an 'ffa' world in play for all 5 ticks, so this
    // exercises the full stage pipeline and not only the clone-then-latch path.
    const original = nonDefaultWorld();
    let w = original;
    for (let i = 0; i < 5; i++) w = stepInputs(w, [noInput, noInput]).world;
    expect(w.tick).toBe(5);
    expect(w.status).toBe('playing');
    expect(w.rules).toBe(original.rules);
    for (const key of WORLD_RULE_KEYS) expect(w.rules[key], key).toEqual(NON_DEFAULT_RULES[key]);
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
});
