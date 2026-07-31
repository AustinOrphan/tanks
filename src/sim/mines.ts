import type { Blast, Mine, Vec2, AABB, Wall } from './types'
import { vdist } from './types'
import type { World } from './world'
import { raySegmentVsAABB } from './collision'
import type { SimEvent } from './events'
import { configFor, wallConfigFor } from './config'
import {
  MINE_BLAST_THROUGH_DESTRUCTIBLE,
  MINE_TIMER,
  MINE_PROXIMITY_RADIUS,
  MINE_BLAST_EXPAND_TICKS,
  MINE_BLAST_HOLD_TICKS,
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
  // The owner's resolved mine capacity (configFor); MINE_CAP for every shipped kind
  // today, so behaviour-identical (see config/roster.test.ts).
  if (owner.activeMineIds.length >= configFor(owner.kind).mineCapacity) return false
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

/**
 * True when a blast at `from` can reach `to` without an intervening wall.
 *
 * Written here rather than reusing ai/targeting's lineOfSight for two reasons:
 * that helper is blind to wall KIND, which is the whole point below, and the
 * pure sim core must not depend on the AI layer.
 *
 * Evaluated against the walls as they stood when the mine went off. That falls
 * out of the ordering in detonateMine -- tanks are resolved before walls are
 * destroyed -- so a wall cannot shield a tank and be gone in the same breath.
 */
export function blastReaches(
  walls: Wall[],
  from: Vec2,
  to: Vec2,
  throughDestructible: boolean = MINE_BLAST_THROUGH_DESTRUCTIBLE,
): boolean {
  for (const w of walls) {
    if (w.destroyed) continue
    // Which walls the pass-through rule applies to is the same per-kind property
    // the destroy loop reads (destructibleByBlast) -- keeping this a kind literal
    // while applyBlast consulted config meant a future third kind could be
    // destroyed by a blast its own body still blocked. `throughDestructible`
    // (whether the rule is on at all) stays the caller's parameter.
    if (wallConfigFor(w.kind).destructibleByBlast && throughDestructible) continue
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false
  }
  return true
}

/**
 * How wide the blast is on a given tick of its life.
 *
 * Grows linearly to MINE_BLAST_RADIUS over MINE_BLAST_EXPAND_TICKS, then holds.
 * Age 0 is already lethal at close range -- standing on a mine when it goes off
 * is not survivable -- but the outer edge takes MINE_BLAST_EXPAND_TICKS to
 * arrive, which is the window a tank at the fringe can use.
 */
export function blastRadiusAt(age: number): number {
  if (age >= MINE_BLAST_EXPAND_TICKS) return MINE_BLAST_RADIUS
  // Quadratic ease-out: fast off the mark, slowing as it approaches full size, which is
  // how a real overpressure front behaves and reads far better than a constant rate.
  // t reaches exactly 1 on the last expanding tick, so f(1) = 1 and the radius lands on
  // MINE_BLAST_RADIUS exactly rather than approaching it.
  const t = (age + 1) / MINE_BLAST_EXPAND_TICKS
  return MINE_BLAST_RADIUS * (1 - (1 - t) * (1 - t))
}

/** Ticks a blast exists for: expanding, then holding at full size. */
export const BLAST_LIFETIME_TICKS = MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS

/**
 * Kill what the blast currently reaches and knock out the walls it has grown
 * into. Called once when the mine goes off and once per tick after, with a
 * larger radius each time, so lethality follows the area actually covered.
 *
 * Walls are re-tested every tick because the radius grows: a wall outside the
 * age-0 radius but inside the full one must still come down, just later.
 * (Re-testing does NOT currently let a blast see through a wall it just opened
 * -- blastReaches skips destructible walls outright while
 * MINE_BLAST_THROUGH_DESTRUCTIBLE is true, and solid walls never break.)
 */
function applyBlast(world: World, blast: Blast, events: SimEvent[]): void {
  const radius = blastRadiusAt(blast.age)
  for (const t of world.tanks) {
    if (!t.alive) continue
    // Match resolveBulletHits: a tank is a circle of TANK_RADIUS, not a point.
    // Testing the centre alone let a tank whose hull was well inside the blast
    // walk away untouched, and made the two damage systems disagree about
    // where a tank actually is.
    if (
      vdist(t.pos, blast.pos) <= radius + TANK_RADIUS &&
      blastReaches(world.walls, blast.pos, t.pos)
    ) {
      t.alive = false
      events.push({ type: 'tank-destroyed', tankId: t.id, kind: t.kind, pos: { x: t.pos.x, y: t.pos.y } })
      events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
    }
  }
  for (const w of world.walls) {
    // Whether a blast may destroy this wall comes from the wall's resolved config
    // (config/walls.ts), not a kind literal -- destructibleByBlast is true for
    // exactly today's 'destructible' kind, so behaviour is unchanged.
    if (!wallConfigFor(w.kind).destructibleByBlast || w.destroyed) continue
    if (blastHitsAABB(blast.pos, radius, w.aabb)) {
      w.destroyed = true
      const cx = (w.aabb.minX + w.aabb.maxX) / 2
      const cy = (w.aabb.minY + w.aabb.maxY) / 2
      events.push({ type: 'wall-destroyed', wallId: w.id, pos: { x: cx, y: cy } })
    }
  }
}

/**
 * Age every live blast one tick and re-apply it at its new radius.
 *
 * Runs BEFORE the stages that create blasts (stepBullets/stepMines), so a blast
 * born this tick is not aged until the next one -- it gets its full age-0 tick
 * at the radius detonateMine already applied.
 */
export function stepBlasts(world: World, events: SimEvent[]): void {
  for (const b of world.blasts) {
    b.age += 1
    applyBlast(world, b, events)
  }
  world.blasts = world.blasts.filter((b) => b.age < BLAST_LIFETIME_TICKS - 1)
}

/**
 * Set a mine off. The kill is no longer instantaneous: this applies the blast at
 * its smallest radius and leaves a Blast behind for stepBlasts to grow.
 */
export function detonateMine(world: World, mine: Mine, events: SimEvent[]): void {
  if (mine.detonated) return
  mine.detonated = true
  events.push({ type: 'mine-detonate', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })

  const blast: Blast = {
    id: world.nextId++,
    ownerId: mine.ownerId,
    pos: { x: mine.pos.x, y: mine.pos.y },
    age: 0,
  }
  world.blasts.push(blast)
  applyBlast(world, blast, events)

  const owner = world.tanks.find((t) => t.id === mine.ownerId)
  if (owner) owner.activeMineIds = owner.activeMineIds.filter((id) => id !== mine.id)
}

/**
 * May a shell detonate this mine?
 *
 * An ARMED mine always can: a mine that is live to a footstep should be live to
 * a shell, and that half is not configurable. An UNARMED one depends on the
 * world's policy, because triggering it is the "instant bomb" -- drop at an
 * enemy's feet, step back, shoot it, with no fuse and no arming delay.
 */
export function shellMayDetonate(world: World, mine: Mine): boolean {
  if (mine.armed) return true
  return world.unarmedTrigger === 'bullet' || world.unarmedTrigger === 'both'
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
    // Unarmed mines are inert unless the world says otherwise. See
    // UnarmedTrigger: 'proximity' and 'both' reinstate the instant bomb on
    // purpose, for playtesting, including the AI mutual-wipeout above.
    if (!mine.armed && world.unarmedTrigger !== 'proximity' && world.unarmedTrigger !== 'both') {
      continue
    }
    for (const t of world.tanks) {
      if (!t.alive) continue
      if (vdist(t.pos, mine.pos) > MINE_PROXIMITY_RADIUS) continue
      detonateMine(world, mine, events)
      break
    }
  }
  world.mines = world.mines.filter((m) => !m.detonated)
}
