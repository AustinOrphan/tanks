import { describe, it, expect } from 'vitest';
import { createWorld, step } from './world';
import type { World } from './world';
import type { SimEvent } from './events';
import { BLAST_LIFETIME_TICKS } from './mines';
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
 * `resolveBulletHits` was caught only incidentally, by the statistical whole-game AI
 * tests in ai/pacifist.test.ts: `resolveBulletHits` by a single test about mine-laying
 * cadence, `stepMovement` by two, the second about the AI still firing. Neither failure
 * message names anything in the pipeline. Every test below is written to fail loudly,
 * and for the right reason, when its stage is removed or reordered.
 *
 * These assert through step() ONLY. Calling a stage directly here would defeat the
 * entire point of the file.
 *
 * MUTATION RECORD -- exhaustive over the classes named, not sampled. Harness controlled
 * first: the identity permutation survives 484/484, the full reversal GFEDCBA fails 9
 * tests here.
 *   - stage deletions:             7 of 7 fail here   (population: all 7)
 *   - adjacent transpositions:     4 of 6 fail here   (population: all 6)
 *   - single-element moves:       32 of 36 fail here  (population: ALL 36 distinct)
 *   - non-adjacent transpositions: 15 of 15 fail here (population: all 15; measured by review)
 * Review also swept all 5040 orderings: the only suite-survivors are the two below and
 * BADCEFG, which is just the two composed and is behaviourally identical to the first.
 *
 * CLASSES DELIBERATELY NOT SWEPT, so the counts above are not read as "everything":
 *   - duplicated stage calls (49 distinct; review found 32 pass the suite, and some change
 *     the game -- applyPlayerInput twice halves cooldowns);
 *   - intermittent skips (a stage that runs most ticks but not all; 6 of 7 pass).
 * Both are re-entrancy/cadence properties rather than composition, and neither is claimed.
 *
 * Of the 36 moves, 34 fail somewhere in the suite and exactly TWO survive it entirely:
 *
 *   - BACDEFG, applyPlayerInput <-> stepAi. The AI reads the player's shell one tick late.
 *     A REAL divergence, not a harmless one: seeded games diverge and review measured
 *     win/lose flips across a 300-seed sweep. The RATE is not quoted here on purpose --
 *     independent harnesses got 13%, 80% and 100% depending on how varied the input stream
 *     was, so it is a property of the probe, not of the code. What is stable is the
 *     contrast with the other survivor: non-zero here, 0 of 60 there. UNPINNED -- every
 *     observable found for it needs a whole-game outcome assertion, which is the fragile
 *     kind of test. This is a genuine residual, recorded rather than dressed up.
 *   - ABDCEFG, stepMovement <-> stepBullets. Safe. Not because the two stages touch
 *     disjoint state -- they both read world.walls -- but because neither WRITES what the
 *     other reads, so they commute. Verified rather than argued: 60 seeded games byte-
 *     identical, including with mines forced to destroy walls inside the swap window.
 *
 * This record is on its third measurement. The first claimed all 7 deletions and 4 of 6
 * reorderings were pinned and that the survivors changed no outcome -- three false claims.
 * The second fixed those but stated a 17-mutant SAMPLE as though it were a sweep, and
 * missed ABDECFG (stepMovement after resolveBulletHits), which passed all 484 tests while
 * changing most seeded games. Both were caught by adversarial review, not by me. Hence the
 * denominators above: a count without its population is what hid the third survivor.
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

// A shell is lethal at centre distance strictly < this (circleVsCircle compares `<`).
// No fixture here sits on the boundary, so the distinction is inert -- stated correctly
// rather than approximately because the next person will read it as a spec.
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
    // Scoped to THIS mine's id rather than world.mines.length. Grey cannot actually reach
    // a drop in this fixture (it spawns 35 units from the player, well outside
    // AI_MINE_TACTICAL_RADIUS of 8.5), but a length assertion couples the test to that
    // margin for no benefit -- tune the radius and it fails for a reason unrelated to the
    // pipeline.
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
    // mine triggers on the same tick it arms. The blast then has to GROW out to him: at
    // 1.4 away he survives the detonation tick and dies once the edge arrives.
    expect(tankById(armTick.world, BROWN_ID).alive).toBe(true);
    expect(armTick.world.mines.find((m) => m.id === mine.id)).toBeUndefined();
    let w2 = armTick.world;
    for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) w2 = step(w2, idleInput).world;
    expect(tankById(w2, BROWN_ID).alive).toBe(false);
  });
});

// stepAi's presence is pinned by the ordering test below ("a roamer acts on THIS tick's
// decision"), which fails if stepAi is deleted as well as if it is reordered. An earlier
// draft of this file also carried a separate 30-tick "an enemy fires" test; a mutation
// sweep showed it caught nothing the ordering test did not, so it was removed rather than
// left as coverage theatre.

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

  it('stepMovement runs BEFORE resolveBulletHits: a tank that drives into an incoming shell is hit this tick', () => {
    // Hits must be resolved against where tanks ARE after moving, not where they started.
    // Move stepMovement after resolveBulletHits and a tank closing on a shell is tested at
    // its stale position: it drives through the shell untouched. That mutant passed the
    // whole suite until this test existed, and it changes most seeded games.
    const w = makeWorld();
    const player = tankById(w, PLAYER_ID);
    const tankStep = TANK_SPEED * DT;
    const shellStep = bulletConfig.normal.speed * DT;
    // The gap closes only if BOTH move: shell alone leaves half a tank-step too much.
    const gap = LETHAL_DIST + shellStep + tankStep / 2;
    putBullet(w, {
      // An enemy's shell, matching how the player actually gets shot. (Not for muzzle-guard
      // reasons -- this shell closes on the player, so it would be lethal to its owner too.)
      ownerId: BROWN_ID,
      pos: { x: player.pos.x + gap, y: player.pos.y },
      vel: { x: -bulletConfig.normal.speed, y: 0 },
    });

    const r = step(w, { ...idleInput, move: { x: 1, y: 0 } });

    // On the event record, not r.world: the player dies, then resolveStatus spends a life
    // and resetArena revives him before the tick ends.
    expect(r.events.some((e) => e.type === 'tank-destroyed' && e.tankId === PLAYER_ID)).toBe(true);
  });

  it('stepAi runs BEFORE stepMovement: a roamer acts on THIS tick\'s decision, not last tick\'s', () => {
    // Every tank starts with desiredMove {0,0}, so running stepMovement first means the
    // very first tick moves nobody and every later tick drives on stale intent. Measured
    // over 12 full games, that reordering diverges from the shipped one in all 12.
    const w = makeWorld();
    const before = tankById(w, GREY_ID);
    const spawnPos = { ...before.pos };
    const spawnAngle = before.bodyAngle;

    const r = step(w, idleInput);

    // Grey is a roamer: one tick of its own decision must already have MOVED it or
    // TURNED it. Position alone is no longer the right probe -- now that the hull slews
    // and speed falls off with misalignment, a tank asked to drive more than 90 degrees
    // off its spawn facing pivots on the spot for the first ticks and does not displace
    // at all. Either half of the pose is enough: with stepMovement first, desiredMove is
    // still {0,0}, moveTank returns without touching pos OR bodyAngle, and both hold.
    const after = tankById(r.world, GREY_ID);
    const moved = after.pos.x !== spawnPos.x || after.pos.y !== spawnPos.y;
    const turned = after.bodyAngle !== spawnAngle;
    expect(moved || turned).toBe(true);
  });

  it('resolveBulletHits runs BEFORE stepMines: a shell that kills its target is consumed, not left flying', () => {
    // When a mine and a shell both reach the same tank on one tick, order decides whether
    // the shell is spent. Run stepMines first and detonateMine clears the tank's `alive`
    // flag, so resolveBulletHits skips it (`if (!t.alive) continue`) and never retires the
    // shell -- which flies on, still lethal, holding one of its owner's SHELL_CAP slots.
    // In the shipped arena that shell does eventually self-retire, because NORMAL_BOUNCES
    // is 1 -- so this is a transient cap leak rather than the permanent lockout the
    // escaped-shell bug caused. It is still a shell that kills something it should never
    // have reached. (An earlier draft put a "71-218 ticks" range here. Review traced it to
    // one unstated population -- player spawn, 24 angles -- and measured ~4-438 across the
    // real arena. It is deleted rather than restated: this fixture has no walls, so no
    // shipped-arena figure belongs in it.)
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
    // ...and the ORDER is the whole subject: the detonation above is what fails if
    // stepMines is moved before stepMovement.
    //
    // The kill is a delayed consequence of it. The player ends the tick ~1.45 from the
    // mine and the blast starts at MINE_BLAST_RADIUS/MINE_BLAST_EXPAND_TICKS, so its edge
    // needs a few more ticks to reach him. Idle input from here so he stands still and
    // the growing radius, not his own movement, is what closes the gap -- which also
    // makes this fail if stepBlasts is dropped from the pipeline.
    let w2 = r.world;
    const deaths: SimEvent[] = [];
    for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) {
      const rr = step(w2, idleInput);
      w2 = rr.world;
      deaths.push(...rr.events.filter((e) => e.type === 'tank-destroyed'));
    }
    // Assert on the event record, not on the world's tank: the player DOES die, but
    // resolveStatus then spends a life and resetArena revives him before that tick ends.
    expect(deaths).toContainEqual({
      type: 'tank-destroyed',
      tankId: PLAYER_ID,
      kind: 'player',
      pos: { x: 5 + TANK_SPEED * DT, y: 5 },
    });
    expect(w2.lives).toBe(2);
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
