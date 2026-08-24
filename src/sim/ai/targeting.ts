import type { Vec2, Wall, AABB, Bullet, Tank, Mine, BulletType } from '../types';
import { vsub, angleOf, vdot, vdist, vlen, vnorm, fromAngle, nextRng } from '../types';
import { raySegmentVsAABB, circleVsAABB, reflectSweep, driveVelocity } from '../collision';
import { configFor, type ResolvedTankConfig } from '../config';
import {
  AIM_EPS, AI_AIM_SPREAD, AI_HAZARD_SPREAD, TANK_RADIUS, DT, THREAT_HORIZON, DANGER_CORRIDOR, SEEK_APPROACH_BIAS,
  VEC_EPS, WANDER_TICKS, AI_JITTER_TICKS, AI_MINE_FLEE_RADIUS, AI_HULL_CLEARANCE,
  AI_SHOT_LOOKAHEAD, ESCAPE_SAMPLES, AI_MINE_TACTICAL_RADIUS, bulletConfig, SWEEP_EPS,
} from '../constants';
import type { World } from '../world';
import { detHypot } from '../math/hypot';
import { detSin, detCos } from '../math/trig';

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
  return detHypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
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
  return detHypot(d0.x + w.x * s, d0.y + w.y * s);
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
 *
 * `fleeRadius` defaults to the exact constant -- unperturbed, today's behaviour -- so every
 * existing caller is unaffected. `index.ts`'s `stepAi` (the only caller) passes a PERCEIVED
 * radius instead (directive B: no oracle knowledge of the blast's true reach), the same
 * `estimationError` house recipe grey.ts/teal.ts use for their own dodge/flee gates.
 */
export function friendlyInMineBlast(world: World, tank: Tank, fleeRadius = AI_MINE_FLEE_RADIUS): boolean {
  for (const t of world.tanks) {
    if (!t.alive || t.id === tank.id || t.kind === 'player') continue;
    if (vdist(t.pos, tank.pos) <= fleeRadius) return true;
  }
  return false;
}

/**
 * True if laying a mine at `tank.pos` right now would actually threaten the player.
 *
 * Grey and Teal previously dropped one whenever the cooldown was ready and they were under
 * MINE_CAP — an availability test, not a tactical one. A roamer crossing an empty half of
 * the arena littered live ordnance behind itself for no gain, then had to spend its time
 * dodging it; own mines were the single largest cause of AI deaths measured.
 *
 * Being a plain radius around the drop point, this still permits a burst: while the player
 * stays close a tank may lay up to MINE_CAP mines back to back, which is the chokepoint
 * denial worth keeping. It only refuses the drops that could never have mattered.
 *
 * `tacticalRadius` defaults to the exact constant -- today's behaviour, unperturbed -- so
 * every existing caller is unaffected. grey.ts/teal.ts pass a PERCEIVED radius instead
 * (directive B): this is the OFFENSE side of the same estimation error that gates their
 * own dodge/flee decisions, computed once per tick via `estimationError` and reused here.
 */
export function mineThreatensPlayer(world: World, tank: Tank, tacticalRadius = AI_MINE_TACTICAL_RADIUS): boolean {
  for (const t of world.tanks) {
    if (t.kind !== 'player' || !t.alive) continue;
    if (vdist(t.pos, tank.pos) <= tacticalRadius) return true;
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

/**
 * True if a segment leaving `start` toward `target` is travelling INTO `box`, as opposed
 * to grazing one of its faces on the way past. Mirrors collision.ts's private
 * `headingInto` (same rationale, same probe distance): `raySegmentVsAABB` reports a
 * boundary TOUCH -- tmin==tmax exactly at one of THIS segment's own endpoints -- as a hit
 * even when the segment never enters the box's interior, and the normal it returns in
 * that case says nothing about direction. Deliberately duplicated rather than imported:
 * `collision.ts` doesn't export it, and `losIgnoring` below is the only caller here.
 */
function headingIntoBox(start: Vec2, target: Vec2, box: AABB): boolean {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const len = detHypot(dx, dy);
  if (len === 0) return false;
  const step = SWEEP_EPS / len;
  const px = start.x + dx * step;
  const py = start.y + dy * step;
  return px > box.minX && px < box.maxX && py > box.minY && py < box.maxY;
}

/**
 * LOS that ignores one wall (the reflecting wall, since the bounce point sits on its
 * surface).
 *
 * A subdivided reflector manufactures interior seams between adjacent cells, and a bank
 * shot's bounce point can legitimately land exactly on one of those seam coordinates (see
 * `mirrorAcrossAABB`'s reflection math -- nothing forces it away from a cell boundary).
 * When that happens, the muzzle->bounce or bounce->target leg's own ENDPOINT sits exactly
 * on a NEIGHBOURING wall's corner, and `raySegmentVsAABB` reports that boundary touch as
 * a hit (`tmin == tmax` at t~0 or t~1) even though the segment never enters the
 * neighbour's interior -- the same degenerate-touch class CLAUDE.md documents for
 * `reflectSweep`'s seam problem, manifesting here instead of there. A hit at either
 * extreme of the segment's own parameter range is disambiguated by probing a hair in
 * from the touched end: still inside the box means a real penetration (block it); not
 * means the segment only grazed a corner on its way past (let it through). A hit
 * anywhere in the MIDDLE of the range (an actual crossing) is never a graze and is
 * always a real block, unaffected by this check.
 *
 * "At either extreme" is measured in WORLD UNITS, not in the ray parameter. `hit.t` is a
 * fraction of this segment's length, while `headingIntoBox` probes a fixed `SWEEP_EPS` of
 * world distance; comparing the two directly means that on a segment longer than 1 unit
 * the graze branch fires for hits up to `SWEEP_EPS * len` from the endpoint, while the
 * probe only ever looks `SWEEP_EPS` ahead. Everything in between is a REAL crossing whose
 * probe still lands short of the box, so it was waved through as a graze -- a shot
 * reported clear straight through a solid wall. Multiplying by `len` puts both sides in
 * the same unit, which is what makes the two branches mean what the paragraph above says.
 */
function losIgnoring(from: Vec2, to: Vec2, walls: Wall[], ignore: Wall): boolean {
  const len = detHypot(to.x - from.x, to.y - from.y);
  for (const w of walls) {
    if (w === ignore || w.destroyed) continue;
    const hit = raySegmentVsAABB(from, to, w.aabb);
    if (hit === null) continue;
    if (hit.t * len <= SWEEP_EPS && !headingIntoBox(from, to, w.aabb)) continue;
    if ((1 - hit.t) * len <= SWEEP_EPS && !headingIntoBox(to, from, w.aabb)) continue;
    return false;
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
 * Searches every wall's four faces and returns the firing angle of the SHORTEST valid
 * path (muzzle → bounce → target, where bounce lands exactly on the wall's surface and
 * both line-of-sight legs are clear), breaking exact ties by the smaller firing angle.
 * This makes the choice a property of the arena's geometry: however a reflector happens
 * to be sliced into wall cells in the level data, the shortest path off its outer surface
 * is the same path.
 *
 * A candidate reflecting off a face buried inside a neighbouring wall (an interior seam
 * manufactured by how the level data sliced a reflector into cells) does not get its own
 * rejection here. An earlier version of this function carried an explicit `faceIsBuried`
 * guard and it was deleted, on this evidence and with this limit:
 *
 *   - On probes where BOTH endpoints lie strictly outside every wall -- the only states
 *     the sim actually produces, since `resolveWalls` keeps every hull centre out of the
 *     wall mass -- removing the guard changed the answer on **0 of 4,195,692** (muzzle,
 *     target) pairs: 12 synthetic shapes (adjacent pair, three-in-a-row, column, L, T,
 *     plus-cross, fully-surrounded centre, diagonal staircase, overlapping pair,
 *     partial-overlap L, partial face cover, offset runs) plus all 4 shipped arenas'
 *     real merged geometry, compared per-config with and without the guard.
 *   - Off that domain it is NOT a no-op. With an endpoint lying exactly ON a wall
 *     surface, **81 of 1,966,116** probes differ, all on arena-03, all with the TARGET on
 *     a surface. Witness: muzzle (20.666666666666668, 0), target (20, 5.333333333333333)
 *     -- which sits exactly on the shared boundary of two wall boxes -- returns
 *     1.695151321341659 unguarded, off a face buried inside the neighbour, versus
 *     1.012197011451334 guarded.
 *
 * So the guard is unnecessary because of REACHABILITY, not for the structural reason an
 * earlier version of this comment gave ("reaching a buried point requires passing through
 * the neighbour, which `losIgnoring` already rejects"). That argument is false: the
 * approach can arrive exactly at the seam CORNER, where the neighbour is only touched and
 * the graze check correctly lets it through. Do not re-add the guard without a fixture
 * that fails when it is removed -- and note such a fixture must place an endpoint on a
 * wall surface, which is why none exists.
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
  let bestAngle: number | null = null;
  let bestLength = Infinity;
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
      // A candidate on a buried interior seam face is rejected HERE, not by a separate
      // check on the bounce point -- see the doc comment above.
      if (!losIgnoring(muzzle, bounce, walls, w)) continue;
      if (!losIgnoring(bounce, target, walls, w)) continue;
      // ...and the returning leg must MISS the shooter. A shell coming back at its owner
      // is lethal to it (resolveBulletHits), so a bounce that sends the shell back up its
      // own firing lane -- e.g. reflecting off a wall the muzzle is directly above -- is a
      // suicide, not a bank shot. Measured against the same hull the shell would collide
      // with: TANK_RADIUS + BULLET_RADIUS, widened by AI_HULL_CLEARANCE's margin so a
      // near-graze at the edge of floating-point agreement is refused too.
      if (pointSegmentDistance(muzzle, bounce, target) < AI_HULL_CLEARANCE) continue;
      // Chosen by PATH LENGTH, not array position. The shortest bank is the fastest
      // shell to arrive, and -- unlike "first valid" -- it is a property of the arena's
      // geometry rather than of how that geometry was sliced into cells. Exact ties are
      // real in symmetric arenas, so they break on the ANGLE, which is geometric too.
      //
      // The comparison below is EXACT (no AIM_EPS band): "within epsilon counts as a tie"
      // is not transitive -- A within epsilon of B, and B within epsilon of C, does not
      // mean A is within epsilon of C -- so an epsilon-tolerant comparator is not a total
      // order and can give a different winner depending on visitation order no matter how
      // `bestLength`/`bestAngle` are bookkept. Plain `<` and `===` on IEEE 754 doubles ARE
      // a total order, so this is order-independent BY CONSTRUCTION, not merely on data
      // that happens not to probe the epsilon band. `bestLength` tracks the CHOSEN
      // candidate's own length, not a running minimum over every length seen, so a later
      // candidate is always compared against a real, still-current best.
      const length = vdist(muzzle, bounce) + vdist(bounce, target);
      const angle = angleOf(vsub(bounce, muzzle));
      const better =
        bestAngle === null || length < bestLength || (length === bestLength && angle < bestAngle);
      if (better) {
        bestLength = length;
        bestAngle = angle;
      }
    }
  }
  return bestAngle;
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
 *
 * `dangerCorridor` defaults to the exact constant -- today's behaviour, unperturbed. Every
 * enemy caller (grey.ts/teal.ts, and dangerAvoidMove below) passes a PERCEIVED corridor
 * instead (directive B): a narrower perceived corridor than the true one is what makes a
 * real threat go unflagged -- the "sometimes fatal" case, not merely cosmetic scatter.
 */
export function incomingThreats(world: World, tank: Tank, dangerCorridor = DANGER_CORRIDOR): Bullet[] {
  const out: Bullet[] = [];
  for (const b of world.bullets) {
    if (!b.alive) continue;
    const speed = detHypot(b.vel.x, b.vel.y);
    if (speed < VEC_EPS) continue;
    const dir = vnorm(b.vel);
    const rel = { x: tank.pos.x - b.pos.x, y: tank.pos.y - b.pos.y };
    // Own shells are only dangerous once they are heading back at the muzzle.
    if (b.ownerId === tank.id && vdot(b.vel, rel) <= 0) continue;
    const along = vdot(rel, dir);
    if (along < 0) continue;                     // bullet already past / moving away
    if (along > speed * THREAT_HORIZON) continue; // too far ahead in time
    const perp = { x: rel.x - dir.x * along, y: rel.y - dir.y * along };
    if (detHypot(perp.x, perp.y) <= dangerCorridor) out.push(b);
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
 * The mine-inclination draw: minePlacementChance consumed by MAGNITUDE. In each
 * WANDER_TICKS window an eligible tank passes with probability equal to its
 * profile's chance (grey/teal 0.3: mines go down in ~30% of the windows where
 * every tactical gate already said yes), instead of the old sign-only gate that
 * laid one every eligible window.
 *
 * Measured on the 60-seed harness before shipping (engagement.measure.test.ts,
 * which gained its minesPerGame column for exactly this):
 *   sign gate (old): 3.43 / 3.45 mines per game (a1/a3), free-win gate 3/60
 *   draw (shipped):  1.93 / 1.65,                        free-win gate 2/60
 * Lethality flat (medianTicks 1497->1496 / 1730->1750): shells kill the
 * pacifist player, not mines. Fewer mines = fewer AI self-kills, so the draw
 * BUYS BACK the gate headroom the aimAccuracy pass spent. Same pure-hash recipe as the other draws --
 * fresh prime 6101, so no stream collides (wander 1000, retreat 4243, jitter
 * 7919) -- and the fixture-critical draw (seed 5, id 1, bucket 0) is 0.0444,
 * below every shipped chance, which is why the pre-existing mine fixtures pass
 * unchanged.
 */
export function mineInclination(world: World, tank: Tank, cfg: ResolvedTankConfig): boolean {
  const chance = cfg.ai.minePlacementChance ?? 0;
  if (chance <= 0) return false;
  const bucket = Math.floor(world.tick / WANDER_TICKS);
  return nextRng(world.seed + tank.id * 6101 + bucket).value < chance;
}

/**
 * Per-profile aim spread, derived from the global anchor: AI_AIM_SPREAD is the
 * jitter of a PERFECT-accuracy profile (aimAccuracy 1.0), and lower accuracy
 * widens it -- the adopted framing: the anchor is maximal accuracy, profiles
 * derate from there. Curve chosen by sweep (see AI_AIM_SPREAD's comment in
 * constants.ts). Every shipped profile has accuracy < 1, so every enemy
 * jitters MORE than the old uniform spread -- a deliberate, measured
 * difficulty change, not an accident.
 */
export function profileAimSpread(cfg: ResolvedTankConfig): number {
  return AI_AIM_SPREAD / cfg.ai.aimAccuracy;
}

/**
 * Per-profile hazard-estimation spread, same anchor/derate shape as profileAimSpread:
 * AI_HAZARD_SPREAD is the estimation error of a hypothetical PERFECT-estimationAccuracy
 * profile, and lower accuracy widens it. Every shipped profile that reaches the sites below
 * sits under accuracy 1, so every one of them sometimes misjudges a hazard radius by more
 * than the anchor -- the mechanism directive B asks for ("AIs must not have oracle
 * knowledge... educated guessing with seeded error, sometimes fatal").
 */
export function profileHazardSpread(cfg: ResolvedTankConfig): number {
  return AI_HAZARD_SPREAD / cfg.ai.estimationAccuracy;
}

/**
 * Returns a signed hazard-estimation offset, bounded to ±`spread`, for `tank` to add to a
 * TRUE hazard radius (AI_MINE_FLEE_RADIUS, DANGER_CORRIDOR, AI_MINE_TACTICAL_RADIUS) to get
 * its PERCEIVED one. Same house recipe as wanderMove/aimJitter/mineInclination -- a pure
 * hash of (world.seed, tank.id, tick bucket), no threaded state, re-rolled every
 * WANDER_TICKS (the cadence the AI's other per-window intentions already use, so a
 * misjudgement is held for the span of one dodge/flee encounter rather than flickering tick
 * to tick and averaging itself away).
 *
 * ONE draw per tank per window, reused by every call site that needs a perceived radius
 * THIS tick: because this is a pure function of its inputs rather than threaded state, a
 * caller at any of grey.ts's three sites (dangerAvoidMove, the underFire corridor check,
 * mineThreatensPlayer) or index.ts's friendlyInMineBlast gets the IDENTICAL offset without
 * anything being passed between them -- "having a bad read this window" is coherent across
 * every hazard type at once, not an independent coin flip per site.
 *
 * `* 5303` is a fresh prime distinct from every other per-tank stream this file draws --
 * wander (1000, not itself prime but the collision argument only needs the MULTIPLIERS to
 * differ), retreat (4243), mine inclination (6101), aim jitter (7919) -- so for the same
 * (tank.id, bucket) this draw is never the identical key as any of them. It also cannot
 * collide with a bot's per-slot stream (game/loop.ts's BOT_SEED_SPACING): every bot key is
 * `world.seed - BOT_SEED_SPACING + slot`, strictly LESS than world.seed, while this key is
 * `world.seed + tank.id * 5303 + bucket` with tank.id >= 1, strictly GREATER -- the same
 * argument BOT_SEED_SPACING's own doc comment gives for the other four multipliers applies
 * to any positive one, this included.
 */
export function estimationError(world: World, tank: Tank, spread: number): number {
  const bucket = Math.floor(world.tick / WANDER_TICKS);
  const rng = nextRng(world.seed + tank.id * 5303 + bucket);
  return (rng.value * 2 - 1) * spread;
}

/**
 * Distance-band movement: the layer that makes preferredDistance, minimumDistance
 * and retreatChance REAL. Replaces bare wanderMove as the mobile decisions'
 * baseline move (dodging still overrides both -- see grey.ts/teal.ts).
 *
 *   d > preferredDistance  -> approach: a blend of the toward-player unit and the
 *                             wander heading (SEEK_APPROACH_BIAS), so closing in
 *                             stays organic rather than a robotic beeline.
 *   d < minimumDistance    -> pressed: a seeded draw against retreatChance each
 *                             WANDER_TICKS window decides retreat (same blend,
 *                             away) or hold ground (wander). This is the first
 *                             chance field whose MAGNITUDE is consumed: grey
 *                             (0.75) usually gives ground, teal (0.4) usually
 *                             stands and fights.
 *   in band, or no player  -> wanderMove, unchanged -- today's texture.
 *
 * The draw is the house pure-hash recipe (wanderMove/aimJitter): seed + id x a
 * fresh prime + tick bucket. No threaded state, so any caller at any tick gets
 * the same answer and replays stay exact. A seek direction that would step into
 * a wall falls back to wanderMove -- same philosophy as dangerAvoidMove's own
 * vetting: never hand moveTank a guaranteed-zero displacement.
 */
export function seekMove(world: World, tank: Tank, cfg: ResolvedTankConfig): Vec2 {
  const wander = wanderMove(world, tank);
  // Finds the FIRST alive player-kind tank -- correct-as-P1-preferred, not wrong, at
  // playerCount > 1: a second human is simply invisible to this AI, which still
  // engages whichever player-kind tank comes first in tank-array order. Who AI
  // targets when two humans are on the board is balance work, deferred.
  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) return wander;

  const d = vdist(tank.pos, player.pos);
  const { preferredDistance, minimumDistance, retreatChance } = cfg.ai;

  let dir: Vec2 | null = null;
  if (d > preferredDistance) {
    const toward = vnorm(vsub(player.pos, tank.pos));
    dir = vnorm({
      x: toward.x * SEEK_APPROACH_BIAS + wander.x * (1 - SEEK_APPROACH_BIAS),
      y: toward.y * SEEK_APPROACH_BIAS + wander.y * (1 - SEEK_APPROACH_BIAS),
    });
  } else if (d < minimumDistance) {
    const bucket = Math.floor(world.tick / WANDER_TICKS);
    const draw = nextRng(world.seed + tank.id * 4243 + bucket);
    if (draw.value < retreatChance) {
      const away = vnorm(vsub(tank.pos, player.pos));
      dir = vnorm({
        x: away.x * SEEK_APPROACH_BIAS + wander.x * (1 - SEEK_APPROACH_BIAS),
        y: away.y * SEEK_APPROACH_BIAS + wander.y * (1 - SEEK_APPROACH_BIAS),
      });
    }
  }

  // vnorm returns a unit vector or exactly {0,0}, so this guard is an exact-zero
  // check; the cancellation needs equal blend weights, i.e. it is live only while
  // SEEK_APPROACH_BIAS is exactly 0.5 (review).
  if (dir === null || vlen(dir) < VEC_EPS) return wander;
  // The probe must test the INJECTED cfg's speed, not the kind's -- the two can
  // differ under test injection, and the probe exists to predict moveTank's step.
  return wallBlocksStep(world, tank, dir, cfg.movementSpeed) ? wander : dir;
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
  const draw = (b: number): number => nextRng(world.seed + tank.id * 7919 + b).value * 2 - 1;
  // DRIFTS from this bucket's draw toward the next one across the bucket, rather than
  // holding one value and teleporting to the next at the boundary (issue #222 AC2: "aim
  // error changes read as a correction over time, not a stepwise target jump").
  //
  // Measured before this changed, over 60 seeds x 2 arenas x 2 player policies
  // (commitment.measure.test.ts): the aim TARGET moved a median 4.0-5.4 degrees on the
  // one tick in AI_JITTER_TICKS that crossed a boundary, against 0.11-0.18 degrees on
  // every other tick -- about a 30x step. The tail is what shows: the P95 boundary step
  // reached 23.19 degrees (teal, arena1, shooting player), and the AI turret slews at
  // AI_TURRET_TURN_RATE = 2.5 rad/s = 2.39 degrees/tick, so the barrel spent ~10 ticks
  // visibly chasing a target that had jumped in one.
  //
  // SMOOTHSTEP, not a linear ramp, and the reason is the distribution rather than the
  // look. Its zero slope at both ends makes the value linger near each bucket's own
  // draw, so the marginal spread stays close to the uniform +/-spread each profile is
  // tuned for. A linear lerp spends its time mid-blend between two independent draws,
  // which narrows effective aim error -- i.e. makes every enemy MORE accurate -- and
  // that would be a silent difficulty change smuggled in as a smoothing fix.
  // targeting.test.ts's "still reaches the full +/- spread envelope" case is the guard.
  //
  // At a boundary tick the eased factor is exactly 0, so the value is exactly that
  // bucket's own draw: the two hand-derived PRNG pins in targeting.test.ts, and every
  // other boundary-sampled assertion, are unmoved by this. It adds no new stream either
  // -- same 7919 multiplier, one extra read of the NEXT bucket's key.
  const t = (world.tick % AI_JITTER_TICKS) / AI_JITTER_TICKS;
  const eased = t * t * (3 - 2 * t);
  const a = draw(bucket);
  const b = draw(bucket + 1);
  return (a + (b - a) * eased) * spread;
}

/**
 * True if stepping one tick along `dir` would put the tank's hull inside a wall.
 *
 * moveTank resolves such an overlap by pushing the tank straight back out, so a dodge
 * aimed into a wall nets EXACTLY zero displacement: the tank stays pinned in the danger
 * corridor and dies there, worse off than if it had not dodged at all. Probing one
 * movementSpeed*DT step is the same displacement moveTank is about to apply -- read from
 * the tank's own resolved config, the same source moveTank uses -- so this asks precisely
 * the question that matters.
 */
function wallBlocksStep(world: World, tank: Tank, dir: Vec2, speed = configFor(tank.kind).movementSpeed): boolean {
  const probe = {
    x: tank.pos.x + dir.x * speed * DT,
    y: tank.pos.y + dir.y * speed * DT,
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
 *
 * `fleeRadius` defaults to the exact constant -- today's behaviour, unperturbed. Callers
 * that pass a PERCEIVED radius (directive B: no oracle knowledge of the true blast reach)
 * change which mines even make it into this list -- a mine just outside the perceived
 * radius is invisible to `bestEscapeDirection` below even though it is real and armed,
 * which is where the "sometimes fatal" outcome actually lives. `bestEscapeDirection`
 * itself stays untouched: it is handed whatever list this function returns and searches it
 * perfectly, same as always -- the imperfection is in which mines reach it, not in how well
 * it escapes the ones it is told about.
 */
function dangerousMines(world: World, tank: Tank, fleeRadius = AI_MINE_FLEE_RADIUS): Mine[] {
  const near: Mine[] = [];
  for (const m of world.mines) {
    if (m.detonated) continue;
    // `<=`, and measured against the radius detonateMine actually KILLS at plus an escape
    // margin -- see AI_MINE_FLEE_RADIUS in constants.ts.
    if (vdist(m.pos, tank.pos) <= fleeRadius) near.push(m);
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
 *
 * Deliberately UNCHANGED by directive B (estimation error): this is the literal "perfect
 * mine-dodge position" solve the ruling names, and it stays perfect FOR THE MINES IT IS
 * HANDED. It takes no radius of its own to perturb. The imperfection lives one level up, in
 * `dangerousMines`'s perceived `fleeRadius`: a mine just outside the tank's PERCEIVED
 * radius never reaches this function's `mines` argument at all, even though it is real,
 * armed, and inside the TRUE radius -- so the oracle knowledge this function would
 * otherwise represent is neutralized upstream, not by adding noise to a search that is
 * supposed to be exact once it knows what to search for.
 */
function bestEscapeDirection(world: World, tank: Tank, mines: Mine[]): Vec2 | null {
  const away: Vec2[] = [];
  for (const m of mines) {
    const d = vsub(tank.pos, m.pos);
    // Standing exactly on a mine gives no direction to prefer, so it constrains nothing.
    if (detHypot(d.x, d.y) < VEC_EPS) continue;
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
    const cand = { x: Math.round(detCos(a) * 1e12) / 1e12, y: Math.round(detSin(a) * 1e12) / 1e12 };
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
 *
 * `fleeRadius`/`dangerCorridor` default to the exact constants -- today's behaviour,
 * unperturbed -- and are forwarded to `dangerousMines`/`incomingThreats` unchanged. This is
 * the ONE place a caller needs to thread a perceived radius through to reach both: grey.ts
 * and teal.ts compute a single per-tick `estimationError` offset and pass it here (and
 * again, independently, at their own direct `incomingThreats`/`mineThreatensPlayer` call
 * sites) rather than this function drawing anything itself -- dangerAvoidMove stays exactly
 * as deterministic as it always was; the noise lives at the caller, never in the shared
 * geometry (see the module's callers for why: `decidePlayerInput` reuses this same function
 * and must never touch `world.seed`).
 */
export function dangerAvoidMove(world: World, tank: Tank, fleeRadius = AI_MINE_FLEE_RADIUS, dangerCorridor = DANGER_CORRIDOR): Vec2 | null {
  const mines = dangerousMines(world, tank, fleeRadius);
  const threats = incomingThreats(world, tank, dangerCorridor);

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
