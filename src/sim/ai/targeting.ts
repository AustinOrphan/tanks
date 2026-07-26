import type { Vec2, Wall, AABB, Bullet, Tank, Mine, BulletType } from '../types';
import { vsub, angleOf, vdot, vdist, vnorm, fromAngle, nextRng } from '../types';
import { raySegmentVsAABB, circleVsAABB, reflectSweep, driveVelocity } from '../collision';
import {
  AIM_EPS, TANK_RADIUS, TANK_SPEED, DT, THREAT_HORIZON, DANGER_CORRIDOR,
  VEC_EPS, WANDER_TICKS, AI_JITTER_TICKS, AI_MINE_FLEE_RADIUS, AI_HULL_CLEARANCE,
  AI_SHOT_LOOKAHEAD, ESCAPE_SAMPLES, bulletConfig,
} from '../constants';
import type { World } from '../world';

/**
 * Wall-only visibility test. Deliberately says NOTHING about tanks on the line -- see
 * shotHitsOwnSide for that. The two are separate because "can the shell physically reach
 * there" and "should we pull the trigger" are different questions: the bank-shot search
 * below needs the wall-only meaning, the fire gate needs both.
 */
export function lineOfSight(from: Vec2, to: Vec2, walls: Wall[]): boolean {
  for (const w of walls) {
    if (w.destroyed) continue;
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false;
  }
  return true;
}

/** Distance from `p` to the segment [a,b] (clamped, so endpoints count as the closest
 *  point when the projection falls outside the segment). */
function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/**
 * The polyline a shell of `type` fired from `from` along `angle` would actually trace,
 * bounces included, for AI_SHOT_LOOKAHEAD seconds of flight.
 *
 * Built with the SAME reflectSweep the sim moves bullets with, so the AI reasons about
 * the path the shell really takes rather than the straight line it starts on. Returns at
 * least two points (start and end).
 */
function shotPath(from: Vec2, angle: number, type: BulletType, walls: Wall[]): Vec2[] {
  const cfg = bulletConfig[type];
  const dir = fromAngle(angle);
  const range = cfg.speed * AI_SHOT_LOOKAHEAD;
  const to = { x: from.x + dir.x * range, y: from.y + dir.y * range };
  const boxes = walls.filter((w) => !w.destroyed).map((w) => w.aabb);
  const result = reflectSweep(from, to, boxes, cfg.bounces);
  return [from, ...result.hits.map((h) => h.point), result.end];
}

/**
 * True if firing from `tank` along `angle` would put a shell through a tank on its OWN
 * side — a teammate, or (after a bounce) the shooter itself.
 *
 * Both cases are real kills and neither was checked. resolveBulletHits kills any non-owner
 * tank a shell touches, teammates included; lineOfSight only tests walls, so every enemy
 * was free to shoot its own side, and Brown — which never moves — was a permanently parked
 * target for the other two. resolveBulletHits ALSO kills the owner once the shell heads
 * back at it, and with NORMAL_BOUNCES = 1 / RICOCHET_BOUNCES = 3 in a boxed arena that is
 * a routine outcome, not an exotic one.
 *
 * The whole ricochet polyline is checked, not just the opening leg: the opening leg alone
 * missed every kill that happened AFTER a bounce, which is most of them for Teal's
 * 3-bounce ricochets. The shooter is exempt on leg 0 only — the muzzle is inside its own
 * hull by construction, and a shell travelling away is harmless to its owner, exactly as
 * resolveBulletHits has it.
 *
 * Own-side tanks are checked where they WILL BE, not where they stand. Comparing a shell's
 * whole flight against a snapshot of the arena treats roaming teammates as if they were
 * parked: a mate 2.5 units clear of the muzzle line — five hull clearances — walks into the
 * shell a third of a second later and dies, and the shot was cleared as safe. A stationary
 * tank has zero drive velocity, so this reduces exactly to the old static test for Brown.
 */
export function shotHitsOwnSide(world: World, tank: Tank, angle: number, type: BulletType): boolean {
  const path = shotPath(tank.pos, angle, type, world.walls);
  const speed = bulletConfig[type].speed;
  let legStart = 0;
  for (let leg = 0; leg + 1 < path.length; leg++) {
    const a = path[leg];
    const b = path[leg + 1];
    const legTime = vdist(a, b) / speed;
    for (const t of world.tanks) {
      // The player is the target, not a friendly; a corpse blocks nothing.
      if (!t.alive || t.kind === 'player') continue;
      if (t.id === tank.id && leg === 0) continue; // outbound leg: harmless to its owner
      // Both tests, ORed: prediction ADDS the mates who walk in, it does not excuse the
      // ones standing on the line today. Trusting prediction alone made it worse, because
      // a roamer's heading is only stable for a fraction of the flight time -- extrapolating
      // it over the full 1.5s cleared shots at mates that never actually left the line.
      if (pointSegmentDistance(t.pos, a, b) < AI_HULL_CLEARANCE) return true;
      const vel = driveVelocity(t);
      if (minApproach(a, b, legTime, legStart, t.pos, vel) < AI_HULL_CLEARANCE) return true;
    }
    legStart += legTime;
  }
  return false;
}

/**
 * Closest distance between a shell crossing [a,b] during [legStart, legStart+legTime] and
 * a tank at `p` moving at constant `vel` from t=0.
 *
 * Both paths are linear in time, so their separation is linear too and the minimum is the
 * vertex of a quadratic — solved directly and clamped to the leg rather than sampled, so
 * a fast shell cannot step over a teammate between samples.
 */
function minApproach(a: Vec2, b: Vec2, legTime: number, legStart: number, p: Vec2, vel: Vec2): number {
  // A degenerate leg carries no time; compare positions at the instant it happens.
  if (legTime <= 0) {
    const at = { x: p.x + vel.x * legStart, y: p.y + vel.y * legStart };
    return vdist(a, at);
  }
  const shellVel = { x: (b.x - a.x) / legTime, y: (b.y - a.y) / legTime };
  // Separation at the start of the leg, and the rate it changes.
  const d0 = { x: a.x - (p.x + vel.x * legStart), y: a.y - (p.y + vel.y * legStart) };
  const w = { x: shellVel.x - vel.x, y: shellVel.y - vel.y };
  const w2 = w.x * w.x + w.y * w.y;
  let s = w2 < VEC_EPS ? 0 : -(d0.x * w.x + d0.y * w.y) / w2;
  s = s < 0 ? 0 : s > legTime ? legTime : s;
  return Math.hypot(d0.x + w.x * s, d0.y + w.y * s);
}

/**
 * True if dropping a mine at `tank.pos` right now would leave a live TEAMMATE inside the
 * resulting blast.
 *
 * detonateMine spares nobody but the owner, and only while the mine is still unarmed, so a
 * mine laid at a teammate's feet is a teammate kill on a 3-second fuse. Brown never moves,
 * which made it the single most common victim in the arena: Grey and Teal wandered past,
 * dropped a mine, walked far enough for it to arm, and it went off on a tank that had no
 * way to leave. Measured against AI_MINE_FLEE_RADIUS rather than the bare kill radius so
 * the teammate is not merely outside the blast but outside the zone it would have to run
 * from at all.
 */
export function friendlyInMineBlast(world: World, tank: Tank): boolean {
  for (const t of world.tanks) {
    if (!t.alive || t.id === tank.id || t.kind === 'player') continue;
    if (vdist(t.pos, tank.pos) <= AI_MINE_FLEE_RADIUS) return true;
  }
  return false;
}

export function aimLead(muzzle: Vec2, target: Vec2, targetVel: Vec2, bulletSpeed: number): number {
  const rel = vsub(target, muzzle);
  // Solve |rel + targetVel*t| = bulletSpeed*t  ->  a t^2 + b t + c = 0
  const a = targetVel.x * targetVel.x + targetVel.y * targetVel.y - bulletSpeed * bulletSpeed;
  const b = 2 * (rel.x * targetVel.x + rel.y * targetVel.y);
  const c = rel.x * rel.x + rel.y * rel.y;

  let t = -1;
  if (Math.abs(a) < AIM_EPS) {
    if (Math.abs(b) > AIM_EPS) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b + sq) / (2 * a);
      const t2 = (-b - sq) / (2 * a);
      if (t1 > AIM_EPS && t2 > AIM_EPS) t = Math.min(t1, t2);
      else if (t1 > AIM_EPS) t = t1;
      else if (t2 > AIM_EPS) t = t2;
    }
  }

  if (t <= AIM_EPS) return angleOf(rel); // no positive intercept: direct aim
  const intercept = { x: target.x + targetVel.x * t, y: target.y + targetVel.y * t };
  return angleOf(vsub(intercept, muzzle));
}

export function mirrorAcrossAABB(point: Vec2, box: AABB): Vec2[] {
  return [
    { x: 2 * box.minX - point.x, y: point.y }, // face 0: left  (x = minX, normal -x)
    { x: 2 * box.maxX - point.x, y: point.y }, // face 1: right (x = maxX, normal +x)
    { x: point.x, y: 2 * box.minY - point.y }, // face 2: bottom (y = minY, normal -y)
    { x: point.x, y: 2 * box.maxY - point.y }, // face 3: top   (y = maxY, normal +y)
  ];
}

// LOS that ignores one wall (the reflecting wall, since the bounce point sits on its surface).
function losIgnoring(from: Vec2, to: Vec2, walls: Wall[], ignore: Wall): boolean {
  for (const w of walls) {
    if (w === ignore || w.destroyed) continue;
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false;
  }
  return true;
}

const FACE_NORMALS: Vec2[] = [
  { x: -1, y: 0 }, // 0 left
  { x: 1, y: 0 },  // 1 right
  { x: 0, y: -1 }, // 2 bottom
  { x: 0, y: 1 },  // 3 top
];

/**
 * Finds a single-bounce bank-shot path from muzzle to target off any reflector wall.
 *
 * Searches each wall's four faces in order and returns the firing angle of the first
 * valid path (muzzle → bounce → target, where bounce lands exactly on the wall's surface
 * and both line-of-sight legs are clear). This returns the FIRST valid path in wall/face
 * iteration order, not the optimal or shortest path — deterministic given input, but
 * callers must not assume optimality.
 *
 * @param maxBounces — Presently used ONLY as a precondition: must be >= 1 to proceed.
 *   The search is single-bounce-only; multi-bounce is not implemented. Task 21+ must
 *   not assume this parameter enables ricochet-shell multi-bounce budgets — it will
 *   silently find only single-bounce paths regardless of maxBounces value.
 *
 * A candidate whose REFLECTED leg (bounce -> target) passes through the shooter's own
 * hull is rejected: resolveBulletHits (bullets.ts) makes a shell lethal to its owner the
 * instant its velocity points back at it, so such a path is a self-kill dressed up as a
 * firing solution. Both legs being wall-clear says nothing about this, which is exactly
 * how Teal used to shoot itself.
 *
 * @returns Firing angle (from muzzle toward bounce point), or null if no path exists.
 */
export function bankShot(muzzle: Vec2, target: Vec2, walls: Wall[], maxBounces: number): number | null {
  if (maxBounces < 1) return null;
  for (const w of walls) {
    if (w.destroyed) continue;
    const mirrors = mirrorAcrossAABB(target, w.aabb);
    for (let face = 0; face < FACE_NORMALS.length; face++) {
      const mirror = mirrors[face];
      const hit = raySegmentVsAABB(muzzle, mirror, w.aabb);
      if (!hit) continue;
      // The ray must enter through the intended reflecting face (normals are exact ±1/0).
      // raySegmentVsAABB guarantees exact normals: each component is ±1 or 0, never epsilon.
      // A bounce landing at a wall corner (within 1e-7) is modelled here as a single-face
      // reflection; reflectSweep retroreflects both axes there, but the difference is negligible.
      const n = FACE_NORMALS[face];
      if (hit.normal.x !== n.x || hit.normal.y !== n.y) continue;
      const bounce = hit.point;
      // Clear line to the wall, and clear line from the bounce point to the real target.
      if (!losIgnoring(muzzle, bounce, walls, w)) continue;
      if (!losIgnoring(bounce, target, walls, w)) continue;
      // ...and the returning leg must MISS the shooter. A shell coming back at its owner
      // is lethal to it (resolveBulletHits), so a bounce that sends the shell back up its
      // own firing lane -- e.g. reflecting off a wall the muzzle is directly above -- is a
      // suicide, not a bank shot. Measured against the same hull the shell would collide
      // with: TANK_RADIUS + BULLET_RADIUS, widened by AI_HULL_CLEARANCE's margin so a
      // near-graze at the edge of floating-point agreement is refused too.
      if (pointSegmentDistance(muzzle, bounce, target) < AI_HULL_CLEARANCE) continue;
      return angleOf(vsub(bounce, muzzle));
    }
  }
  return null;
}

/**
 * Identifies bullets approaching the tank within a lookahead horizon and danger corridor.
 *
 * OWN shells count. resolveBulletHits (bullets.ts) makes a shell lethal to its owner the
 * moment `vdot(b.vel, ownerPos - b.pos) > 0` — i.e. as soon as it heads back — and with
 * NORMAL_BOUNCES = 1 / RICOCHET_BOUNCES = 3 every AI shell can come back. Skipping own
 * bullets outright therefore meant a tank stood still while its own ricochet killed it.
 * The predicate below is the SAME one resolveBulletHits uses, deliberately: anything
 * looser makes a tank dodge the shell it just fired (at the muzzle rel is the zero vector,
 * so the dot is exactly 0, which `<= 0` correctly treats as harmless).
 *
 * LIMITATION: models bullets as straight lines and ignores walls. A shell that will BANK
 * off a wall into the tank is not flagged (same limitation as the bank-shot targeting
 * itself). Conversely, a bullet that a wall will stop is still flagged.
 */
export function incomingThreats(world: World, tank: Tank): Bullet[] {
  const out: Bullet[] = [];
  for (const b of world.bullets) {
    if (!b.alive) continue;
    const speed = Math.hypot(b.vel.x, b.vel.y);
    if (speed < VEC_EPS) continue;
    const dir = vnorm(b.vel);
    const rel = { x: tank.pos.x - b.pos.x, y: tank.pos.y - b.pos.y };
    // Own shells are only dangerous once they are heading back at the muzzle.
    if (b.ownerId === tank.id && vdot(b.vel, rel) <= 0) continue;
    const along = vdot(rel, dir);
    if (along < 0) continue;                     // bullet already past / moving away
    if (along > speed * THREAT_HORIZON) continue; // too far ahead in time
    const perp = { x: rel.x - dir.x * along, y: rel.y - dir.y * along };
    if (Math.hypot(perp.x, perp.y) <= DANGER_CORRIDOR) out.push(b);
  }
  return out;
}

/**
 * Returns a deterministic unit wander heading for `tank`, held steady for
 * `WANDER_TICKS` ticks (~0.5s at 60Hz) before repicking. Seeded from
 * `world.seed + tank.id * 1000 + bucket` so different tanks and different
 * time buckets diverge, while repeated calls within the same bucket for the
 * same tank/world are reproducible (no Math.random, no Date.now).
 *
 * This is a pure hash of `(world.seed, tank.id, tick bucket)` — deliberately
 * NOT threading PRNG state from one call to the next. That makes it replay-safe
 * (any caller, any order, any tick, gets the same answer for the same inputs)
 * and means it cannot desync any other RNG consumer in the sim.
 */
export function wanderMove(world: World, tank: Tank): Vec2 {
  const bucket = Math.floor(world.tick / WANDER_TICKS);
  const rng = nextRng(world.seed + tank.id * 1000 + bucket);
  return fromAngle(rng.value * Math.PI * 2);
}

/**
 * Returns a small, deterministic aiming error in radians, bounded to ±`spread`, for
 * `tank` to add to its computed firing angle (see brown.ts/grey.ts/teal.ts). Re-rolled
 * every `AI_JITTER_TICKS` ticks (~0.33s at 60Hz) rather than held for the tank's whole
 * lifetime, so a tank's shots scatter around the target instead of consistently missing
 * to a fixed side -- and rather than threaded PRNG state, so this stays replay-safe (any
 * caller, any order, any tick, gets the same answer for the same inputs), same rationale
 * as wanderMove.
 *
 * Uses a DIFFERENT multiplier on tank.id (`* 7919`, a prime, vs wanderMove's `* 1000`) so
 * a tank's wander heading and its aim error are never correlated: a tank that always
 * missed in the direction it happened to be walking would look like a bug, not a feature.
 *
 * NO Math.random() -- this is a pure hash of (world.seed, tank.id, tick bucket), exactly
 * like wanderMove, per sim/'s determinism and purity requirements.
 */
export function aimJitter(world: World, tank: Tank, spread: number): number {
  const bucket = Math.floor(world.tick / AI_JITTER_TICKS);
  const rng = nextRng(world.seed + tank.id * 7919 + bucket);
  return (rng.value * 2 - 1) * spread;
}

/**
 * True if stepping one tick along `dir` would put the tank's hull inside a wall.
 *
 * moveTank resolves such an overlap by pushing the tank straight back out, so a dodge
 * aimed into a wall nets EXACTLY zero displacement: the tank stays pinned in the danger
 * corridor and dies there, worse off than if it had not dodged at all. Probing one
 * TANK_SPEED*DT step is the same displacement moveTank is about to apply, so this asks
 * precisely the question that matters.
 */
function wallBlocksStep(world: World, tank: Tank, dir: Vec2): boolean {
  const probe = {
    x: tank.pos.x + dir.x * TANK_SPEED * DT,
    y: tank.pos.y + dir.y * TANK_SPEED * DT,
  };
  for (const w of world.walls) {
    if (w.destroyed) continue;
    if (circleVsAABB(probe, TANK_RADIUS, w.aabb).hit) return true;
  }
  return false;
}

/**
 * The nearest undetonated mine within AI_MINE_FLEE_RADIUS, or null.
 *
 * Nearest, not first-in-array: mine insertion order is arbitrary, and fleeing a far mine
 * that happens to be earlier in the list can drive the tank straight into a nearer one.
 *
 * UNARMED mines count. `armed` gates only the PROXIMITY trigger; stepMines detonates on
 * MINE_TIMER expiry regardless, and that path "spares nobody, including an owner still
 * standing on it". A tank that dropped a mine and then loitered inside MINE_PROXIMITY_
 * RADIUS never armed it and never fled it, and the 3-second fuse killed it where it stood.
 */
function dangerousMines(world: World, tank: Tank): Mine[] {
  const near: Mine[] = [];
  for (const m of world.mines) {
    if (m.detonated) continue;
    // `<=`, and measured against the radius detonateMine actually KILLS at plus an escape
    // margin -- see AI_MINE_FLEE_RADIUS in constants.ts.
    if (vdist(m.pos, tank.pos) <= AI_MINE_FLEE_RADIUS) near.push(m);
  }
  return near;
}

/**
 * The direction that best escapes EVERY mine in `mines` at once.
 *
 * Scored as the worst-case outward component: for a candidate direction, the smallest
 * dot(candidate, unit vector away from mine) over all the mines. Maximising that worst
 * case means the chosen heading never closes on any of them if an escape exists at all.
 *
 * Fleeing only the NEAREST mine is what this replaces, and it deadlocked: MINE_CAP is 2,
 * the midpoint of two mines 2.8 apart sits inside both kill radii, and running from one
 * put the tank on the other, which then became the nearest. Measured over 30 seeded
 * games, 24 of 26 own-mine deaths had both mines in flee range, the victim walking 5.91
 * units of path for 1.29 units of net displacement before the fuse caught it.
 *
 * Directions are sampled on a fixed wheel rather than solved analytically: the wheel is
 * deterministic, cannot divide by a near-zero resultant when repulsions cancel, and
 * includes the exact axis directions, so the single-mine case still yields straight away.
 */
function bestEscapeDirection(world: World, tank: Tank, mines: Mine[]): Vec2 | null {
  const away: Vec2[] = [];
  for (const m of mines) {
    const d = vsub(tank.pos, m.pos);
    // Standing exactly on a mine gives no direction to prefer, so it constrains nothing.
    if (Math.hypot(d.x, d.y) < VEC_EPS) continue;
    away.push(vnorm(d));
  }

  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  let bestBlocked: Vec2 | null = null;
  let bestBlockedScore = -Infinity;
  for (let i = 0; i < ESCAPE_SAMPLES; i++) {
    const a = (i * 2 * Math.PI) / ESCAPE_SAMPLES;
    // Snapped so the axis directions are exact rather than 1e-16 off, which would make
    // "flees straight away from a single mine" fail a 6-decimal comparison.
    const cand = { x: Math.round(Math.cos(a) * 1e12) / 1e12, y: Math.round(Math.sin(a) * 1e12) / 1e12 };
    let score = Infinity;
    for (const u of away) {
      const dot = cand.x * u.x + cand.y * u.y;
      if (dot < score) score = dot;
    }
    if (score === Infinity) score = 0;
    if (wallBlocksStep(world, tank, cand)) {
      if (score > bestBlockedScore) { bestBlockedScore = score; bestBlocked = cand; }
      continue;
    }
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  // Every heading walks into a wall: still move, taking the least-bad one, because a tank
  // pinned in the blast is worse off than one sliding along the wall out of it.
  return best ?? bestBlocked;
}

/**
 * Returns a unit dodge direction away from the nearest incoming threat, or null.
 *
 * Prioritizes dodging incoming bullets; if none, flees the nearest nearby armed mine.
 * The bullet dodge is the perpendicular on the side the tank already sits, so it dodges
 * outward rather than across the threat -- but that preference yields to two hard
 * constraints, because a dodge that kills the tank is worse than no dodge:
 *   1. it must not walk into a wall (moveTank would cancel the move entirely), and
 *   2. it must not step toward an armed mine that is already in flee range. The two
 *      perpendiculars are exact opposites, so at most one of them can point at the mine
 *      and this never rejects both on mine grounds.
 * If both sides fail every constraint the tank still dodges (some movement beats none),
 * preferring a side that is at least not wall-pinned.
 */
export function dangerAvoidMove(world: World, tank: Tank): Vec2 | null {
  const mines = dangerousMines(world, tank);
  const threats = incomingThreats(world, tank);

  if (threats.length > 0) {
    let nearest = threats[0];
    let best = vdist(nearest.pos, tank.pos);
    for (const b of threats) {
      const d = vdist(b.pos, tank.pos);
      if (d < best) { best = d; nearest = b; }
    }
    const dir = vnorm(nearest.vel);
    const perpA = { x: -dir.y, y: dir.x };
    const perpB = { x: dir.y, y: -dir.x };
    // pick the perpendicular on the side the tank already sits, so it dodges outward
    const rel = { x: tank.pos.x - nearest.pos.x, y: tank.pos.y - nearest.pos.y };
    const preferred = vdot(rel, perpA) >= 0 ? perpA : perpB;
    const other = preferred === perpA ? perpB : perpA;

    // Vetted against EVERY mine in flee range, not just the nearest: a dodge cleared by
    // the nearest mine could still step onto the second one.
    for (const cand of [preferred, other]) {
      if (wallBlocksStep(world, tank, cand)) continue;
      if (mines.some((m) => vdot(cand, vsub(m.pos, tank.pos)) > 0)) continue;
      return cand;
    }
    // Both sides compromised: a wall-free dodge still moves the tank out of the corridor,
    // whereas a wall-pinned one moves it nowhere at all, so that is the better tie-break.
    for (const cand of [preferred, other]) {
      if (!wallBlocksStep(world, tank, cand)) return cand;
    }
    return preferred;
  }

  if (mines.length > 0) {
    // Standing exactly on the only mine there is: any direction is equally away, so pick
    // one deterministically rather than returning the zero vector vnorm would give.
    return bestEscapeDirection(world, tank, mines) ?? { x: 1, y: 0 };
  }
  return null;
}
