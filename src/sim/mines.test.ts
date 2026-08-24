import { describe, it, expect } from 'vitest'
import { createWorld } from './world'
import type { World } from './world'
import { dropMine, stepMines, detonateMine, tripMineProximity, blastReaches, stepBlasts, blastRadiusAt, BLAST_LIFETIME_TICKS } from './mines'
import { resolveBulletHits } from './bullets'
import type { SimEvent } from './events'
import type { Tank, TankKind, Vec2, AABB, Wall, WallKind, Mine, Bullet, UnarmedTrigger } from './types'
import {
  MINE_CAP,
  MINE_TIMER,
  MINE_PROXIMITY_RADIUS,
  MINE_FUSE_WARNING_TICKS,
  MINE_PROXIMITY_DELAY_TICKS,
  MINE_BLAST_EXPAND_TICKS,
  MINE_BLAST_HOLD_TICKS,
  MINE_BLAST_RADIUS,
  TANK_RADIUS,
  DT,
} from './constants'

function mkTank(p: Partial<Tank> & { id: number; kind: TankKind; pos: Vec2 }): Tank {
  return {
    id: p.id,
    kind: p.kind,
    pos: p.pos,
    bodyAngle: p.bodyAngle ?? 0,
    turretAngle: p.turretAngle ?? 0,
    alive: p.alive ?? true,
    desiredMove: p.desiredMove ?? { x: 0, y: 0 },
    activeMineIds: p.activeMineIds ?? [],
    fireCooldown: p.fireCooldown ?? 0,
    mineCooldown: p.mineCooldown ?? 0,
    aiState: p.aiState ?? 'idle',
    aiTimer: p.aiTimer ?? 0,
    // Optional flags must pass through, or a fixture claiming them tests the default.
    disarmed: p.disarmed,
    invincible: p.invincible,
    shieldUntilTick: p.shieldUntilTick,
    team: p.team,
  }
}

function mkWall(id: number, aabb: AABB, kind: WallKind = 'solid'): Wall {
  return { id, aabb, kind, destroyed: false }
}

describe('dropMine', () => {
  it('rejects a 3rd player mine while 2 are active', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    expect(dropMine(world, 1, [])).toBe(true)
    expect(dropMine(world, 1, [])).toBe(true)
    expect(player.activeMineIds.length).toBe(MINE_CAP)
    expect(dropMine(world, 1, [])).toBe(false)
  })

  it('rejects a mine from a NON-player owner at MINE_CAP (cap applies to every owner)', () => {
    const grey = mkTank({ id: 1, kind: 'grey', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [grey], spawns: [], lives: 3 })
    expect(dropMine(world, 1, [])).toBe(true)
    expect(dropMine(world, 1, [])).toBe(true)
    expect(grey.activeMineIds.length).toBe(MINE_CAP)
    const beforeMineCount = world.mines.length
    const events: SimEvent[] = []
    expect(dropMine(world, 1, events)).toBe(false)
    expect(world.mines.length).toBe(beforeMineCount) // no mine appended
    expect(events.find((e) => e.type === 'mine-dropped')).toBeUndefined() // no event emitted
  })

  it("accepts a 4th mine for yellow, whose per-kind cap (4) doubles the generic MINE_CAP (2) -- issue #136's payload discriminator", () => {
    // dropMine gates on configFor(owner.kind).mineCapacity, not the MINE_CAP constant --
    // this is what makes yellow's whole identity (issue #136: "4 mines, medium speed")
    // real rather than silently clamped to the same 2 every other mine-layer gets.
    const yellow = mkTank({ id: 1, kind: 'yellow', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [yellow], spawns: [], lives: 3 })
    for (let i = 0; i < 4; i++) expect(dropMine(world, 1, [])).toBe(true)
    expect(yellow.activeMineIds.length).toBe(4) // MINE_CAP (2) would have refused the 3rd
    const beforeMineCount = world.mines.length
    expect(dropMine(world, 1, [])).toBe(false) // the 5th is refused: the cap is 4, not unlimited
    expect(world.mines.length).toBe(beforeMineCount)
  })

  it('rejects a mine from a DEAD owner, matching spawnBullet', () => {
    // A corpse must not keep laying mines. spawnBullet has carried
    // `!owner || !owner.alive` since Task 12 as defence-in-depth; the mine
    // chokepoint only ever checked `!owner`.
    const grey = mkTank({ id: 1, kind: 'grey', pos: { x: 0, y: 0 } })
    grey.alive = false
    const world = createWorld({ walls: [], tanks: [grey], spawns: [], lives: 3 })
    const events: SimEvent[] = []

    expect(dropMine(world, 1, events)).toBe(false)
    expect(world.mines.length).toBe(0)
    expect(grey.activeMineIds).toEqual([])
    expect(events).toEqual([])
  })

  it('drops a mine at the owner and emits mine-dropped', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 2, y: -1 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    expect(dropMine(world, 1, events)).toBe(true)
    const mine = world.mines[0]
    expect(mine.pos).toEqual({ x: 2, y: -1 })
    expect(mine.timer).toBeCloseTo(MINE_TIMER, 6)
    expect(mine.detonated).toBe(false)
    expect(events.find((e) => e.type === 'mine-dropped')).toMatchObject({
      type: 'mine-dropped',
      mineId: mine.id,
    })
  })
})


/**
 * Detonate and let the blast finish growing.
 *
 * The blast is no longer instantaneous, so a test about REACH -- who the blast
 * ends up killing, and through what -- must run it out to full radius first.
 * Tests about TIMING (which tick a given victim dies on) live in the 'blast
 * ramp' block and deliberately do NOT use this.
 */
function detonateFully(world: World, mine: Mine, events: SimEvent[]): void {
  detonateMine(world, mine, events)
  for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) stepBlasts(world, events)
}

/** Run any in-flight blast out to full radius, for tests that detonate via stepMines. */
function settleBlasts(world: World, events: SimEvent[]): void {
  for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) stepBlasts(world, events)
}

describe('stepMines', () => {
  it('detonates on the ~3s timer with no one nearby', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    player.pos = { x: 10, y: 10 } // walk away so nobody is in proximity/blast
    const events: SimEvent[] = []
    let ticks = 0
    while (world.mines.length > 0 && ticks < 1000) {
      stepMines(world, DT, events)
      ticks++
    }
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(MINE_TIMER / DT) - 2)
  })

  it('detonates early when an enemy enters proximity', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 10, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    player.pos = { x: 10, y: 10 }
    enemy.pos = { x: MINE_PROXIMITY_RADIUS - 0.5, y: 0 } // 1.0, inside proximity 1.5
    const events: SimEvent[] = []
    stepMines(world, DT, events)
    // Proximity entry opens the reaction delay (issue #275, owner-revised); the
    // enemy stays inside through it (static fixture), and the detonation lands
    // on schedule.
    expect(events.some((e) => e.type === 'mine-triggered')).toBe(true)
    for (let i = 0; i < MINE_PROXIMITY_DELAY_TICKS; i++) stepMines(world, DT, events)
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
    settleBlasts(world, events)
    expect(enemy.alive).toBe(false) // 1.0 <= blast radius 2.0
  })

  it('leaves the owner unharmed while unarmed (owner immune until armed)', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    const events: SimEvent[] = []
    stepMines(world, DT, events) // owner still standing on the fresh mine
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(false)
    expect(world.mines[0].detonated).toBe(false)
    expect(world.mines[0].armed).toBe(false)
    expect(player.alive).toBe(true)
  })

  it('an unarmed mine is inert: dropping one beside an enemy kills nobody', () => {
    // Not a free kill and not a self-kill. A mine spawns at the owner's feet
    // and the blast reaches further than the trigger, so a fresh mine that
    // could be triggered detonated at range zero -- killing the dropper along
    // with the target, or, if the owner were exempted, handing out a riskless
    // walk-up execution. Arming is the gate for both.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 1.1, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    dropMine(world, 1, [])

    const events: SimEvent[] = []
    stepMines(world, DT, events)

    expect(events.some((e) => e.type === 'mine-detonate')).toBe(false)
    expect(enemy.alive).toBe(true)
    expect(player.alive).toBe(true)
  })

  it('kills an enemy standing on the mine once the owner walks clear and the blast reaches him', () => {
    // The flip side: arming is a real threat, not a permanent disarm.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 1.1, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    dropMine(world, 1, [])

    player.pos = { x: 10, y: 10 } // owner clears the area -> arms this tick
    const events: SimEvent[] = []
    stepMines(world, DT, events)

    expect(events.some((e) => e.type === 'mine-armed')).toBe(true)
    // Arming and the proximity trip land on the same call; the blast follows
    // the reaction delay (issue #275, owner-revised).
    for (let i = 0; i < MINE_PROXIMITY_DELAY_TICKS; i++) stepMines(world, DT, events)
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
    // At 1.1 he is inside the age-0 radius now that the ramp eases out (0.72 + TANK_RADIUS
    // = 1.22 reach on the detonation tick), so he dies immediately. Settle anyway: the
    // subject here is arming, and it should not care which tick of the blast lands.
    settleBlasts(world, events)
    expect(enemy.alive).toBe(false)
    expect(player.alive).toBe(true) // 10+ units away, well clear of the blast
  })

  it('kills an owner who camps on his own mine until the fuse runs out', () => {
    // The counterweight to the exemption above: if the fuse spared the owner
    // too, parking on your own mine would be a free riskless bomb.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])

    const events: SimEvent[] = []
    for (let i = 0; i < Math.ceil(MINE_TIMER / DT) + 2; i++) stepMines(world, DT, events)

    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
    expect(player.alive).toBe(false)
  })

  it('kills the owner who walks back onto his own armed mine', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])

    player.pos = { x: 10, y: 10 } // walk away -> arms
    stepMines(world, DT, [])
    expect(world.mines[0].armed).toBe(true)

    player.pos = { x: 0.2, y: 0 } // walk back onto it
    const events: SimEvent[] = []
    stepMines(world, DT, events)
    for (let i = 0; i < MINE_PROXIMITY_DELAY_TICKS; i++) stepMines(world, DT, events) // the proximity reaction delay (issue #275)

    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
    expect(player.alive).toBe(false)
  })

  it('arms a mine whose owner was killed while standing on it', () => {
    // Corpses stay in world.tanks, so a dead owner at distance 0 used to keep
    // the mine unarmed forever -- no mine-armed cue before it went off.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    player.alive = false

    const events: SimEvent[] = []
    stepMines(world, DT, events)

    expect(world.mines[0].armed).toBe(true)
    expect(events.filter((e) => e.type === 'mine-armed')).toHaveLength(1)
  })

  it('emits mine-armed the tick the owner leaves proximity (mine goes live)', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    // still standing on the mine: not armed, no mine-armed event
    let events: SimEvent[] = []
    stepMines(world, DT, events)
    expect(world.mines[0].armed).toBe(false)
    expect(events.some((e) => e.type === 'mine-armed')).toBe(false)
    // walk out of proximity: arms THIS tick and emits exactly one mine-armed
    player.pos = { x: 10, y: 10 }
    events = []
    stepMines(world, DT, events)
    expect(world.mines[0].armed).toBe(true)
    expect(events.filter((e) => e.type === 'mine-armed').length).toBe(1)
    // subsequent ticks do not re-emit (guarded by !mine.armed)
    events = []
    stepMines(world, DT, events)
    expect(events.some((e) => e.type === 'mine-armed')).toBe(false)
  })
})

describe('detonateMine', () => {
  it('kills tanks whose hull is inside the blast but not those clear of it', () => {
    // The blast is measured against the tank's hull, matching resolveBulletHits'
    // circleVsCircle: reach is MINE_BLAST_RADIUS + TANK_RADIUS from the centre.
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const inside = mkTank({ id: 2, kind: 'brown', pos: { x: MINE_BLAST_RADIUS - 0.5, y: 0 } })
    // THE DISCRIMINATING PAIR, straddling the exact reach rather than sitting near it.
    // Without a tank in (MINE_BLAST_RADIUS, MINE_BLAST_RADIUS + TANK_RADIUS] the test
    // cannot tell the documented reach from one missing its `+ TANK_RADIUS`: `inside` at
    // 1.5 dies under both and a far tank at 3.0 survives under both, so dropping the term
    // passed the whole suite. Straddling by 1e-9 (the idiom ai/danger.test.ts:207 already
    // uses) also pins the exact boundary value and the `<=`, which a probe placed at the
    // midpoint leaves free to slide.
    const REACH = MINE_BLAST_RADIUS + TANK_RADIUS
    const atReach = mkTank({ id: 4, kind: 'teal', pos: { x: REACH, y: 0 } })
    const clear = mkTank({ id: 3, kind: 'grey', pos: { x: REACH + 1e-9, y: 0 } })
    const world = createWorld({
      walls: [],
      tanks: [owner, inside, atReach, clear],
      spawns: [],
      lives: 3,
    })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateFully(world, mine, events)
    expect(inside.alive).toBe(false) // centre 1.5, well inside the 2.5 reach
    expect(atReach.alive).toBe(false) // centre exactly 2.5: hull grazing, still killed (<=)
    expect(clear.alive).toBe(true) // centre 2.5 + 1e-9: the first distance that survives
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
  })

  it('destroys a destructible wall in radius but leaves a solid wall intact', () => {
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const world = createWorld({
      walls: [
        mkWall(1, { minX: 0.5, minY: -0.5, maxX: 1.5, maxY: 0.5 }, 'destructible'),
        mkWall(2, { minX: 0.5, minY: 5, maxX: 1.5, maxY: 6 }, 'solid'),
      ],
      tanks: [owner],
      spawns: [],
      lives: 3,
    })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateFully(world, mine, events)
    expect(world.walls[0].destroyed).toBe(true)
    expect(world.walls[1].destroyed).toBe(false)
    expect(events.find((e) => e.type === 'wall-destroyed')).toMatchObject({ type: 'wall-destroyed', wallId: 1 })
  })

  it('frees a mine slot when a mine detonates so the player can drop again', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    dropMine(world, 1, [])
    expect(dropMine(world, 1, [])).toBe(false) // capped at 2
    const first = world.mines[0]
    // Drive out of the blast before detonating. Mines spawn AT the owner, so
    // leaving the player parked on top of its own mine killed it here -- and
    // this test's final assertion then only passed because dropMine ignored
    // owner.alive. The subject is slot accounting, not what a corpse may do.
    player.pos = { x: MINE_BLAST_RADIUS * 3, y: 0 }
    detonateMine(world, first, [])
    expect(player.alive).toBe(true)
    expect(player.activeMineIds.includes(first.id)).toBe(false)
    expect(dropMine(world, 1, [])).toBe(true) // slot freed
  })
})

describe('mine blast occlusion', () => {
  const between = (kind: WallKind): Wall =>
    mkWall(1, { minX: -0.2, minY: -2, maxX: 0.2, maxY: 2 }, kind)
  // Mine and tank 2.0 apart -- inside the 2.5 kill radius -- wall squarely between.
  const victimAt = (): Tank => mkTank({ id: 2, kind: 'brown', pos: { x: 1, y: 0 } })
  const mineAt = (): Mine =>
    ({ id: 9, ownerId: 1, pos: { x: -1, y: 0 }, timer: 0, armed: true, detonated: false })

  it('does not kill through an intact SOLID wall', () => {
    // Dying through cover that is still standing is the defect: before this the
    // kill test was pure distance, with no occlusion at all.
    const victim = victimAt()
    const mine = mineAt()
    const world = createWorld({ walls: [between('solid')], tanks: [victim], spawns: [], lives: 3 })
    world.mines.push(mine)
    detonateFully(world, mine, [])
    expect(victim.alive).toBe(true)
    expect(world.walls[0].destroyed).toBe(false)
  })

  it('still kills a tank with a clear line', () => {
    // Negative control: "blocked by everything" would also pass the test above.
    const victim = victimAt()
    const mine = mineAt()
    const world = createWorld({ walls: [], tanks: [victim], spawns: [], lives: 3 })
    world.mines.push(mine)
    detonateFully(world, mine, [])
    expect(victim.alive).toBe(false)
  })

  it('carries through a DESTRUCTIBLE wall, which it also destroys', () => {
    // The shipped default: a blast strong enough to shatter a wall does not
    // stop at it. MINE_BLAST_THROUGH_DESTRUCTIBLE flips this.
    const victim = victimAt()
    const mine = mineAt()
    const world = createWorld({ walls: [between('destructible')], tanks: [victim], spawns: [], lives: 3 })
    world.mines.push(mine)
    detonateFully(world, mine, [])
    expect(victim.alive).toBe(false)
    expect(world.walls[0].destroyed).toBe(true)
  })

  it('blastReaches honours the flag both ways', () => {
    // The constant is build-time, so the predicate takes it as a parameter and
    // both branches stay reachable from a test.
    const from = { x: -1, y: 0 }
    const to = { x: 1, y: 0 }
    expect(blastReaches([between('solid')], from, to, true)).toBe(false)
    expect(blastReaches([between('solid')], from, to, false)).toBe(false)
    expect(blastReaches([between('destructible')], from, to, true)).toBe(true)
    expect(blastReaches([between('destructible')], from, to, false)).toBe(false)
  })

  it('ignores a wall that is already destroyed', () => {
    const victim = victimAt()
    const mine = mineAt()
    const w = between('solid')
    w.destroyed = true
    const world = createWorld({ walls: [w], tanks: [victim], spawns: [], lives: 3 })
    world.mines.push(mine)
    detonateFully(world, mine, [])
    expect(victim.alive).toBe(false)
  })
})

describe('what may set off an UNARMED mine', () => {
  // Population: all four UnarmedTrigger values, against both trigger paths.
  const shell = (x: number, y: number): Bullet =>
    ({ id: 90, ownerId: 3, type: 'normal', pos: { x, y }, vel: { x: 1, y: 0 }, bouncesLeft: 1, alive: true }) as Bullet;
  const laid = (armed: boolean): Mine =>
    ({ id: 9, ownerId: 1, pos: { x: 0, y: 0 }, timer: 99, armed, detonated: false }) as Mine;

  function shot(policy: UnarmedTrigger, armed: boolean): boolean {
    const world = createWorld({ walls: [], tanks: [], spawns: [], lives: 3, unarmedTrigger: policy });
    world.mines.push(laid(armed));
    world.bullets.push(shell(0.1, 0));
    resolveBulletHits(world, []);
    // Shell hits detonate IMMEDIATELY (owner direction on PR #311): detonated
    // mines are filtered out, so removal is the observable.
    return world.mines.length === 0;
  }

  function walked(policy: UnarmedTrigger, armed: boolean): boolean {
    // The OWNER must be present and standing on the mine, or stepMines arms it
    // for us: arming fires when the owner is absent, dead, or clear of it, and
    // an armed mine detonates whatever the policy says. Without this the
    // fixture proves nothing about the unarmed case.
    const owner = mkTank({ id: 1, kind: 'brown', pos: { x: 0, y: 0 } });
    const walker = mkTank({ id: 2, kind: 'brown', pos: { x: 0.2, y: 0 } });
    const world = createWorld({ walls: [], tanks: [owner, walker], spawns: [], lives: 3, unarmedTrigger: policy });
    world.mines.push(laid(armed));
    stepMines(world, 1 / 60, []);
    // Proximity "sets off" a mine by opening its reaction delay (issue #275,
    // owner-revised): the stamped countdown is the observable.
    return world.mines.length === 0 || world.mines[0].proximityDelayLeft !== undefined;
  }

  it('an ARMED mine goes off either way, whatever the policy', () => {
    // Not configurable: a mine live to a footstep must be live to a shell.
    for (const p of ['none', 'proximity', 'bullet', 'both'] as UnarmedTrigger[]) {
      expect(shot(p, true)).toBe(true);
      expect(walked(p, true)).toBe(true);
    }
  });

  it("'none' leaves an unarmed mine inert to both, which is the shipped rule", () => {
    expect(shot('none', false)).toBe(false);
    expect(walked('none', false)).toBe(false);
  });

  it("'bullet' lets a shell set it off but a footstep not", () => {
    expect(shot('bullet', false)).toBe(true);
    expect(walked('bullet', false)).toBe(false);
  });

  it("'proximity' lets a footstep set it off but a shell not", () => {
    expect(walked('proximity', false)).toBe(true);
    expect(shot('proximity', false)).toBe(false);
  });

  it("'both' lets either set it off", () => {
    expect(shot('both', false)).toBe(true);
    expect(walked('both', false)).toBe(true);
  });

  it('a shell must HIT the mine, not merely enter its blast radius', () => {
    // MINE_BLAST_RADIUS is 2.0; triggering at that range would make every mine
    // a 2-unit shell trap rather than a thing you have to hit.
    const world = createWorld({ walls: [], tanks: [], spawns: [], lives: 3, unarmedTrigger: 'both' });
    world.mines.push(laid(true));
    world.bullets.push(shell(1.0, 0)); // well outside MINE_TRIGGER_RADIUS, inside the blast
    resolveBulletHits(world, []);
    expect(world.mines).toHaveLength(1);
  });

  it('the shell is consumed by the mine it sets off', () => {
    const world = createWorld({ walls: [], tanks: [], spawns: [], lives: 3, unarmedTrigger: 'both' });
    world.mines.push(laid(true));
    const b = shell(0.1, 0);
    world.bullets.push(b);
    resolveBulletHits(world, []);
    expect(b.alive).toBe(false);
  });

  it('defaults to the shipped rule when the world does not say', () => {
    const world = createWorld({ walls: [], tanks: [], spawns: [], lives: 3 });
    expect(world.unarmedTrigger).toBe('none');
  });
});

describe('blast ramp', () => {
  // Everything above runs the blast out to full radius, so it pins REACH and is blind to
  // the ramp: flattening blastRadiusAt to `return MINE_BLAST_RADIUS` passes all of it.
  // These pin the growth itself.

  it('grows to full radius over MINE_BLAST_EXPAND_TICKS, decelerating, then holds', () => {
    expect(blastRadiusAt(0)).toBeGreaterThan(0) // age 0 is already lethal point-blank
    expect(blastRadiusAt(0)).toBeLessThan(MINE_BLAST_RADIUS) // the ramp exists at all
    // Strictly increasing while expanding -- a monotonicity check alone would pass on a
    // ramp that jumped to full size on tick 1.
    const steps: number[] = []
    for (let age = 0; age < MINE_BLAST_EXPAND_TICKS; age++) {
      const prev = age === 0 ? 0 : blastRadiusAt(age - 1)
      expect(blastRadiusAt(age)).toBeGreaterThan(prev)
      steps.push(blastRadiusAt(age) - prev)
    }
    // DECELERATING: each tick adds strictly less than the one before. This is the
    // assertion that fails on the linear ramp this replaced, where every step is equal --
    // monotonicity and the endpoints hold under both, so they cannot tell them apart.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeLessThan(steps[i - 1])
    }
    expect(steps[0]).toBeGreaterThan(steps[steps.length - 1] * 2) // and by a visible margin
    // Full size on the last expanding tick, and flat from there.
    expect(blastRadiusAt(MINE_BLAST_EXPAND_TICKS - 1)).toBeCloseTo(MINE_BLAST_RADIUS, 10)
    expect(blastRadiusAt(MINE_BLAST_EXPAND_TICKS)).toBe(MINE_BLAST_RADIUS)
    expect(blastRadiusAt(BLAST_LIFETIME_TICKS)).toBe(MINE_BLAST_RADIUS)
  })

  it('kills point-blank at once but takes ticks to reach the fringe', () => {
    // THE DISCRIMINATING PAIR. `near` dies on the detonation tick under both a ramped and
    // an instant blast, so it proves nothing alone; `far` is the one that separates them,
    // and the assertion that it is ALIVE first is what fails if the ramp is removed.
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const near = mkTank({ id: 2, kind: 'brown', pos: { x: 0.1, y: 0 } })
    const far = mkTank({ id: 3, kind: 'grey', pos: { x: MINE_BLAST_RADIUS + TANK_RADIUS - 0.01, y: 0 } })
    const world = createWorld({ walls: [], tanks: [owner, near, far], spawns: [], lives: 3 })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []

    detonateMine(world, mine, events)
    expect(near.alive).toBe(false) // inside the age-0 radius
    expect(far.alive).toBe(true) // just inside FULL reach, so only the ramp spares him here

    // He dies exactly when the edge arrives, not before and not never.
    let deathAge = -1
    for (let age = 1; age < BLAST_LIFETIME_TICKS; age++) {
      stepBlasts(world, events)
      if (!far.alive) {
        deathAge = age
        break
      }
    }
    expect(deathAge).toBe(MINE_BLAST_EXPAND_TICKS - 1) // the first tick at full radius
  })

  it('stops being lethal once it has run its course', () => {
    // Without retirement a blast is a permanent kill zone: anything that later drives
    // over the spot dies. Walk a tank in AFTER the blast should have faded.
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const latecomer = mkTank({ id: 2, kind: 'brown', pos: { x: 50, y: 50 } })
    const world = createWorld({ walls: [], tanks: [owner, latecomer], spawns: [], lives: 3 })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) stepBlasts(world, events)

    expect(world.blasts).toHaveLength(0) // retired, not merely harmless
    latecomer.pos = { x: 0, y: 0 } // standing exactly on ground zero
    stepBlasts(world, events)
    expect(latecomer.alive).toBe(true)
  })

  it('destroys a wall the growing edge reaches only later', () => {
    // The wall sits outside the age-0 radius, so an un-ramped blast destroys it on the
    // detonation tick and a ramped one cannot.
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const world = createWorld({
      walls: [mkWall(1, { minX: 1.6, minY: -0.5, maxX: 1.9, maxY: 0.5 }, 'destructible')],
      tanks: [owner],
      spawns: [],
      lives: 3,
    })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    expect(world.walls[0].destroyed).toBe(false) // 1.6 away, outside the age-0 radius
    for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) stepBlasts(world, events)
    expect(world.walls[0].destroyed).toBe(true)
    // Emitted once, when it actually broke -- not re-emitted every tick the blast covers it.
    expect(events.filter((e) => e.type === 'wall-destroyed')).toHaveLength(1)
  })
})

describe('blasts and invincible tanks (dev playtest mode)', () => {
  it('the blast washes over an invincible tank; its mortal twin dies where it stands', () => {
    // Both tanks inside the kill reach, one flag apart -- the mortal one is the proof
    // the fixture is lethal, so the invincible assertion cannot pass vacuously.
    const ghost = mkTank({ id: 2, kind: 'player', pos: { x: 1, y: 0 }, invincible: true })
    const mortal = mkTank({ id: 3, kind: 'brown', pos: { x: -1, y: 0 } })
    const world = createWorld({ walls: [], tanks: [ghost, mortal], spawns: [], lives: 3 })
    const mine: Mine = { id: 50, ownerId: 9, pos: { x: 0, y: 0 }, timer: 0, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    for (let i = 0; i < MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS + 2; i++) stepBlasts(world, events)
    expect(world.tanks.find((t) => t.id === 2)!.alive).toBe(true)
    expect(world.tanks.find((t) => t.id === 3)!.alive).toBe(false)
    // No corpse event for the ghost. Discriminated by id, not presence: the mortal
    // twin's tank-destroyed is in the same stream.
    expect(events.filter((e) => e.type === 'tank-destroyed').map((e) => (e as { tankId: number }).tankId)).toEqual([3])
  })
})

describe('blasts and shielded tanks (coop post-respawn immunity)', () => {
  it('a live shieldUntilTick washes over the blast; an expired one does not protect', () => {
    // Three tanks: a live shield, an expired one, and a mortal control -- the control
    // is what proves the fixture is genuinely lethal, same shape as the invincible
    // block above.
    const shielded = mkTank({ id: 2, kind: 'player', pos: { x: 1, y: 0 }, shieldUntilTick: 100 })
    const expired = mkTank({ id: 3, kind: 'player', pos: { x: -1, y: 0 }, shieldUntilTick: 5 })
    const mortal = mkTank({ id: 4, kind: 'brown', pos: { x: 0, y: 1 } })
    const world = createWorld({ walls: [], tanks: [shielded, expired, mortal], spawns: [], lives: 3 })
    world.tick = 10 // < 100 (shielded's shield is live); >= 5 (expired's has lapsed)
    const mine: Mine = { id: 50, ownerId: 9, pos: { x: 0, y: 0 }, timer: 0, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    for (let i = 0; i < MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS + 2; i++) stepBlasts(world, events)
    expect(world.tanks.find((t) => t.id === 2)!.alive).toBe(true) // shielded
    expect(world.tanks.find((t) => t.id === 3)!.alive).toBe(false) // expired shield
    expect(world.tanks.find((t) => t.id === 4)!.alive).toBe(false) // mortal control
    expect(events.filter((e) => e.type === 'tank-destroyed').map((e) => (e as { tankId: number }).tankId).sort()).toEqual([3, 4]);
  })
})

describe('blasts and friendly fire (n-player arc PR 4, teams mode)', () => {
  // Team is a three-place concept (arc design); this is place 2 of 3, the sibling site
  // isDamageImmune already touched once. Gate: `t.team !== undefined && ownerTeam !==
  // undefined && t.team === ownerTeam && !world.friendlyFire`, ownerTeam resolved via
  // the blast's CREDIT owner (mirrors how credit already resolves kill attribution
  // elsewhere -- a shell detonating an enemy's mine credits the shooter, not the mine's
  // owner). Mirrors isDamageImmune's own shape: stands in the blast unharmed, no event.
  function fixture(friendlyFire: boolean, ownerTeam: number | undefined, targetTeam: number | undefined) {
    const owner = mkTank({ id: 9, kind: 'player', pos: { x: 5, y: 5 }, team: ownerTeam })
    const target = mkTank({ id: 2, kind: 'player', pos: { x: 1, y: 0 }, team: targetTeam })
    const mortal = mkTank({ id: 3, kind: 'brown', pos: { x: -1, y: 0 } }) // lethality control
    const world = createWorld({ walls: [], tanks: [owner, target, mortal], spawns: [], lives: 3, mode: 'teams', friendlyFire })
    const mine: Mine = { id: 50, ownerId: 9, pos: { x: 0, y: 0 }, timer: 0, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    for (let i = 0; i < MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS + 2; i++) stepBlasts(world, events)
    return {
      target: world.tanks.find((t) => t.id === 2)!,
      mortal: world.tanks.find((t) => t.id === 3)!,
      events,
    }
  }

  it('friendlyFire OFF: a teammate stands in the blast unharmed -- the lethality control still dies, so the fixture is genuinely lethal', () => {
    const { target, mortal, events } = fixture(false, 0, 0)
    expect(target.alive).toBe(true)
    expect(mortal.alive).toBe(false)
    expect(events.filter((e) => e.type === 'tank-destroyed').map((e) => (e as { tankId: number }).tankId)).toEqual([3])
  })

  it('friendlyFire OFF: an enemy-team tank in the same blast still dies -- team-specific, not a blanket immunity', () => {
    const { target, events } = fixture(false, 0, 1)
    expect(target.alive).toBe(false)
    expect(events.some((e) => e.type === 'tank-destroyed' && (e as { tankId: number }).tankId === 2)).toBe(true)
  })

  it('friendlyFire ON: a teammate dies too', () => {
    const { target } = fixture(true, 0, 0)
    expect(target.alive).toBe(false)
  })

  it('the gate is self-disabling when team is undefined: a same-owner-team-undefined pair still dies to friendlyFire OFF', () => {
    const { target } = fixture(false, undefined, undefined)
    expect(target.alive).toBe(false)
  })
})

describe('blast credit: who set it off, not just whose mine it was', () => {
  it('a shell detonating an ENEMY mine credits the SHOOTER for the kills', () => {
    // The skill shot: the player shoots enemy 9's armed mine, and the blast kills
    // enemy 2 standing beside it. Before credit existed, the kill was filed under
    // the mine's owner -- the stats page called a player kill "AI friendly fire"
    // and scored the killing shot as a miss.
    const victim = mkTank({ id: 2, kind: 'brown', pos: { x: 1, y: 0 } })
    const world = createWorld({ walls: [], tanks: [victim], spawns: [], lives: 3 })
    world.mines.push({ id: 50, ownerId: 9, pos: { x: 0, y: 0 }, timer: 100, armed: true, detonated: false })
    world.bullets.push({ id: 60, ownerId: 1, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 1, alive: true })
    const events: SimEvent[] = []
    resolveBulletHits(world, events) // the shell overlaps the mine's trigger radius
    for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) stepBlasts(world, events)
    const death = events.find((e) => e.type === 'tank-destroyed')
    expect(death).toMatchObject({ tankId: 2, by: { source: 'shell', ownerId: 1 } })
  })

  it('a fuse or proximity detonation still credits the mine\'s owner as a blast', () => {
    // The discriminating partner: without a triggering shell, nothing changed.
    const victim = mkTank({ id: 2, kind: 'brown', pos: { x: 1, y: 0 } })
    const world = createWorld({ walls: [], tanks: [victim], spawns: [], lives: 3 })
    const mine: Mine = { id: 50, ownerId: 9, pos: { x: 0, y: 0 }, timer: 0, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    for (let i = 0; i < BLAST_LIFETIME_TICKS; i++) stepBlasts(world, events)
    const death = events.find((e) => e.type === 'tank-destroyed')
    expect(death).toMatchObject({ tankId: 2, by: { source: 'blast', ownerId: 9 } })
  })
})

describe('source-specific mine warnings (issue #275, owner-revised on PR #311)', () => {
  // Three trigger sources, three deliberate behaviours (owner direction): proximity
  // opens a short reaction delay, the fuse's warning is its own FINAL window with
  // expiry timing untouched, and a shell detonates immediately (the blast-credit
  // suite above covers the shell path). Fixtures follow this file's idiom: armed
  // mines built by dropMine + walking the owner clear, ticked with the real DT.

  function armedFixture(): { world: World; owner: Tank; events: SimEvent[] } {
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [owner], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    owner.pos = { x: 10, y: 10 }
    const events: SimEvent[] = []
    stepMines(world, DT, events) // arms: owner is clear
    expect(events.some((e) => e.type === 'mine-armed')).toBe(true)
    return { world, owner, events }
  }

  it('pins BOTH named durations separately: fuse warning 30 ticks, proximity delay 30 ticks, from balance.json', () => {
    // Separately named and configured because the semantics differ (owner
    // direction on PR #311); both provisional, #277 owns tuning each independently.
    expect(MINE_FUSE_WARNING_TICKS).toBe(30)
    expect(MINE_PROXIMITY_DELAY_TICKS).toBe(30)
  })

  it('proximity entry emits mine-triggered on that call and defers mine-detonate by exactly MINE_PROXIMITY_DELAY_TICKS calls', () => {
    const { world, events } = armedFixture()
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 1.0, y: 0 } }) // inside 1.5
    world.tanks.push(enemy)
    stepMines(world, DT, events) // the trip call
    expect(events.filter((e) => e.type === 'mine-triggered')).toHaveLength(1)
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(false)
    expect(world.mines).toHaveLength(1) // still present through the delay
    for (let i = 1; i <= MINE_PROXIMITY_DELAY_TICKS - 1; i++) {
      stepMines(world, DT, events)
      expect(events.some((e) => e.type === 'mine-detonate'), `call ${i}`).toBe(false)
    }
    stepMines(world, DT, events)
    expect(events.filter((e) => e.type === 'mine-detonate')).toHaveLength(1)
    expect(world.blasts).toHaveLength(1)
  })

  it("the fuse warning occupies the fuse's FINAL stretch: one event when timer crosses in, detonation exactly when it always was", () => {
    const { world, events } = armedFixture()
    // One call already ran (arming). The warning must fire when `timer` first
    // reaches MINE_FUSE_WARNING_TICKS * DT remaining, and expiry must land at the
    // ORIGINAL fuse tick -- the window adds NO time (owner direction on PR #311).
    let calls = 1
    while (!events.some((e) => e.type === 'mine-fuse-warning')) {
      stepMines(world, DT, events)
      calls++
      expect(calls, 'fuse warning never fired').toBeLessThan(1000)
    }
    // +1 slack: repeated `timer -= DT` accumulates float error, so the crossing
    // can land one call late -- the same drift the ~3s-timer test above absorbs
    // with its own slack. Measured here: 151, not 150, on this engine.
    const expectedWarnCall = Math.ceil(MINE_TIMER / DT) - MINE_FUSE_WARNING_TICKS
    const warnCall = calls
    expect(warnCall).toBeGreaterThanOrEqual(expectedWarnCall)
    expect(warnCall).toBeLessThanOrEqual(expectedWarnCall + 1)
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(false)
    while (!events.some((e) => e.type === 'mine-detonate')) {
      stepMines(world, DT, events)
      calls++
      expect(calls, 'fuse never detonated').toBeLessThan(1000)
    }
    // Total calls to detonation == the pre-#275 fuse length (same +1 drift
    // window): the warning ADDED no time. And the warn-to-detonate distance is
    // EXACTLY the window -- both crossings ride the same accumulated timer, so
    // the drift cancels in the difference.
    expect(calls).toBeGreaterThanOrEqual(Math.ceil(MINE_TIMER / DT))
    expect(calls).toBeLessThanOrEqual(Math.ceil(MINE_TIMER / DT) + 1)
    expect(calls - warnCall).toBe(MINE_FUSE_WARNING_TICKS)
    // And the warning fired exactly once across the whole run.
    expect(events.filter((e) => e.type === 'mine-fuse-warning')).toHaveLength(1)
  })

  it('proximity re-entry during the delay is idempotent: one mine-triggered, no countdown reset', () => {
    const { world, events } = armedFixture()
    const mine = world.mines[0]
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 1.0, y: 0 } })
    world.tanks.push(enemy)
    stepMines(world, DT, events) // trips; the enemy STAYS inside the radius
    for (let i = 1; i <= 10; i++) stepMines(world, DT, events)
    tripMineProximity(mine, events) // an explicit re-trip attempt mid-delay
    for (let i = 11; i <= MINE_PROXIMITY_DELAY_TICKS - 1; i++) stepMines(world, DT, events)
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(false) // not shortened
    stepMines(world, DT, events) // the scheduled call
    expect(events.filter((e) => e.type === 'mine-triggered')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'mine-detonate')).toHaveLength(1)
  })

  it('fuse expiry DURING the proximity delay detonates immediately: the earliest clock wins', () => {
    const { world, events } = armedFixture()
    const mine = world.mines[0]
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 1.0, y: 0 } })
    world.tanks.push(enemy)
    stepMines(world, DT, events) // trips: the reaction delay opens
    mine.timer = DT / 2 // the fuse will expire on the NEXT call, mid-delay
    stepMines(world, DT, events)
    // "Fuse expiry itself should still mean detonation" (owner direction): the
    // delay does not shield the mine from its own fuse.
    expect(events.filter((e) => e.type === 'mine-detonate')).toHaveLength(1)
  })

  it('an owner dying mid-delay does not stop the scheduled detonation', () => {
    const { world, owner, events } = armedFixture()
    tripMineProximity(world.mines[0], events)
    for (let i = 1; i <= 10; i++) stepMines(world, DT, events)
    owner.alive = false
    for (let i = 11; i <= MINE_PROXIMITY_DELAY_TICKS; i++) stepMines(world, DT, events)
    expect(events.filter((e) => e.type === 'mine-detonate')).toHaveLength(1)
  })

  it('unarmed mines under the default policy still trip no delay on proximity', () => {
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 1.0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [owner, enemy], spawns: [], lives: 3 })
    dropMine(world, 1, []) // owner stays on it: never arms
    const events: SimEvent[] = []
    for (let i = 0; i < 5; i++) stepMines(world, DT, events)
    expect(events.some((e) => e.type === 'mine-triggered')).toBe(false)
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(false)
  })
})
