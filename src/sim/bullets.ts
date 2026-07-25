import type { Bullet, BulletType, Vec2 } from './types'
import { fromAngle, vscale, vadd, vlen, vsub, vdot } from './types'
import { reflectSweep, circleVsCircle } from './collision'
import type { World } from './world'
import type { SimEvent } from './events'
import { bulletConfig, SHELL_CAP, BULLET_RADIUS, TANK_RADIUS } from './constants'

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
  if (ownerShellCount(world, ownerId) >= SHELL_CAP) {
    return false
  }
  const cfg = bulletConfig[type]
  const pos: Vec2 = { x: owner.pos.x, y: owner.pos.y }
  const bullet: Bullet = {
    id: world.nextId++,
    ownerId,
    type,
    pos,
    vel: vscale(fromAngle(angle), cfg.speed),
    bouncesLeft: cfg.bounces,
    alive: true,
  }
  world.bullets.push(bullet)
  events.push({ type: 'fire', ownerId, bulletType: type, pos: { x: pos.x, y: pos.y }, angle })
  return true
}

export function stepBullets(world: World, dt: number, events: SimEvent[]): void {
  const wallAABBs = world.walls.filter((w) => !w.destroyed).map((w) => w.aabb)
  for (const b of world.bullets) {
    if (!b.alive) continue
    const speed = vlen(b.vel)
    const consumedBefore = bulletConfig[b.type].bounces - b.bouncesLeft
    const to = vadd(b.pos, vscale(b.vel, dt))
    const result = reflectSweep(b.pos, to, wallAABBs, b.bouncesLeft)
    for (let i = 0; i < result.hits.length; i++) {
      const p = result.hits[i].point
      events.push({ type: 'ricochet', pos: { x: p.x, y: p.y }, bounceIndex: consumedBefore + i })
    }
    b.pos = result.end
    b.vel = vscale(result.dir, speed)
    b.bouncesLeft = result.bouncesLeft
    if (result.expired) b.alive = false
  }
}

export function resolveBulletHits(world: World, events: SimEvent[]): void {
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
        t.alive = false
        b.alive = false
        events.push({ type: 'tank-destroyed', tankId: t.id, kind: t.kind, pos: { x: t.pos.x, y: t.pos.y } })
        events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
        break
      }
    }
  }
}
