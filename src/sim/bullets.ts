import type { Tank, Bullet, BulletType, Vec2 } from './types'
import { fromAngle, vscale, vadd, vlen, vsub, vdot } from './types'
import { circleVsAABB, reflectSweep, circleVsCircle } from './collision'
import { detonateMine, shellMayDetonate } from './mines'
import type { World } from './world'
import type { SimEvent } from './events'
import { bulletConfig, BULLET_RADIUS, TANK_RADIUS, MINE_TRIGGER_RADIUS, SHELL_SPAWN_FORWARD } from './constants'
import { configFor } from './config'

/**
 * Where the shell is born: at the muzzle, unless the muzzle is inside a wall.
 *
 * SHELL_SPAWN_FORWARD reaches past the tank's own collision radius, so a tank
 * nose-to-wall has its muzzle INSIDE that wall. Spawning there would put a live shell
 * in solid geometry -- the state stepBullets already has to retire on sight -- and
 * firing while touching a wall would silently burn a SHELL_CAP slot.
 *
 * So the muzzle is used only when it is clear, and the tank's centre is the fallback,
 * which is exactly the pre-offset behaviour. That keeps the degenerate case working
 * the way it always has rather than inventing a new one.
 */
function muzzlePoint(world: World, owner: Tank, dir: Vec2): Vec2 {
  const muzzle = vadd(owner.pos, vscale(dir, SHELL_SPAWN_FORWARD))
  for (const w of world.walls) {
    if (w.destroyed) continue
    if (circleVsAABB(muzzle, BULLET_RADIUS, w.aabb).hit) {
      return { x: owner.pos.x, y: owner.pos.y }
    }
  }
  return muzzle
}

export function ownerShellCount(world: World, ownerId: number): number {
  let n = 0
  for (const b of world.bullets) {
    if (b.alive && b.ownerId === ownerId) n++
  }
  return n
}

export function spawnBullet(
  world: World,
  ownerId: number,
  angle: number,
  type: BulletType,
  events: SimEvent[],
): boolean {
  const owner = world.tanks.find((t) => t.id === ownerId)
  if (!owner || !owner.alive) return false
  // Cap applies to every owner, not just the player: a cap each caller must opt into
  // is a cap the next spawner (AI) silently escapes. This was gated on owner.kind ===
  // 'player' when the player was the only shell-firer; that made it a no-op for AI owners.
  // The cap is now the owner's resolved weapon limit (configFor); it is SHELL_CAP for
  // every shipped kind today, so this is behaviour-identical (see config/roster.test.ts).
  if (ownerShellCount(world, ownerId) >= configFor(owner.kind).weapon.maxActiveProjectiles) {
    return false
  }
  const cfg = bulletConfig[type]
  const dir = fromAngle(angle)
  const pos = muzzlePoint(world, owner, dir)
  const bullet: Bullet = {
    id: world.nextId++,
    ownerId,
    type,
    pos,
    vel: vscale(dir, cfg.speed),
    bouncesLeft: cfg.bounces,
    alive: true,
  }
  world.bullets.push(bullet)
  events.push({ type: 'fire', ownerId, bulletType: type, pos: { x: pos.x, y: pos.y }, angle })
  return true
}

export function stepBullets(world: World, dt: number, events: SimEvent[]): void {
  const wallAABBs = world.walls.filter((w) => !w.destroyed).map((w) => w.aabb)
  // Where each shell started this tick, for the shell-vs-shell pass below.
  const from = new Map<number, Vec2>()
  for (const b of world.bullets) {
    if (!b.alive) continue
    from.set(b.id, { x: b.pos.x, y: b.pos.y })
    const speed = vlen(b.vel)
    const consumedBefore = bulletConfig[b.type].bounces - b.bouncesLeft
    const to = vadd(b.pos, vscale(b.vel, dt))
    const result = reflectSweep(b.pos, to, wallAABBs, b.bouncesLeft)
    for (let i = 0; i < result.hits.length; i++) {
      const p = result.hits[i].point
      events.push({ type: 'ricochet', ownerId: b.ownerId, pos: { x: p.x, y: p.y }, bounceIndex: consumedBefore + i })
    }
    b.pos = result.end
    b.vel = vscale(result.dir, speed)
    b.bouncesLeft = result.bouncesLeft
    if (result.expired) b.alive = false
    // A degenerate reflection (the hit landing exactly at t=1 leaves a
    // zero-length remainder, which vnorm maps to {0,0}) produced a motionless
    // but still-alive shell. Nothing else retires one, so it sat in the arena
    // forever holding a SHELL_CAP slot -- five of them locked its owner out of
    // firing for the rest of the game.
    if (!Number.isFinite(b.vel.x) || !Number.isFinite(b.vel.y) || vlen(b.vel) === 0) {
      b.alive = false
    }
  }
  resolveShellCollisions(world, from, events)
}

/** Closest approach of two points moving linearly over one tick, in [0,1]. */
function closestApproach(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): number {
  const px = a0.x - b0.x
  const py = a0.y - b0.y
  const vx = a1.x - a0.x - (b1.x - b0.x)
  const vy = a1.y - a0.y - (b1.y - b0.y)
  const vv = vx * vx + vy * vy
  // Parallel or both stationary relative to each other: the gap never changes.
  let t = vv === 0 ? 0 : -(px * vx + py * vy) / vv
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = px + vx * t
  const dy = py + vy * t
  return Math.hypot(dx, dy)
}

/**
 * Shells that meet destroy each other.
 *
 * SWEPT rather than a check on end positions. Be clear about why, because the
 * obvious justification is wrong: at NORMAL_SPEED (6) a shell covers 0.1 per
 * tick, so a closing pair covers 0.2 -- EXACTLY the bullet diameter -- which
 * means any pair that crosses also ends within a diameter. Tunnelling is
 * impossible at current speeds, and a naive end-position check would behave
 * identically. No test here distinguishes the two, and a mutation swapping the
 * swept test for the naive one SURVIVES.
 *
 * It is written swept anyway because the equivalence is a coincidence of one
 * constant: raise NORMAL_SPEED past 6 and shells begin passing through each
 * other silently, with nothing to catch it. This costs a few lines and removes
 * that trap.
 *
 * The path is treated as the straight segment from where the shell started to
 * where it ended. A shell that ricocheted mid-tick actually travelled a bent
 * path, so a collision very close to a wall can be missed or, less often,
 * reported a fraction early. Sub-tick exactness here is not worth the
 * complexity: the visible outcome is the same pair of shells cancelling.
 */
function resolveShellCollisions(world: World, from: Map<number, Vec2>, events: SimEvent[]): void {
  const live = world.bullets.filter((b) => b.alive && from.has(b.id))
  for (let i = 0; i < live.length; i++) {
    const a = live[i]
    if (!a.alive) continue
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j]
      if (!b.alive) continue
      const gap = closestApproach(from.get(a.id)!, a.pos, from.get(b.id)!, b.pos)
      if (gap > BULLET_RADIUS * 2) continue
      a.alive = false
      b.alive = false
      // Where they met, near enough: particles burst at exactly this point.
      events.push({
        type: 'explosion',
        pos: { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 },
      })
      break
    }
  }
}

export function resolveBulletHits(world: World, events: SimEvent[]): void {
  // Shells set off mines they run into. Checked BEFORE tanks, so a shell that
  // would reach a tank standing on a mine sets the mine off rather than merely
  // killing the tank -- the blast is the larger event and should not be lost.
  for (const b of world.bullets) {
    if (!b.alive) continue
    for (const m of world.mines) {
      if (m.detonated) continue
      if (!circleVsCircle(b.pos, BULLET_RADIUS, m.pos, MINE_TRIGGER_RADIUS).hit) continue
      if (!shellMayDetonate(world, m)) continue
      b.alive = false
      // The SHOOTER gets credit for whatever this blast destroys: detonating a mine
      // with a shell is a skill shot, whoever owns the mine.
      detonateMine(world, m, events, { source: 'shell', ownerId: b.ownerId })
      break
    }
  }
  world.mines = world.mines.filter((m) => !m.detonated)

  for (const b of world.bullets) {
    if (!b.alive) continue
    for (const t of world.tanks) {
      if (!t.alive) continue
      if (t.id === b.ownerId) {
        // Avoid self-destruct while the shell is still leaving the muzzle:
        // only vulnerable once the shell heads back toward its owner (e.g. after a ricochet).
        const toOwner = vsub(t.pos, b.pos)
        if (vdot(b.vel, toOwner) <= 0) continue
      }
      if (circleVsCircle(b.pos, BULLET_RADIUS, t.pos, TANK_RADIUS).hit) {
        // An invincible tank (dev playtest mode) is a wall to ordnance, not a ghost:
        // the shell still detonates on it -- letting it pass through would shield
        // nothing and read as a collision bug -- but no one dies. Event order matches
        // mines.ts for a mortal kill: tank-destroyed, then explosion.
        b.alive = false
        if (!t.invincible) {
          t.alive = false
          events.push({ type: 'tank-destroyed', tankId: t.id, kind: t.kind, by: { source: 'shell', ownerId: b.ownerId }, pos: { x: t.pos.x, y: t.pos.y } })
        }
        events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
        break
      }
    }
  }
  // Retire the dead, exactly as stepMines does. Skipping this was the sim's one
  // unbounded collection: shells were only ever flagged `alive = false`, never
  // removed, so cloneWorld deep-copied every corpse of the round 60x a second.
  // Measured at 100k ticks in a single round: 3,987 bullets, 3 alive, 10.8x
  // per-tick slowdown, and a 639 KB world snapshot.
  world.bullets = world.bullets.filter((b) => b.alive)
}
