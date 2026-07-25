import { describe, it, expect } from 'vitest'
import { createWorld } from './world'
import { spawnBullet, ownerShellCount, stepBullets } from './bullets'
import type { SimEvent } from './events'
import type { Tank, TankKind, Vec2, AABB, Wall, WallKind, Bullet } from './types'
import {
  PLAYER_SHELL_CAP,
  NORMAL_SPEED,
  RICOCHET_SPEED,
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
