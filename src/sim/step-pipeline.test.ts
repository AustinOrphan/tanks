import { describe, it, expect } from 'vitest';
import { createWorld, step } from './world';
import type { World } from './world';
import type { Tank, Bullet, Mine, InputState } from './types';
import {
  DT,
  COUNTDOWN_TICKS,
  GRACE_TICKS,
  TANK_RADIUS,
  TANK_SPEED,
  BULLET_RADIUS,
  MINE_PROXIMITY_RADIUS,
  MINE_TIMER,
  bulletConfig,
} from './constants';

/**
 * Pins the COMPOSITION of step() -- that each stage is actually called, and called
 * in an order the game depends on.
 *
 * Why this file exists: the sim's unit files (movement.test.ts, bullets.test.ts,
 * mines.test.ts) call stepMovement/resolveBulletHits/stepMines DIRECTLY, so they
 * keep passing when step() stops calling them. Measured against the merged tree at
 * c668fdc: deleting `stepMines(draft, DT, events)` from step() left all 472 tests
 * green -- mines silently stopped existing. Deleting `stepMovement` or
 * `resolveBulletHits` was caught only incidentally, by one statistical whole-game
 * AI test (ai/pacifist.test.ts) whose failure message is about mine-laying cadence
 * and says nothing about the pipeline. Every test below is written to fail loudly,
 * and for the right reason, when its stage is removed or reordered.
 *
 * These assert through step() ONLY. Calling a stage directly here would defeat the
 * entire point of the file.
 *
 * MUTATION RECORD, measured against this file (harness controlled first: the identity
 * permutation survives, the full reversal GFEDCBA fails 7 tests here):
 *   - all 7 stage deletions fail here;
 *   - 4 of the 6 adjacent transpositions fail here;
 *   - 4 of 4 longer-range moves fail here.
 *
 * TWO MUTANTS SURVIVE THE WHOLE SUITE, and neither is harmless:
 *   - applyPlayerInput <-> stepAi: the AI reads the player's shell one tick late. Diverges
 *     from the shipped ordering in 10 of 12 seeded games; a 300-seed sweep flips win/lose
 *     on ~10. UNPINNED - the divergence is real but I found no single-tick observable that
 *     pins it without asserting a whole-game outcome, which is the fragile kind of test.
 *   - stepMovement <-> stepBullets: this one IS safe, and provably so rather than
 *     hopefully. The two stages have disjoint read/write sets (tanks+walls vs
 *     bullets+walls), and 12 full games under the swap are byte-identical to the
 *     shipped ordering. Left unpinned deliberately.
 *
 * An earlier version of this comment claimed all seven deletions and four of six
 * reorderings were pinned, and that the survivors "changed no outcome". Adversarial
 * review disproved all three claims; the numbers above are the re-measured ones.
 */

const PLAYER_ID = 1;
const BROWN_ID = 2;
const GREY_ID = 3;

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

// Brown is the STATIC personality -- it never roams. Position-sensitive assertions
// below use Brown as the target so that stepMovement (which runs before the bullet
// and mine stages) cannot nudge the target out from under them. Grey roams and is
// only ever used as "the other enemy that must also be dead for a win".
function makeWorld(): World {
  const world = createWorld({
    walls: [],
    tanks: [
      makeTank('player', PLAYER_ID, 5, 5),
      makeTank('brown', BROWN_ID, 20, 20),
      makeTank('grey', GREY_ID, 30, 30),
    ],
    spawns: [
      { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
      { kind: 'brown', pos: { x: 20, y: 20 }, angle: 0 },
      { kind: 'grey', pos: { x: 30, y: 30 }, angle: 0 },
    ],
    lives: 3,
  });
  // Past countdown+grace so the player's move/fire/mine inputs are live. These tests
  // are about pipeline composition, not round phases.
  world.roundStartTick = -(COUNTDOWN_TICKS + GRACE_TICKS) - 1;
  return world;
}

const idleInput: InputState = {
  move: { x: 0, y: 0 },
  aim: { x: 10, y: 5 },
  fire: false,
  mine: false,
};

const tankById = (w: World, id: number) => w.tanks.find((t) => t.id === id)!;

// A shell is lethal to anyone but its owner at centre distance <= this.
const LETHAL_DIST = TANK_RADIUS + BULLET_RADIUS;

function putBullet(w: World, b: Partial<Bullet> & Pick<Bullet, 'pos' | 'vel'>): Bullet {
  const bullet: Bullet = {
    id: w.nextId++,
    ownerId: PLAYER_ID,
    type: 'normal',
    bouncesLeft: bulletConfig.normal.bounces,
    alive: true,
    ...b,
  };
  w.bullets.push(bullet);
  return bullet;
}

function putMine(
  w: World,
  ownerId: number,
  pos: { x: number; y: number },
  timer: number,
  armed = false,
): Mine {
  const mine: Mine = { id: w.nextId++, ownerId, pos: { ...pos }, timer, armed, detonated: false };
  w.mines.push(mine);
  tankById(w, ownerId).activeMineIds.push(mine.id);
  return mine;
}

describe('step() calls stepMovement', () => {
  it('a commanded move actually displaces the player', () => {
    // Deleting stepMovement from step() leaves desiredMove set and the tank parked.
    const w = makeWorld();
    const r = step(w, { ...idleInput, move: { x: 1, y: 0 } });
    const player = tankById(r.world, PLAYER_ID);
    expect(player.pos.x).toBeGreaterThan(5);
    expect(player.pos.y).toBeCloseTo(5, 10);
  });
});

describe('step() calls resolveBulletHits', () => {
  it('a shell overlapping an enemy destroys it and emits tank-destroyed', () => {
    // Deleting resolveBulletHits leaves the shell flying harmlessly through Brown.
    const w = makeWorld();
    const brown = tankById(w, BROWN_ID);
    putBullet(w, { pos: { x: brown.pos.x, y: brown.pos.y }, vel: { x: bulletConfig.normal.speed, y: 0 } });

    const r = step(w, idleInput);

    expect(tankById(r.world, BROWN_ID).alive).toBe(false);
    expect(r.events).toContainEqual({
      type: 'tank-destroyed',
      tankId: BROWN_ID,
      kind: 'brown',
      pos: { x: 20, y: 20 },
    });
  });
});

describe('step() calls stepMines', () => {
  it('a mine whose fuse expires this tick detonates and leaves the world', () => {
    // Deleting stepMines freezes every mine: the fuse never ticks down, nothing arms,
    // nothing detonates, and world.mines grows without bound.
    const w = makeWorld();
    const mine = putMine(w, PLAYER_ID, { x: 40, y: 40 }, DT / 2); // fuse expires within this tick

    const r = step(w, idleInput);

    expect(r.events).toContainEqual({ type: 'mine-detonate', mineId: mine.id, pos: { x: 40, y: 40 } });
    // Scoped to THIS mine's id, not world.mines.length: Grey's AI can legitimately drop
    // its own mine in these fixtures, and a bare length assertion would then fail for a
    // reason that has nothing to do with the pipeline.
    expect(r.world.mines.find((m) => m.id === mine.id)).toBeUndefined();
  });

  it('a mine placed clear of its owner arms, and then kills on proximity', () => {
    // The fuse test above would still pass if arming were broken, and arming is what
    // makes a mine a weapon rather than scenery. Long fuse so ONLY the proximity path
    // can detonate this mine.
    const w = makeWorld();
    // Already clear of its owner (the player, at 5,5), so it arms on the first tick.
    // A mine that outlives its owner's departure is exactly how mines.ts describes the
    // armed state being reached.
    const minePos = { x: 20, y: 20 - (MINE_PROXIMITY_RADIUS - 0.1) };
    const mine = putMine(w, PLAYER_ID, minePos, MINE_TIMER);

    const armTick = step(w, idleInput);

    expect(armTick.events).toContainEqual({ type: 'mine-armed', mineId: mine.id, pos: minePos });
    // Brown is static and stands inside MINE_PROXIMITY_RADIUS of the drop point, so the
    // mine triggers on the same tick it arms, and the blast reaches him.
    expect(tankById(armTick.world, BROWN_ID).alive).toBe(false);
    expect(armTick.world.mines.find((m) => m.id === mine.id)).toBeUndefined();
  });
});

describe('step() calls stepAi', () => {
  it('enemies act on their own: an enemy fires without any player input', () => {
    // Deleting stepAi leaves three inert enemies. The suite catches that elsewhere, but
    // nothing in THIS file did, and a composition harness that silently omits one of the
    // seven stages is a false record of its own coverage.
    const w = makeWorld();
    let world = w;
    const events = [];
    for (let i = 0; i < 30; i++) {
      const r = step(world, idleInput);
      world = r.world;
      events.push(...r.events);
    }
    // Collected across ticks rather than asserting on end-state: a shell can be spawned
    // and resolved within the 30-tick window, and the player may die and reset the arena.
    expect(events.some((e) => e.type === 'fire' && e.ownerId !== PLAYER_ID)).toBe(true);
  });
});

describe('step() stage ORDER', () => {
  it('resolveBulletHits runs AFTER stepBullets: a shell that only reaches its target mid-tick still kills', () => {
    // Placed a half-tick of travel SHORT of lethal range: no hit at the tick's start,
    // a hit after the shell moves. Swap the two stages and Brown survives the tick.
    const w = makeWorld();
    const speed = bulletConfig.normal.speed;
    const halfStep = (speed * DT) / 2;
    const brown = tankById(w, BROWN_ID);
    // As above, the straddle is derived rather than asserted: it reduces to halfStep > 0.
    const startX = brown.pos.x - (LETHAL_DIST + halfStep);
    putBullet(w, { pos: { x: startX, y: brown.pos.y }, vel: { x: speed, y: 0 } });

    const r = step(w, idleInput);
    expect(tankById(r.world, BROWN_ID).alive).toBe(false);
  });

  it('resolveStatus runs AFTER resolveBulletHits: the shell that clears the arena wins on the SAME tick', () => {
    // Move resolveStatus ahead of the bullet stage and this win arrives a tick late --
    // or never, if the pipeline latches first.
    const w = makeWorld();
    tankById(w, GREY_ID).alive = false; // last enemy standing is Brown
    const brown = tankById(w, BROWN_ID);
    putBullet(w, { pos: { x: brown.pos.x, y: brown.pos.y }, vel: { x: bulletConfig.normal.speed, y: 0 } });

    const r = step(w, idleInput);

    expect(tankById(r.world, BROWN_ID).alive).toBe(false);
    expect(r.world.status).toBe('win');
    expect(r.events).toContainEqual({ type: 'win' });
  });

  it('resolveStatus runs AFTER stepMines: the mine that clears the arena wins on the SAME tick', () => {
    const w = makeWorld();
    tankById(w, GREY_ID).alive = false;
    putMine(w, PLAYER_ID, { x: 20, y: 20 }, DT / 2); // fuse expires on Brown's head this tick

    const r = step(w, idleInput);

    expect(tankById(r.world, BROWN_ID).alive).toBe(false);
    expect(r.world.status).toBe('win');
    expect(r.events).toContainEqual({ type: 'win' });
  });

  it('stepAi runs BEFORE stepMovement: a roamer acts on THIS tick\'s decision, not last tick\'s', () => {
    // Every tank starts with desiredMove {0,0}, so running stepMovement first means the
    // very first tick moves nobody and every later tick drives on stale intent. Measured
    // over 12 full games, that reordering diverges from the shipped one in all 12.
    const w = makeWorld();
    const spawn = { ...tankById(w, GREY_ID).pos };

    const r = step(w, idleInput);

    // Grey is a roamer: one tick of its own decision must already have displaced it.
    expect(tankById(r.world, GREY_ID).pos).not.toEqual(spawn);
  });

  it('resolveBulletHits runs BEFORE stepMines: a shell that kills its target is consumed, not left flying', () => {
    // When a mine and a shell both reach the same tank on one tick, order decides whether
    // the shell is spent. Run stepMines first and detonateMine clears the tank's `alive`
    // flag, so resolveBulletHits skips it (`if (!t.alive) continue`) and never retires the
    // shell -- which flies on, still lethal, holding one of its owner's SHELL_CAP slots.
    // Five leaked shells lock a tank out of firing for the rest of the round, which is the
    // same failure mode as the escaped-shell bug this arena already shipped a fix for.
    const w = makeWorld();
    const brown = tankById(w, BROWN_ID);
    const shell = putBullet(w, {
      pos: { x: brown.pos.x, y: brown.pos.y },
      vel: { x: bulletConfig.normal.speed, y: 0 },
    });
    putMine(w, PLAYER_ID, { x: brown.pos.x, y: brown.pos.y }, DT / 2); // fuse expires this tick

    const r = step(w, idleInput);

    expect(tankById(r.world, BROWN_ID).alive).toBe(false);
    expect(r.world.bullets.find((b) => b.id === shell.id)).toBeUndefined();
  });

  it('stepMines runs AFTER stepMovement: driving onto an armed mine detonates it on the arrival tick', () => {
    // Mines must test proximity against where tanks are NOW, not where they were at the
    // start of the tick. Run stepMines first and a tank that drives into the trigger
    // radius gets a free tick standing on a live mine.
    const w = makeWorld();
    const player = tankById(w, PLAYER_ID);
    const halfStep = (TANK_SPEED * DT) / 2;
    // Half a tick of travel OUTSIDE the trigger radius, so the player is out of range at
    // the tick's start and inside it after moving. (Derived from the fixture, so there is
    // nothing here worth asserting -- it reduces to halfStep > 0.)
    const mineX = player.pos.x + MINE_PROXIMITY_RADIUS + halfStep;
    // Owned by the player and already armed: the reachable version of this is dropping a
    // mine, driving clear (which arms it), then driving back onto it -- which mines.ts
    // calls out explicitly as the player's own doing. Brown cannot own a mine at all
    // (ai/brown.ts hard-codes mine: false), and a fuse longer than MINE_TIMER is likewise
    // a state the game never produces.
    const mine = putMine(w, PLAYER_ID, { x: mineX, y: player.pos.y }, MINE_TIMER, true);

    const r = step(w, { ...idleInput, move: { x: 1, y: 0 } });

    expect(r.events).toContainEqual({ type: 'mine-detonate', mineId: mine.id, pos: { x: mineX, y: 5 } });
    // Assert on the event record, not on r.world's tank: the player DOES die here, but
    // resolveStatus then spends a life and resetArena revives him before the tick ends.
    expect(r.events).toContainEqual({
      type: 'tank-destroyed',
      tankId: PLAYER_ID,
      kind: 'player',
      pos: { x: 5 + TANK_SPEED * DT, y: 5 },
    });
    expect(r.world.lives).toBe(2);
  });

  it('resolveStatus runs AFTER resolveBulletHits for a LOSS too: the shell that kills the player on its last life loses on the SAME tick', () => {
    const w = makeWorld();
    w.lives = 1;
    const player = tankById(w, PLAYER_ID);
    putBullet(w, {
      ownerId: BROWN_ID,
      pos: { x: player.pos.x, y: player.pos.y },
      vel: { x: bulletConfig.normal.speed, y: 0 },
    });

    const r = step(w, idleInput);

    expect(tankById(r.world, PLAYER_ID).alive).toBe(false);
    expect(r.world.status).toBe('lose');
    expect(r.events).toContainEqual({ type: 'lose' });
  });
});
