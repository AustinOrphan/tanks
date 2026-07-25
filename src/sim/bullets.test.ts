import { describe, it, expect } from 'vitest'
import { createWorld } from './world'
import { spawnBullet, ownerShellCount, stepBullets, resolveBulletHits } from './bullets'
import type { SimEvent } from './events'
import type { Tank, TankKind, Vec2, AABB, Wall, WallKind, Bullet } from './types'
import {
  PLAYER_SHELL_CAP,
  NORMAL_SPEED,
  RICOCHET_SPEED,
  FAST_SPEED,
  RICOCHET_BOUNCES,
  DT,
  bulletConfig,
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
    for (let i = 0; i < PLAYER_SHELL_CAP; i++) {
      expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(true)
    }
    expect(ownerShellCount(world, 1)).toBe(PLAYER_SHELL_CAP)
    expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(false)
    expect(ownerShellCount(world, 1)).toBe(PLAYER_SHELL_CAP)
  })

  it('does not cap enemy shells', () => {
    const brown = mkTank({ id: 2, kind: 'brown', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [brown], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    for (let i = 0; i < PLAYER_SHELL_CAP + 3; i++) {
      expect(spawnBullet(world, 2, 0, 'normal', events)).toBe(true)
    }
    expect(ownerShellCount(world, 2)).toBe(PLAYER_SHELL_CAP + 3)
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
    expect(b.pos).toEqual({ x: 2, y: 3 })
    expect(b.vel.x).toBeCloseTo(NORMAL_SPEED, 6)
    expect(b.vel.y).toBeCloseTo(0, 6)
    const fire = events.find((e) => e.type === 'fire')
    expect(fire).toMatchObject({ type: 'fire', ownerId: 1, bulletType: 'normal', angle: 0 })
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

  it('emits a ricochet event per bounce with increasing bounceIndex in a single tick (corner double-reflect)', () => {
    const walls: Wall[] = [mkWall(1, { minX: 1, minY: 1, maxX: 3, maxY: 3 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const s = Math.SQRT1_2
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 0, y: 0 },
      vel: { x: RICOCHET_SPEED * s, y: RICOCHET_SPEED * s },
      bouncesLeft: 3,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    stepBullets(world, 1, events) // big dt so it reaches the (1,1) corner this tick
    const ric = events.filter((e) => e.type === 'ricochet') as Extract<
      SimEvent,
      { type: 'ricochet' }
    >[]
    expect(ric.length).toBe(2)
    expect(ric[0].bounceIndex).toBe(0)
    expect(ric[1].bounceIndex).toBe(1)
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
    for (let k = 0; k < 3; k++) {
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
    expect(indices).toEqual([0, 1, 2])
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
