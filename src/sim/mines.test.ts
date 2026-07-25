import { describe, it, expect } from 'vitest'
import { createWorld } from './world'
import { dropMine, stepMines, detonateMine } from './mines'
import type { SimEvent } from './events'
import type { Tank, TankKind, Vec2, AABB, Wall, WallKind, Mine } from './types'
import {
  MINE_CAP,
  MINE_TIMER,
  MINE_PROXIMITY_RADIUS,
  MINE_BLAST_RADIUS,
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
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
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
  it('kills tanks inside the blast radius but not just outside it', () => {
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const inside = mkTank({ id: 2, kind: 'brown', pos: { x: MINE_BLAST_RADIUS - 0.5, y: 0 } })
    const outside = mkTank({ id: 3, kind: 'grey', pos: { x: MINE_BLAST_RADIUS + 0.5, y: 0 } })
    const world = createWorld({ walls: [], tanks: [owner, inside, outside], spawns: [], lives: 3 })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    expect(inside.alive).toBe(false) // 1.5 <= 2.0
    expect(outside.alive).toBe(true) // 2.5 > 2.0
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
    detonateMine(world, mine, events)
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
    detonateMine(world, first, [])
    expect(player.activeMineIds.includes(first.id)).toBe(false)
    expect(dropMine(world, 1, [])).toBe(true) // slot freed
  })
})
