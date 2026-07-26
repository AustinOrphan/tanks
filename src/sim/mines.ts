import type { Mine, Vec2, AABB } from './types'
import { vdist } from './types'
import type { World } from './world'
import type { SimEvent } from './events'
import {
  MINE_CAP,
  MINE_TIMER,
  MINE_PROXIMITY_RADIUS,
  MINE_BLAST_RADIUS,
  TANK_RADIUS,
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
  // Mirrors spawnBullet's guard exactly: a dead owner spawns nothing.
  if (!owner || !owner.alive) return false
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

/**
 * A blast spares nobody -- not even the tank that laid the mine. Owner safety
 * is a property of ARMING, handled in stepMines: an unarmed mine cannot be
 * triggered at all, so the only way to be caught by your own mine is to still
 * be standing on it when the fuse runs out, or to walk back onto it once it is
 * live. Both are the player's own doing.
 */
export function detonateMine(world: World, mine: Mine, events: SimEvent[]): void {
  if (mine.detonated) return
  mine.detonated = true
  events.push({ type: 'mine-detonate', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
  for (const t of world.tanks) {
    if (!t.alive) continue
    // Match resolveBulletHits: a tank is a circle of TANK_RADIUS, not a point.
    // Testing the centre alone let a tank whose hull was well inside the blast
    // walk away untouched, and made the two damage systems disagree about
    // where a tank actually is.
    if (vdist(t.pos, mine.pos) <= MINE_BLAST_RADIUS + TANK_RADIUS) {
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
    // A dead owner counts as absent. Corpses stay in world.tanks, so an owner
    // shot while standing on his own mine kept `owner` truthy at distance 0 and
    // the mine never armed -- it sat silent, with no mine-armed warning cue,
    // until the fuse ran out.
    if (
      !mine.armed &&
      (!owner || !owner.alive || vdist(owner.pos, mine.pos) > MINE_PROXIMITY_RADIUS)
    ) {
      mine.armed = true
      events.push({ type: 'mine-armed', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
    }
    if (mine.timer <= 0) {
      // Fuse expiry detonates regardless of arming, so camping on your own mine
      // is not a free bomb.
      detonateMine(world, mine, events)
      continue
    }
    // An UNARMED mine cannot be triggered by anyone. Arming is what makes a
    // mine dangerous, and it happens only once the owner has moved clear.
    //
    // Letting an unarmed mine trigger made the drop itself the weapon: the
    // mine spawns at the owner's feet and the blast reaches further than the
    // trigger, so dropping one beside an enemy detonated instantly at range
    // zero -- killing both. Exempting the owner from that blast just traded a
    // self-kill for a free kill (walk up, tap the key, walk away unharmed),
    // and made the AI wipe itself out: at the first live tick two enemies laid
    // mines beside each other and all three died on the spot.
    if (!mine.armed) continue
    for (const t of world.tanks) {
      if (!t.alive) continue
      if (vdist(t.pos, mine.pos) > MINE_PROXIMITY_RADIUS) continue
      detonateMine(world, mine, events)
      break
    }
  }
  world.mines = world.mines.filter((m) => !m.detonated)
}
