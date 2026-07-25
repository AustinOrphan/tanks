import type { Mine, Vec2, AABB } from './types'
import { vdist } from './types'
import type { World } from './world'
import type { SimEvent } from './events'
import {
  MINE_CAP,
  MINE_TIMER,
  MINE_PROXIMITY_RADIUS,
  MINE_BLAST_RADIUS,
} from './constants'

function blastHitsAABB(center: Vec2, radius: number, box: AABB): boolean {
  const cx = Math.max(box.minX, Math.min(center.x, box.maxX))
  const cy = Math.max(box.minY, Math.min(center.y, box.maxY))
  const dx = center.x - cx
  const dy = center.y - cy
  return dx * dx + dy * dy <= radius * radius
}

export function dropMine(world: World, ownerId: number, events: SimEvent[]): boolean {
  const owner = world.tanks.find((t) => t.id === ownerId)
  if (!owner) return false
  // Cap applies to every owner, not just the player: a cap each caller must opt into
  // is a cap the next spawner (AI) silently escapes. This was gated on owner.kind ===
  // 'player' when the player was the only mine-dropper; that made it a no-op for AI owners.
  if (owner.activeMineIds.length >= MINE_CAP) return false
  const mine: Mine = {
    id: world.nextId++,
    ownerId,
    pos: { x: owner.pos.x, y: owner.pos.y },
    timer: MINE_TIMER,
    armed: false,
    detonated: false,
  }
  world.mines.push(mine)
  owner.activeMineIds.push(mine.id)
  events.push({ type: 'mine-dropped', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
  return true
}

export function detonateMine(world: World, mine: Mine, events: SimEvent[]): void {
  if (mine.detonated) return
  mine.detonated = true
  events.push({ type: 'mine-detonate', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
  for (const t of world.tanks) {
    if (!t.alive) continue
    if (vdist(t.pos, mine.pos) <= MINE_BLAST_RADIUS) {
      t.alive = false
      events.push({ type: 'tank-destroyed', tankId: t.id, kind: t.kind, pos: { x: t.pos.x, y: t.pos.y } })
      events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
    }
  }
  for (const w of world.walls) {
    if (w.kind !== 'destructible' || w.destroyed) continue
    if (blastHitsAABB(mine.pos, MINE_BLAST_RADIUS, w.aabb)) {
      w.destroyed = true
      const cx = (w.aabb.minX + w.aabb.maxX) / 2
      const cy = (w.aabb.minY + w.aabb.maxY) / 2
      events.push({ type: 'wall-destroyed', wallId: w.id, pos: { x: cx, y: cy } })
    }
  }
  const owner = world.tanks.find((t) => t.id === mine.ownerId)
  if (owner) owner.activeMineIds = owner.activeMineIds.filter((id) => id !== mine.id)
}

export function stepMines(world: World, dt: number, events: SimEvent[]): void {
  for (const mine of [...world.mines]) {
    if (mine.detonated) continue
    mine.timer -= dt
    const owner = world.tanks.find((t) => t.id === mine.ownerId)
    if (!mine.armed && (!owner || vdist(owner.pos, mine.pos) > MINE_PROXIMITY_RADIUS)) {
      mine.armed = true
      events.push({ type: 'mine-armed', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
    }
    if (mine.timer <= 0) {
      detonateMine(world, mine, events)
      continue
    }
    for (const t of world.tanks) {
      if (!t.alive) continue
      if (vdist(t.pos, mine.pos) > MINE_PROXIMITY_RADIUS) continue
      if (t.id === mine.ownerId && !mine.armed) continue // owner immune until armed
      detonateMine(world, mine, events)
      break
    }
  }
  world.mines = world.mines.filter((m) => !m.detonated)
}
