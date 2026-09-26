import type { Tank, Bullet, BulletType, Vec2 } from './types'
import { fromAngle, vscale, vadd, vlen, vsub, vdot, isDamageImmune } from './types'
import { circleVsAABB, reflectSweep, circleVsCircle } from './collision'
import { detonateMine, shellMayDetonate } from './mines'
import type { World } from './world'
import type { SimEvent } from './events'
import { bulletConfig, BULLET_RADIUS, TANK_RADIUS, MINE_TRIGGER_RADIUS, SHELL_SPAWN_FORWARD, SHELL_MUZZLE_FORWARD } from './constants'
import { configFor } from './config'
import { detHypot } from './math/hypot'

/**
 * Where the shell is born: centred `SHELL_SPAWN_FORWARD` ahead of the tank, the muzzle
 * plane less the shell's drawn nose reach, so its visible nose starts at the opening rather
 * than past it (issue #237), unless that position is inside a wall or (when
 * World.rules.muzzleClearsTanks is on) inside a live neighbour's hit circle.
 *
 * The clearance test follows the shell, not the plane. It asks whether the circle the
 * shell will actually occupy at birth overlaps solid geometry -- centre
 * `SHELL_SPAWN_FORWARD`, radius `BULLET_RADIUS`. Testing at the plane instead would check
 * a region the shell does not occupy: it would refuse shots that fit and, worse, would
 * miss a wall sitting where the shell is actually born. An embedded projectile is the
 * failure that matters here.
 *
 * SHELL_SPAWN_FORWARD still reaches past the tank's own collision radius, so a tank
 * nose-to-wall has its shell inside that wall. Spawning there would put a live shell
 * in solid geometry -- the state stepBullets already has to retire on sight -- and
 * firing while touching a wall would silently burn a shell-cap slot. So the muzzle is
 * used only when it is clear, and the tank's centre is the fallback.
 *
 * The tank check is the same fallback shape, gated on World.rules.muzzleClearsTanks (see
 * its doc comment for the ruling): a spawn circle overlapping a live non-owner tank's
 * hit circle -- TANK_RADIUS + BULLET_RADIUS, resolveBulletHits' own threshold --
 * falls back to owner.pos exactly as the wall case does.
 *
 * Both points come back together because the fallback has to move them together. When the
 * shell retreats to the tank centre, a flash left out on the barrel would advertise a gun
 * that produced nothing there this tick; returning both lets the branch say which case it
 * took instead of leaving the caller to infer it.
 */
interface MuzzleSolution {
  /** Shell centre at birth: SHELL_SPAWN_FORWARD ahead, or the tank centre on retreat. */
  spawn: Vec2
  /** Where the gun visibly went off: the barrel opening, or the tank centre on retreat. */
  flash: Vec2
}
function muzzlePoint(world: World, owner: Tank, dir: Vec2): MuzzleSolution {
  const spawn = vadd(owner.pos, vscale(dir, SHELL_SPAWN_FORWARD))
  const retreat = (): MuzzleSolution => ({
    spawn: { x: owner.pos.x, y: owner.pos.y },
    flash: { x: owner.pos.x, y: owner.pos.y },
  })
  for (const w of world.walls) {
    if (w.destroyed) continue
    if (circleVsAABB(spawn, BULLET_RADIUS, w.aabb).hit) return retreat()
  }
  if (world.rules.muzzleClearsTanks) {
    for (const t of world.tanks) {
      if (t.id === owner.id || !t.alive) continue
      if (circleVsCircle(spawn, BULLET_RADIUS, t.pos, TANK_RADIUS).hit) return retreat()
    }
  }
  return { spawn, flash: vadd(owner.pos, vscale(dir, SHELL_MUZZLE_FORWARD)) }
}

/**
 * Is this owner already holding every shell its weapon allows (issue #356)?
 *
 * Extracted so the caller can tell a capacity refusal apart from every other reason
 * `spawnBullet` returns false -- a dead owner, and nothing else today -- without restating
 * the rule. The callers use it to decide whether a refused shot costs the fire cooldown:
 * being at your cap is the shooter's own doing, so it does; being dead is not, so it does
 * not. One definition, read in two places, rather than a second copy that can drift from the
 * gate it is supposed to mirror.
 */
export function shellCapReached(world: World, ownerId: number): boolean {
  const owner = world.tanks.find((t) => t.id === ownerId)
  if (!owner) return false
  // `owner.shellCap` when a session stamped one (issue #358), else the roster's.
  return ownerShellCount(world, ownerId) >= (owner.shellCap ?? configFor(owner.kind).weapon.maxActiveProjectiles)
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
  // is a cap the next spawner (AI) silently escapes. The limit itself is per owner
  // (see shellCapReached), not SHELL_CAP: olive and yellow carry 1.
  if (shellCapReached(world, ownerId)) {
    // Refused, and said so (issue #356). Emitted for every owner, not just the player, for
    // the same reason the cap itself applies to every owner -- a signal each consumer opts
    // into is one the next consumer silently misses. Filtering to the local player is the
    // consumer's job (`ownerId`), exactly as it is for `fire`.
    events.push({ type: 'fire-blocked', ownerId, reason: 'shell-cap' })
    return false
  }
  const cfg = bulletConfig[type]
  const dir = fromAngle(angle)
  /**
   * The flash goes on the barrel opening, not on the shell's centre (issue #237).
   *
   * `spawn` is the shell's centre, behind the plane by the shell's drawn nose reach;
   * emitting that as the fire event's position would drag the muzzle flash inward with the
   * shell and make the gun look like it discharges from inside itself. Consumers of this
   * event treat the event's `pos` as "where the gun went off" -- particles.ts bursts on it
   * -- so it carries `flash`, which muzzlePoint has already retreated to the tank centre in
   * the case where the shell could not be born at the barrel at all.
   */
  const { spawn: pos, flash } = muzzlePoint(world, owner, dir)
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
  events.push({ type: 'fire', ownerId, bulletType: type, pos: { x: flash.x, y: flash.y }, angle })
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
    // zero-length remainder, which vnorm maps to {0,0}) produces a motionless
    // but still-alive shell. Nothing else retires one, so it would sit in the
    // arena forever holding a shell-cap slot -- a full cap of them locks its
    // owner out of firing for the rest of the game.
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
  return detHypot(dx, dy)
}

/**
 * Shells that meet destroy each other.
 *
 * Swept rather than a check on end positions. Between two normal shells the two
 * checks agree: at NORMAL_SPEED (6) a shell covers 0.1 per tick, so a closing pair
 * covers 0.2 -- exactly the bullet diameter -- and any pair that crosses also ends
 * within a diameter. A fast shell (FAST_SPEED 12, olive's rocket) closing head-on
 * on any other shell covers more than a diameter per tick, so without the sweep the
 * two could pass through each other. bullets.test.ts's shell-meets-shell cases all
 * use normal shells, so none distinguishes the two checks, and a mutation swapping
 * the swept test for the naive one survives.
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
  // Shells set off mines they run into. Checked before tanks, so a shell that
  // would reach a tank standing on a mine sets the mine off rather than merely
  // killing the tank -- the blast is the larger event and should not be lost.
  for (const b of world.bullets) {
    if (!b.alive) continue
    for (const m of world.mines) {
      if (m.detonated) continue
      if (!circleVsCircle(b.pos, BULLET_RADIUS, m.pos, MINE_TRIGGER_RADIUS).hit) continue
      if (!shellMayDetonate(world, m)) continue
      b.alive = false
      // Immediate, by owner direction (PR #311): shooting a mine is deliberately
      // setting it off -- no reaction window. The shooter gets credit for whatever
      // the blast destroys, whoever owns the mine: a skill shot (see Blast.credit).
      detonateMine(world, m, events, { source: 'shell', ownerId: b.ownerId })
      break
    }
  }
  world.mines = world.mines.filter((m) => !m.detonated)

  // Snapshotted here, after the mine loop above: a tank that loop just killed (a
  // shell detonating the mine it stood on) is already gone from it, so it keeps
  // ghosting either way -- only a tank alive at the start of the tank-hit pass below
  // can be "killed earlier in the same pass". See WorldRules.corpseBlocksShells.
  const aliveAtPassStart = world.rules.corpseBlocksShells
    ? new Set(world.tanks.filter((t) => t.alive).map((t) => t.id))
    : null

  for (const b of world.bullets) {
    if (!b.alive) continue
    for (const t of world.tanks) {
      if (!t.alive) {
        // WALL variant: a corpse that was alive when this pass started still stops a
        // later bullet -- consumed, one explosion, no re-kill and no second
        // 'tank-destroyed'. Off (or a corpse from an earlier stage), it ghosts as always.
        // Deliberately no ownerId exemption here, unlike the live branch below: the
        // live guard exists so a shell leaving the muzzle cannot kill its own firer,
        // but a wreck is a wall, and a wall stops your own ricochet too.
        if (aliveAtPassStart?.has(t.id) && circleVsCircle(b.pos, BULLET_RADIUS, t.pos, TANK_RADIUS).hit) {
          b.alive = false
          events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
          break
        }
        continue
      }
      if (t.id === b.ownerId) {
        // Avoid self-destruct while the shell is still leaving the muzzle:
        // only vulnerable once the shell heads back toward its owner (e.g. after a ricochet).
        const toOwner = vsub(t.pos, b.pos)
        if (vdot(b.vel, toOwner) <= 0) continue
      }
      if (circleVsCircle(b.pos, BULLET_RADIUS, t.pos, TANK_RADIUS).hit) {
        // A damage-immune tank (dev invincible, or coop's post-respawn shield -- see
        // isDamageImmune, types.ts) is a wall to ordnance, not a ghost: the shell
        // still detonates on it -- letting it pass through would shield nothing and
        // read as a collision bug -- but no one dies. Event order matches mines.ts
        // for a mortal kill: tank-destroyed, then explosion.
        //
        // Friendly fire (teams mode -- team is a three-place concept, this is place
        // 1 of 3): resolved via the owner tank's team, not a new Bullet field --
        // mirrors how shell tint already resolves owner identity at hit/render time
        // (render/entities.ts) rather than widening the struct.
        // `!== undefined` on both sides makes this self-disabling outside 'teams' by
        // construction: loadArena only ever stamps `team` when mode === 'teams'.
        const ownerTeam = world.tanks.find((o) => o.id === b.ownerId)?.team
        const isFriendly = t.team !== undefined && ownerTeam !== undefined && t.team === ownerTeam && !world.rules.friendlyFire
        b.alive = false
        if (!isDamageImmune(t, world.tick) && !isFriendly) {
          t.alive = false
          events.push({ type: 'tank-destroyed', tankId: t.id, kind: t.kind, by: { source: 'shell', ownerId: b.ownerId }, pos: { x: t.pos.x, y: t.pos.y } })
        }
        events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
        break
      }
    }
  }
  // Retire the dead, exactly as stepMines does. Without this, shells flagged
  // `alive = false` are never removed and cloneWorld deep-copies every corpse of
  // the round 60x a second (a 10.8x per-tick slowdown at 100k ticks in one round).
  world.bullets = world.bullets.filter((b) => b.alive)
}
