import { describe, it, expect } from 'vitest'
import { createWorld } from './world'
import { spawnBullet, ownerShellCount, stepBullets, resolveBulletHits } from './bullets'
import type { SimEvent } from './events'
import type { Tank, TankKind, Vec2, AABB, Wall, WallKind, Bullet } from './types'
import {
  SHELL_CAP,
  NORMAL_SPEED,
  RICOCHET_SPEED,
  FAST_SPEED,
  RICOCHET_BOUNCES,
  DT,
  bulletConfig,
  BULLET_RADIUS,
  SHELL_SPAWN_FORWARD,
  TANK_RADIUS,
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
    // Optional flags must pass through, or a fixture claiming them silently tests the
    // default -- an "invincible" tank built here was mortal until this line existed.
    disarmed: p.disarmed,
    invincible: p.invincible,
  }
}

function mkWall(id: number, aabb: AABB, kind: WallKind = 'solid'): Wall {
  return { id, aabb, kind, destroyed: false }
}

describe('spawnBullet + ownerShellCount', () => {
  it("rejects the player's 6th concurrent shell while 5 are live", () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    for (let i = 0; i < SHELL_CAP; i++) {
      expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(true)
    }
    expect(ownerShellCount(world, 1)).toBe(SHELL_CAP)
    expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(false)
    expect(ownerShellCount(world, 1)).toBe(SHELL_CAP)
    // A refused shot must also be SILENT. Asserting only the return value and
    // the shell count leaves the event stream unchecked, so pushing a `fire`
    // event before the capped `return false` passes every other assertion here
    // -- and the audio director (src/audio/director.ts) plays a cannon report
    // for every `fire` event it sees. The player would hear five reloads' worth
    // of phantom shots while the tank sat empty. mines.test.ts already pins the
    // equivalent for a capped mine drop; this mirrors it.
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(SHELL_CAP)
  })

  it('rejects a NON-player owner\'s shell at SHELL_CAP (cap applies to every owner)', () => {
    const brown = mkTank({ id: 2, kind: 'brown', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [brown], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    for (let i = 0; i < SHELL_CAP; i++) {
      expect(spawnBullet(world, 2, 0, 'normal', events)).toBe(true)
    }
    expect(ownerShellCount(world, 2)).toBe(SHELL_CAP)
    const beforeBulletCount = world.bullets.length
    expect(spawnBullet(world, 2, 0, 'normal', events)).toBe(false)
    expect(ownerShellCount(world, 2)).toBe(SHELL_CAP)
    expect(world.bullets.length).toBe(beforeBulletCount) // no bullet appended
    expect(events.filter((e) => e.type === 'fire')).toHaveLength(SHELL_CAP) // ...and no phantom report
  })

  it('rejects a dead owner (defence-in-depth: stepAi already skips dead tanks, but this is the chokepoint)', () => {
    const brown = mkTank({ id: 3, kind: 'brown', pos: { x: 0, y: 0 }, alive: false })
    const world = createWorld({ walls: [], tanks: [brown], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    expect(spawnBullet(world, 3, 0, 'normal', events)).toBe(false)
    expect(world.bullets.length).toBe(0)
    expect(events.length).toBe(0)
  })

  it('spawns a bullet with config speed/bounces and emits a fire event', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 2, y: 3 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(true)
    const b = world.bullets[0]
    expect(b.ownerId).toBe(1)
    expect(b.type).toBe('normal')
    expect(b.bouncesLeft).toBe(bulletConfig.normal.bounces)
    expect(b.pos).toEqual({ x: 2 + SHELL_SPAWN_FORWARD, y: 3 })
    expect(b.vel.x).toBeCloseTo(NORMAL_SPEED, 6)
    expect(b.vel.y).toBeCloseTo(0, 6)
    const fire = events.find((e) => e.type === 'fire')
    expect(fire).toMatchObject({
      type: 'fire', ownerId: 1, bulletType: 'normal', angle: 0, pos: { x: 2 + SHELL_SPAWN_FORWARD, y: 3 },
    })
  })
})

describe('stepBullets', () => {
  it('a normal shell survives exactly one bounce and dies on the second wall hit', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 1.9, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: bulletConfig.normal.bounces,
      alive: true,
    }
    world.bullets.push(b)
    // first hit: travel 0.3 crosses the x=2 face and bounces once
    stepBullets(world, 0.05, [])
    expect(b.alive).toBe(true)
    expect(b.bouncesLeft).toBe(0)
    expect(b.vel.x).toBeLessThan(0)
    // send it into a wall again with no bounces left -> dies
    b.pos = { x: 1.9, y: 0 }
    b.vel = { x: NORMAL_SPEED, y: 0 }
    stepBullets(world, 0.05, [])
    expect(b.alive).toBe(false)
  })

  it('a shell fired at a boundary wall bounces back inward instead of leaving the arena', () => {
    const walls: Wall[] = [mkWall(1, { minX: 5, minY: -10, maxX: 6, maxY: 10 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 4.8, y: 0 },
      vel: { x: RICOCHET_SPEED, y: 0 },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    stepBullets(world, 0.1, [])
    expect(b.vel.x).toBeLessThan(0)
    expect(b.pos.x).toBeLessThan(5)
  })

  it('emits exactly ONE ricochet event for a corner hit (corner double-reflect, charged as a single bounce)', () => {
    // SUBJECT CHANGED from "emits a ricochet event per bounce with increasing
    // bounceIndex in a single tick": the corner branch in collision.ts used to push
    // two SweepHits for one physical deflection point, so this same scenario used to
    // emit TWO ricochet events (bounceIndex 0 and 1) at the identical pos and tick --
    // while bouncesLeft only decremented once, and the NEXT real bounce's bounceIndex
    // collided with the corner's second event (measured sequence [0, 1, 1]). Fixed by
    // collapsing the corner branch to one hit record, so events-emitted and
    // budget-consumed move 1:1 for every bounce including corners.
    const walls: Wall[] = [mkWall(1, { minX: 1, minY: 1, maxX: 3, maxY: 3 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const s = Math.SQRT1_2
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 0, y: 0 },
      vel: { x: RICOCHET_SPEED * s, y: RICOCHET_SPEED * s },
      // From config, not a literal: a stale 3 against a retuned budget of 2 made
      // consumedBefore NEGATIVE and the first bounceIndex -1.
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    stepBullets(world, 1, events) // big dt so it reaches the (1,1) corner this tick
    const ric = events.filter((e) => e.type === 'ricochet') as Extract<
      SimEvent,
      { type: 'ricochet' }
    >[]
    expect(ric.length).toBe(1)
    expect(ric[0].bounceIndex).toBe(0)
  })

  // Three new pins for the collapsed-corner fix (issue: a corner hit pushed two
  // SweepHits for one physical deflection point while bouncesLeft only decremented
  // once). Written and run red against the unfixed collision.ts before the fix
  // landed -- see the commit message for the recorded counts.

  it('an exact corner emits exactly ONE ricochet event, and the shell velocity retroreflects (physics unchanged by the fix)', () => {
    const walls: Wall[] = [mkWall(1, { minX: 1, minY: 1, maxX: 3, maxY: 3 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const s = Math.SQRT1_2
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 0, y: 0 },
      vel: { x: RICOCHET_SPEED * s, y: RICOCHET_SPEED * s },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    stepBullets(world, 1, events) // big dt so it reaches the (1,1) corner this tick
    const ric = events.filter((e) => e.type === 'ricochet') as Extract<
      SimEvent,
      { type: 'ricochet' }
    >[]
    // One physical deflection point -> one event, not two at the same pos/tick.
    expect(ric.length).toBe(1)
    expect(ric[0].bounceIndex).toBe(0)
    expect(ric[0].pos.x).toBeCloseTo(1, 9)
    expect(ric[0].pos.y).toBeCloseTo(1, 9)
    // The retroreflection itself is unchanged by this fix: both incoming
    // components still flip sign.
    expect(b.vel.x).toBeLessThan(0)
    expect(b.vel.y).toBeLessThan(0)
  })

  it('bounceIndex does not repeat across ticks when a corner bounce is followed by a flush bounce', () => {
    const walls: Wall[] = [
      mkWall(1, { minX: 1, minY: 1, maxX: 3, maxY: 3 }),
      mkWall(2, { minX: 10, minY: -5, maxX: 11, maxY: 5 }),
    ]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const s = Math.SQRT1_2
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 0, y: 0 },
      vel: { x: RICOCHET_SPEED * s, y: RICOCHET_SPEED * s },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    const allIndices: number[] = []

    // Tick A: the corner.
    let events: SimEvent[] = []
    stepBullets(world, 1, events)
    allIndices.push(
      ...(events.filter((e) => e.type === 'ricochet') as Extract<SimEvent, { type: 'ricochet' }>[]).map(
        (e) => e.bounceIndex,
      ),
    )

    // Tick B, later: re-present the shell at a DIFFERENT, flush wall so the second
    // bounce lands in its own stepBullets call -- separating the two bounces in
    // time is what exposes consumedBefore repeating a value.
    b.pos = { x: 9.95, y: 0 }
    b.vel = { x: RICOCHET_SPEED, y: 0 }
    events = []
    stepBullets(world, DT, events)
    allIndices.push(
      ...(events.filter((e) => e.type === 'ricochet') as Extract<SimEvent, { type: 'ricochet' }>[]).map(
        (e) => e.bounceIndex,
      ),
    )

    expect(allIndices).toEqual([0, 1])
  })

  it('a ricochet shell (bounces:2) is spent after a corner then a flush bounce -- no third reflection', () => {
    const walls: Wall[] = [
      mkWall(1, { minX: 1, minY: 1, maxX: 3, maxY: 3 }),
      mkWall(2, { minX: 10, minY: -5, maxX: 11, maxY: 5 }),
    ]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const s = Math.SQRT1_2
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 0, y: 0 },
      vel: { x: RICOCHET_SPEED * s, y: RICOCHET_SPEED * s },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    let totalRicochets = 0

    // Corner: charged as one bounce.
    let events: SimEvent[] = []
    stepBullets(world, 1, events)
    totalRicochets += events.filter((e) => e.type === 'ricochet').length

    // Flush: the second and last bounce this budget allows.
    b.pos = { x: 9.95, y: 0 }
    b.vel = { x: RICOCHET_SPEED, y: 0 }
    events = []
    stepBullets(world, DT, events)
    totalRicochets += events.filter((e) => e.type === 'ricochet').length
    expect(b.bouncesLeft).toBe(0)
    expect(b.alive).toBe(true)

    // A third contact must not reflect -- the budget is spent.
    b.pos = { x: 9.95, y: 0 }
    b.vel = { x: RICOCHET_SPEED, y: 0 }
    events = []
    stepBullets(world, DT, events)
    expect(events.filter((e) => e.type === 'ricochet').length).toBe(0)
    expect(b.alive).toBe(false)

    // Two bounces consumed a two-event budget exactly -- not three.
    expect(totalRicochets).toBe(2)
  })

  it('is deterministic across identical steps', () => {
    const makeWorld = () => {
      const walls: Wall[] = [mkWall(1, { minX: 3, minY: -5, maxX: 4, maxY: 5 })]
      const w = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
      w.bullets.push({
        id: 1,
        ownerId: 1,
        type: 'ricochet',
        pos: { x: 0, y: 0 },
        vel: { x: RICOCHET_SPEED, y: 0.3 },
        bouncesLeft: 3,
        alive: true,
      })
      return w
    }
    const a = makeWorld()
    const b = makeWorld()
    for (let i = 0; i < 30; i++) {
      stepBullets(a, DT, [])
      stepBullets(b, DT, [])
    }
    expect(a.bullets).toEqual(b.bullets)
  })
})

describe('bullet types', () => {
  it('increments bounceIndex across ticks so ricochet audio can pitch-shift per bounce', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 1.95, y: 0 },
      vel: { x: RICOCHET_SPEED, y: 0 },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    const indices: number[] = []
    // Exactly the configured budget: the tick after the last bounce EXPIRES the shell
    // instead of reflecting it, so walking further asserts on a ricochet that
    // correctly never happens. 2 since the 2026-07-31 balance pass.
    for (let k = 0; k < bulletConfig.ricochet.bounces; k++) {
      // re-present the bullet at the wall each tick to force one bounce per tick
      b.pos = { x: 1.95, y: 0 }
      b.vel = { x: RICOCHET_SPEED, y: 0 }
      const events: SimEvent[] = []
      stepBullets(world, DT, events)
      const ric = events.filter((e) => e.type === 'ricochet') as Extract<
        SimEvent,
        { type: 'ricochet' }
      >[]
      expect(ric.length).toBe(1)
      indices.push(ric[0].bounceIndex)
    }
    expect(indices).toEqual([...Array(bulletConfig.ricochet.bounces).keys()])
    expect(indices.length).toBeGreaterThanOrEqual(2) // pitch-shift needs at least two steps
  })

  it('a fast shell dies on the first wall hit with no bounce and emits no ricochet', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'fast',
      pos: { x: 1.9, y: 0 },
      vel: { x: FAST_SPEED, y: 0 },
      bouncesLeft: bulletConfig.fast.bounces,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    stepBullets(world, 0.05, events) // travel 0.6 -> crosses x=2
    expect(bulletConfig.fast.bounces).toBe(0)
    expect(b.alive).toBe(false)
    expect(events.filter((e) => e.type === 'ricochet').length).toBe(0)
  })

  it('a fast shell travels farther per tick than a normal shell (no tunneling)', () => {
    const world = createWorld({ walls: [], tanks: [], spawns: [], lives: 3 })
    const normal: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: bulletConfig.normal.bounces,
      alive: true,
    }
    const fast: Bullet = {
      id: 2,
      ownerId: 1,
      type: 'fast',
      pos: { x: 0, y: 0 },
      vel: { x: FAST_SPEED, y: 0 },
      bouncesLeft: bulletConfig.fast.bounces,
      alive: true,
    }
    world.bullets.push(normal, fast)
    stepBullets(world, DT, [])
    expect(fast.pos.x).toBeGreaterThan(normal.pos.x)
  })

  it('a ricochet shell survives exactly RICOCHET_BOUNCES wall hits then dies', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 1.9, y: 0 },
      vel: { x: RICOCHET_SPEED, y: 0 },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    for (let k = 0; k < RICOCHET_BOUNCES; k++) {
      b.pos = { x: 1.9, y: 0 }
      b.vel = { x: RICOCHET_SPEED, y: 0 }
      stepBullets(world, 0.05, [])
      expect(b.alive).toBe(true)
    }
    expect(b.bouncesLeft).toBe(0)
    b.pos = { x: 1.9, y: 0 }
    b.vel = { x: RICOCHET_SPEED, y: 0 }
    stepBullets(world, 0.05, [])
    expect(b.alive).toBe(false)
  })
})

describe('resolveBulletHits', () => {
  it('a bullet overlapping an enemy destroys it and emits tank-destroyed + explosion', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 5, y: 5 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 0.5, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0.1, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    resolveBulletHits(world, events)
    expect(enemy.alive).toBe(false)
    expect(b.alive).toBe(false)
    expect(events.find((e) => e.type === 'tank-destroyed')).toMatchObject({
      type: 'tank-destroyed',
      tankId: 2,
      kind: 'brown',
    })
    expect(events.some((e) => e.type === 'explosion')).toBe(true)
  })

  it('a bullet overlapping the player destroys the player (one-hit death applies to the player too)', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 9, y: 9 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 2,
      type: 'normal',
      pos: { x: 0.3, y: 0 },
      vel: { x: -NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(b)
    resolveBulletHits(world, [])
    expect(player.alive).toBe(false)
  })

  it('a bullet that misses leaves tanks alive', () => {
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [enemy], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 3, y: 3 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(b)
    resolveBulletHits(world, [])
    expect(enemy.alive).toBe(true)
    expect(b.alive).toBe(true)
  })

  it('resolves the hit/miss boundary at exactly TANK_RADIUS + BULLET_RADIUS', () => {
    // THE DISCRIMINATING BAND. Every other hit test above places the bullet
    // 0.1-0.4 from a 0.5-radius tank centre (deep inside the hull) and every
    // miss test puts it at (3, 3) (four diameters away) -- nothing anywhere
    // near the contact distance. Consequence: BULLET_RADIUS could be mutated
    // 0.1 -> 1.0, a tenfold fattening that makes every shell a shotgun, and
    // the whole suite stayed green.
    //
    // resolveBulletHits models the collision as circleVsCircle(bullet,
    // BULLET_RADIUS, tank, TANK_RADIUS), i.e. contact at centre distance
    // TANK_RADIUS + BULLET_RADIUS = 0.5 + 0.1 = 0.6.
    //
    // The probe distances below are LITERALS, deliberately, not expressions in
    // those constants. Writing `TANK_RADIUS + BULLET_RADIUS + 0.05` would make
    // this test float with BULLET_RADIUS exactly like the tests it is here to
    // reinforce -- the band would obediently follow the constant to 1.0 and the
    // mutation would survive a second time. Literals make the band an absolute
    // claim about the game's geometry.
    const CONTACT = 0.6
    const MISS_AT = 0.65 // contact + 0.05
    const HIT_AT = 0.55 // contact - 0.05

    // If a deliberate retune ever moves contact out from under those literals,
    // fail here with an explanation rather than silently probing the wrong band.
    expect(TANK_RADIUS + BULLET_RADIUS).toBe(CONTACT)

    // Just OUTSIDE contact: the shell passes by, harmlessly, and survives.
    {
      const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 0, y: 0 } })
      const world = createWorld({ walls: [], tanks: [enemy], spawns: [], lives: 3 })
      const b: Bullet = {
        id: 10,
        ownerId: 1, // not the enemy: the muzzle-immunity branch never applies
        type: 'normal',
        pos: { x: MISS_AT, y: 0 },
        vel: { x: 0, y: NORMAL_SPEED },
        bouncesLeft: 1,
        alive: true,
      }
      world.bullets.push(b)
      const events: SimEvent[] = []
      resolveBulletHits(world, events)
      expect(enemy.alive).toBe(true)
      expect(b.alive).toBe(true)
      expect(events).toEqual([])
    }

    // Just INSIDE contact: the same shell, 0.1 closer, is a kill.
    {
      const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 0, y: 0 } })
      const world = createWorld({ walls: [], tanks: [enemy], spawns: [], lives: 3 })
      const b: Bullet = {
        id: 10,
        ownerId: 1,
        type: 'normal',
        pos: { x: HIT_AT, y: 0 },
        vel: { x: 0, y: NORMAL_SPEED },
        bouncesLeft: 1,
        alive: true,
      }
      world.bullets.push(b)
      const events: SimEvent[] = []
      resolveBulletHits(world, events)
      expect(enemy.alive).toBe(false)
      expect(b.alive).toBe(false)
      expect(events.some((e) => e.type === 'tank-destroyed')).toBe(true)
    }
  })

  it('does not self-destruct in the muzzle but can self-hit on a ricochet return', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    // freshly fired: bullet at the muzzle heading away -> no self hit
    const outbound: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(outbound)
    resolveBulletHits(world, [])
    expect(player.alive).toBe(true)
    expect(outbound.alive).toBe(true)
    // a shell heading back into the owner (post-ricochet) does hit
    const inbound: Bullet = {
      id: 11,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0.4, y: 0 },
      vel: { x: -NORMAL_SPEED, y: 0 },
      bouncesLeft: 0,
      alive: true,
    }
    world.bullets.push(inbound)
    resolveBulletHits(world, [])
    expect(player.alive).toBe(false)
    expect(inbound.alive).toBe(false)
  })
})

describe('stepBullets retires a shell that is inside a wall', () => {
  it('kills a shell found embedded in solid geometry', () => {
    // Defence in depth behind reflectSweep's corner fix. A live shell inside a solid wall
    // is never a legal state, and when one did occur it was unrecoverable: from inside an
    // AABB raySegmentVsAABB reports t=0, so the shell never collided again, left the map,
    // and held one of its owner's SHELL_CAP slots for the rest of the life. Retiring on the
    // invariant means a future arena edit that introduces a new wall junction costs a shell
    // rather than the player's ability to fire.
    const world = {
      tick: 0, nextId: 100, seed: 1, spawns: [], status: 'playing' as const, lives: 3,
      roundStartTick: 0, unarmedTrigger: 'none' as const, tanks: [], mines: [], blasts: [],
      walls: [{ id: 1, aabb: { minX: -2, minY: 0, maxX: 0, maxY: 18 }, kind: 'solid' as const, destroyed: false }],
      bullets: [{
        id: 50, ownerId: 1, type: 'normal' as const,
        pos: { x: -1, y: 5 }, vel: { x: -6, y: 0 }, bouncesLeft: 1, alive: true,
      }],
    };
    stepBullets(world, 1 / 60, []);
    expect(world.bullets[0].alive).toBe(false);
  });

  it('leaves a shell resting exactly on a wall face alone', () => {
    // A legitimate bounce puts the shell exactly ON the face; that must not be mistaken
    // for being embedded, or every ricochet would die on contact.
    const world = {
      tick: 0, nextId: 100, seed: 1, spawns: [], status: 'playing' as const, lives: 3,
      roundStartTick: 0, unarmedTrigger: 'none' as const, tanks: [], mines: [], blasts: [],
      walls: [{ id: 1, aabb: { minX: -2, minY: 0, maxX: 0, maxY: 18 }, kind: 'solid' as const, destroyed: false }],
      bullets: [{
        id: 50, ownerId: 1, type: 'normal' as const,
        pos: { x: 0, y: 5 }, vel: { x: 6, y: 0 }, bouncesLeft: 1, alive: true,
      }],
    };
    stepBullets(world, 1 / 60, []);
    expect(world.bullets[0].alive).toBe(true);
  });
});

describe('shells destroy each other', () => {
  const shell = (id: number, owner: number, x: number, y: number, vx: number, vy: number): Bullet => ({
    id, ownerId: owner, type: 'normal', pos: { x, y }, vel: { x: vx, y: vy }, bouncesLeft: 3, alive: true,
  });
  const w = (bullets: Bullet[]) =>
    ({ ...createWorld({ walls: [], tanks: [], spawns: [], lives: 3 }), bullets });

  it('cancels a head-on pair', () => {
    // The case a player aims for. At NORMAL_SPEED each shell covers 0.1 per
    // tick and the pair closes 0.2 -- exactly the bullet diameter -- so an
    // end-position check would miss about half of these. Start them 0.15 apart
    // so they pass THROUGH each other within one tick without ever ending
    // within a diameter.
    const world = w([shell(1, 7, 0, 0, 6, 0), shell(2, 8, 0.15, 0, -6, 0)]);
    const ev: SimEvent[] = [];
    stepBullets(world, 1 / 60, ev);
    expect(world.bullets.filter((b) => b.alive)).toHaveLength(0);
  });

  it('reports where they met, so the burst is drawn there', () => {
    const world = w([shell(1, 7, 0, 0, 6, 0), shell(2, 8, 0.15, 0, -6, 0)]);
    const ev: SimEvent[] = [];
    stepBullets(world, 1 / 60, ev);
    const boom = ev.filter((e) => e.type === 'explosion');
    expect(boom).toHaveLength(1);
    const pos = (boom[0] as Extract<SimEvent, { type: 'explosion' }>).pos;
    expect(pos.x).toBeGreaterThan(-0.2);
    expect(pos.x).toBeLessThan(0.35);
  });

  it('cancels shells from the SAME owner', () => {
    // Two of your own shells meeting after a ricochet is a real case, and
    // physically they do not care who fired them.
    const world = w([shell(1, 7, 0, 0, 6, 0), shell(2, 7, 0.15, 0, -6, 0)]);
    stepBullets(world, 1 / 60, []);
    expect(world.bullets.filter((b) => b.alive)).toHaveLength(0);
  });

  it('leaves shells that merely pass nearby', () => {
    // The control. Without it, "cancel everything" would pass every test above.
    const world = w([shell(1, 7, 0, 0, 6, 0), shell(2, 8, 0.15, 2, -6, 0)]);
    stepBullets(world, 1 / 60, []);
    expect(world.bullets.filter((b) => b.alive)).toHaveLength(2);
  });

  it('cancels a graze just inside the diameter', () => {
    // Head-on shells on the SAME line have a closest approach of zero, so they
    // collide whatever the radius is -- those tests pass even with the radius
    // shrunk to nothing. Offsetting the paths is what actually exercises it.
    // 0.15 lateral is inside the 0.2 diameter.
    const world = w([shell(1, 7, 0, 0, 6, 0), shell(2, 8, 0.15, 0.15, -6, 0)]);
    stepBullets(world, 1 / 60, []);
    expect(world.bullets.filter((b) => b.alive)).toHaveLength(0);
  });

  it('spares a graze just outside the diameter', () => {
    // 0.25 lateral is outside the 0.2 diameter: near miss, both survive. The
    // pair of grazes brackets the radius, so widening or narrowing it fails one.
    const world = w([shell(1, 7, 0, 0, 6, 0), shell(2, 8, 0.15, 0.25, -6, 0)]);
    stepBullets(world, 1 / 60, []);
    expect(world.bullets.filter((b) => b.alive)).toHaveLength(2);
  });

  it('leaves a lone shell alone', () => {
    const world = w([shell(1, 7, 0, 0, 6, 0)]);
    stepBullets(world, 1 / 60, []);
    expect(world.bullets[0].alive).toBe(true);
  });

  it('kills exactly the pair that met, not every shell present', () => {
    const world = w([
      shell(1, 7, 0, 0, 6, 0),
      shell(2, 8, 0.15, 0, -6, 0),
      shell(3, 9, 0, 5, 6, 0), // far away, minding its own business
    ]);
    stepBullets(world, 1 / 60, []);
    const alive = world.bullets.filter((b) => b.alive);
    expect(alive).toHaveLength(1);
    expect(alive[0].id).toBe(3);
  });

  it('cancels a crossing pair, not just a head-on one', () => {
    const world = w([shell(1, 7, 0, 0, 6, 0), shell(2, 8, 0.1, 0.1, 0, -6)]);
    stepBullets(world, 1 / 60, []);
    expect(world.bullets.filter((b) => b.alive)).toHaveLength(0);
  });
});

describe('shells versus wall kinds', () => {
  // Shells treat every INTACT wall alike and ignore destroyed ones -- one filter, at the
  // top of stepBullets. Nothing pinned it: deleting `.filter((w) => !w.destroyed)` left
  // all 682 tests green while shells ricocheted off walls that no longer exist.
  //
  // The three cases below are one fixture with one field changed, so they discriminate
  // rather than merely pass: same geometry, same shell, only `kind`/`destroyed` differ.
  function shellAtWall(kind: WallKind, destroyed: boolean) {
    const world = {
      tick: 0, nextId: 100, seed: 1, spawns: [], status: 'playing' as const, lives: 3,
      roundStartTick: 0, unarmedTrigger: 'none' as const, tanks: [], mines: [], blasts: [],
      walls: [{ id: 1, aabb: { minX: 2, minY: -2, maxX: 3, maxY: 2 }, kind, destroyed }],
      bullets: [{
        id: 50, ownerId: 1, type: 'normal' as const,
        // Travelling +x at the wall, starting clear of it. One tick of travel at
        // NORMAL_SPEED is 0.1, so it needs several ticks to arrive -- an immediate
        // reflection would be the fixture, not the behaviour.
        pos: { x: 0, y: 0 }, vel: { x: NORMAL_SPEED, y: 0 }, bouncesLeft: 1, alive: true,
      }],
    }
    // Long enough to cross the wall entirely if nothing stops it.
    for (let i = 0; i < 60; i++) stepBullets(world, DT, [])
    return world.bullets[0]
  }

  it('is stopped by an intact SOLID wall', () => {
    const b = shellAtWall('solid', false)
    expect(b.pos.x).toBeLessThan(2) // never reached the far face at x=3
    expect(b.vel.x).toBeLessThan(0) // turned around rather than passing
  })

  it('is stopped by an intact DESTRUCTIBLE wall', () => {
    // The one a kind-sensitive bug would break: a shell must not treat "destructible"
    // as "already a hole".
    const b = shellAtWall('destructible', false)
    expect(b.pos.x).toBeLessThan(2)
    expect(b.vel.x).toBeLessThan(0)
  })

  it('passes straight through a DESTROYED destructible wall', () => {
    // The discriminating case, and the one the missing filter broke. Same wall as
    // above with destroyed:true -- it must now be as if it were not there.
    const b = shellAtWall('destructible', true)
    expect(b.pos.x).toBeGreaterThan(3) // clean through the far face
    expect(b.vel.x).toBeGreaterThan(0) // never deflected
  })
})

describe('spawnBullet: where the shell is born', () => {
  it('spawns at the muzzle, offset along the FIRING angle not the body', () => {
    // Straight up the sim's +y, to catch an offset applied on the wrong axis -- which
    // firing along +x in the test above cannot distinguish.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 5, y: 5 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    expect(spawnBullet(world, 1, Math.PI / 2, 'normal', [])).toBe(true)
    expect(world.bullets[0].pos.x).toBeCloseTo(5, 9)
    expect(world.bullets[0].pos.y).toBeCloseTo(5 + SHELL_SPAWN_FORWARD, 9)
  })

  it('falls back to the tank centre when the muzzle is inside a wall', () => {
    // SHELL_SPAWN_FORWARD reaches past the tank's own collision radius, so a tank
    // nose-to-wall has its muzzle in solid geometry. Spawning there would create the
    // embedded-shell state stepBullets has to retire on sight, silently costing a
    // shell from the cap.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const wall = mkWall(1, { minX: 0.5, minY: -2, maxX: 2, maxY: 2 }, 'solid')
    const world = createWorld({ walls: [wall], tanks: [player], spawns: [], lives: 3 })
    expect(spawnBullet(world, 1, 0, 'normal', [])).toBe(true)
    expect(world.bullets[0].pos).toEqual({ x: 0, y: 0 })
  })

  it('still uses the muzzle when the wall is behind the tank', () => {
    // The discriminating partner: same fixture, wall on the other side. Without this a
    // fallback that always fired centre-spawn would pass the case above.
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const wall = mkWall(1, { minX: -2, minY: -2, maxX: -0.5, maxY: 2 }, 'solid')
    const world = createWorld({ walls: [wall], tanks: [player], spawns: [], lives: 3 })
    expect(spawnBullet(world, 1, 0, 'normal', [])).toBe(true)
    expect(world.bullets[0].pos.x).toBeCloseTo(SHELL_SPAWN_FORWARD, 9)
  })
})

describe('resolveBulletHits: invincible tanks (dev playtest mode)', () => {
  it('the shell detonates on an invincible tank, which survives it', () => {
    // The shell must still die -- an invincible tank that shells pass THROUGH would
    // shield nothing and look broken; it is a wall to ordnance, not a ghost.
    const target = mkTank({ id: 2, kind: 'player', pos: { x: 1, y: 0 }, invincible: true })
    const world = createWorld({ walls: [], tanks: [target], spawns: [], lives: 3 })
    world.bullets.push({ id: 9, ownerId: 7, type: 'normal', pos: { x: 0.7, y: 0 }, vel: { x: NORMAL_SPEED, y: 0 }, bouncesLeft: 1, alive: true })
    const events: SimEvent[] = []
    resolveBulletHits(world, events)
    expect(world.tanks[0].alive).toBe(true)
    expect(world.bullets).toHaveLength(0) // the shell died on impact and was retired
    expect(events.some((e) => e.type === 'tank-destroyed')).toBe(false)
    expect(events.some((e) => e.type === 'explosion')).toBe(true) // the impact still reads
  })

  it('the mortal twin dies to the identical shell -- the fixture really is lethal', () => {
    const target = mkTank({ id: 2, kind: 'player', pos: { x: 1, y: 0 } })
    const world = createWorld({ walls: [], tanks: [target], spawns: [], lives: 3 })
    world.bullets.push({ id: 9, ownerId: 7, type: 'normal', pos: { x: 0.7, y: 0 }, vel: { x: NORMAL_SPEED, y: 0 }, bouncesLeft: 1, alive: true })
    resolveBulletHits(world, [])
    expect(world.tanks[0].alive).toBe(false)
  })
})
