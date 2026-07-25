import type { Bullet, BulletType, Vec2 } from './types'
import { fromAngle, vscale, vadd, vlen } from './types'
import { reflectSweep } from './collision'
import type { World } from './world'
import type { SimEvent } from './events'
import { bulletConfig, PLAYER_SHELL_CAP } from './constants'

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
  if (!owner) return false
  if (owner.kind === 'player' && ownerShellCount(world, ownerId) >= PLAYER_SHELL_CAP) {
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
    const to = vadd(b.pos, vscale(b.vel, dt))
    const result = reflectSweep(b.pos, to, wallAABBs, b.bouncesLeft)
    for (let i = 0; i < result.hits.length; i++) {
      const p = result.hits[i].point
      events.push({ type: 'ricochet', pos: { x: p.x, y: p.y }, bounceIndex: i })
    }
    b.pos = result.end
    b.vel = vscale(result.dir, speed)
    b.bouncesLeft = result.bouncesLeft
    if (result.expired) b.alive = false
  }
}
