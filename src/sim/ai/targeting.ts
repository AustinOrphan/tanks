import type { Vec2, Wall, AABB, Bullet, Tank, Mine, BulletType } from '../types';
import { vsub, angleOf, vdot, vdist, vlen, vnorm, fromAngle, nextRng } from '../types';
import { raySegmentVsAABB, circleVsAABB, reflectSweep, driveVelocity } from '../collision';
import { configFor, type ResolvedTankConfig } from '../config';
import {
  AIM_EPS, AI_AIM_SPREAD, AI_HAZARD_SPREAD, TANK_RADIUS, DT, THREAT_HORIZON, DANGER_CORRIDOR, SEEK_APPROACH_BIAS,
  AI_TARGET_TIE_BAND,
  VEC_EPS, WANDER_TICKS, AI_JITTER_TICKS, AI_MINE_FLEE_RADIUS, AI_HULL_CLEARANCE,
  AI_SHOT_LOOKAHEAD, ESCAPE_SAMPLES, AI_MINE_TACTICAL_RADIUS, bulletConfig, SWEEP_EPS,
  AI_PATH_HORIZON_TICKS,
} from '../constants';
import type { World } from '../world';
import { detHypot } from '../math/hypot';
import { detSin, detCos } from '../math/trig';

/**
 * Walls only; tanks on the line are shotHitsOwnSide's question. Kept apart because "can the
 * shell physically reach there" and "should we pull the trigger" differ: the bank-shot
 * search needs the wall-only meaning, the fire gate needs both.
 */
export function lineOfSight(from: Vec2, to: Vec2, walls: Wall[]): boolean {
  for (const w of walls) {
    if (w.destroyed) continue;
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false;
  }
  return true;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return detHypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/**
 * Built with the same reflectSweep the sim moves bullets with, so the AI reasons about the
 * path the shell really takes, bounces included, rather than the straight line it starts on.
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
 * Own side means a teammate or, after a bounce, the shooter itself: both are real kills.
 * resolveBulletHits (bullets.ts) kills any non-owner tank a shell touches, teammates
 * included, and kills the owner once the shell heads back at it -- routine, not exotic,
 * with NORMAL_BOUNCES = 1 / RICOCHET_BOUNCES = 2 in a boxed arena.
 *
 * The shooter is exempt on leg 0 only: the path starts inside its own hull, and a shell
 * travelling away is harmless to its owner, exactly as resolveBulletHits has it.
 *
 * Own-side tanks are checked where they will be, not only where they stand: a snapshot
 * treats roaming teammates as parked, and clears shots at mates who then walk into the
 * shell.
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
      if (!t.alive || t.kind === 'player') continue;
      if (t.id === tank.id && leg === 0) continue;
      // Both tests, ORed: prediction adds the mates who walk in, it does not excuse the
      // ones standing on the line today. Prediction alone is worse, because a roamer's
      // heading is only stable for a fraction of the flight time -- extrapolating it over
      // the full AI_SHOT_LOOKAHEAD clears shots at mates that never actually leave the line.
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
 * Solved in closed form and clamped to the leg rather than sampled, so a fast shell cannot
 * step over a teammate between samples.
 */
function minApproach(a: Vec2, b: Vec2, legTime: number, legStart: number, p: Vec2, vel: Vec2): number {
  if (legTime <= 0) {
    const at = { x: p.x + vel.x * legStart, y: p.y + vel.y * legStart };
    return vdist(a, at);
  }
  const shellVel = { x: (b.x - a.x) / legTime, y: (b.y - a.y) / legTime };
  const d0 = { x: a.x - (p.x + vel.x * legStart), y: a.y - (p.y + vel.y * legStart) };
  const w = { x: shellVel.x - vel.x, y: shellVel.y - vel.y };
  const w2 = w.x * w.x + w.y * w.y;
  let s = w2 < VEC_EPS ? 0 : -(d0.x * w.x + d0.y * w.y) / w2;
  s = s < 0 ? 0 : s > legTime ? legTime : s;
  return detHypot(d0.x + w.x * s, d0.y + w.y * s);
}

/**
 * A mine's blast spares no enemy tank: mines.ts's only team exemption is the teams-mode
 * friendly-fire gate, and only player tanks in teams mode carry a `team` (arena.ts). So a
 * mine laid at a teammate's feet is a teammate kill on a 3-second fuse -- and Brown, which
 * never moves, has no way to leave.
 * Measured against AI_MINE_FLEE_RADIUS rather than the bare kill radius so the teammate is
 * not merely outside the blast but outside the zone it would have to run from at all.
 *
 * `stepAi` (ai/index.ts, the only caller) passes a perceived radius instead (directive B:
 * no oracle knowledge of the blast's true reach), from the same `perceiveHazards` belief
 * grey.ts/teal.ts use for their own dodge/flee gates.
 */
export function friendlyInMineBlast(world: World, tank: Tank, fleeRadius = AI_MINE_FLEE_RADIUS): boolean {
  for (const t of world.tanks) {
    if (!t.alive || t.id === tank.id || t.kind === 'player') continue;
    if (vdist(t.pos, tank.pos) <= fleeRadius) return true;
  }
  return false;
}

/**
 * Without this check the mine gate is an availability test (cooldown ready, under the cap),
 * not a tactical one, so a roamer crossing an empty half of the arena litters live ordnance
 * behind itself for no gain, then has to spend its time dodging it; own mines were the
 * single largest cause of AI deaths measured.
 *
 * Being a plain radius around the drop point, this still permits a burst: while the player
 * stays close a tank may lay its whole mine capacity back to back, which is the chokepoint
 * denial worth keeping.
 *
 * grey.ts/teal.ts pass a perceived radius (directive B): the offense side of the same
 * `perceiveHazards` estimation error that gates their own dodge/flee decisions.
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

  if (t <= AIM_EPS) return angleOf(rel);
  const intercept = { x: target.x + targetVel.x * t, y: target.y + targetVel.y * t };
  return angleOf(vsub(intercept, muzzle));
}

export function mirrorAcrossAABB(point: Vec2, box: AABB): Vec2[] {
  return [
    { x: 2 * box.minX - point.x, y: point.y },
    { x: 2 * box.maxX - point.x, y: point.y },
    { x: point.x, y: 2 * box.minY - point.y },
    { x: point.x, y: 2 * box.maxY - point.y },
  ];
}

/**
 * True if a segment leaving `start` toward `target` is travelling into `box`, as opposed
 * to grazing one of its faces on the way past. A copy of collision.ts's private
 * `headingInto` (same probe distance), duplicated because collision.ts does not export it.
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
 * LOS that ignores `ignore`, the reflecting wall the bounce point sits on.
 *
 * A bounce point can land exactly on a seam between the cells of a subdivided reflector,
 * putting a leg's own endpoint on a neighbouring wall's corner. `raySegmentVsAABB` reports
 * that boundary touch as a hit (`tmin == tmax` at t~0 or t~1) even though the segment never
 * enters the neighbour's interior -- the same degenerate-touch class collision.ts's
 * `headingInto` handles for `reflectSweep` (see "The bank-shot dependence turned out to live
 * one function deeper" in docs/agent/architecture.md). So a hit at either end is probed a
 * hair in from that end: still inside the box is a real block; not is a graze, let through.
 *
 * "At either end" is measured in world units (`hit.t * len`), not the ray parameter, to
 * match the probe's fixed `SWEEP_EPS` of world distance. Comparing raw `hit.t` would, on a
 * segment longer than 1 unit, send hits up to `SWEEP_EPS * len` from an end down the graze
 * branch, and a real crossing more than `SWEEP_EPS` in has its probe land short of the box
 * and passes as a graze -- a shot reported clear straight through a solid wall.
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

// In mirrorAcrossAABB's face order: bankShot indexes both by face.
const FACE_NORMALS: Vec2[] = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
];

/**
 * Single-bounce only. Picks the shortest valid path (the fastest shell to arrive), exact
 * ties to the smaller firing angle, so the choice is a property of the arena's geometry:
 * however the level data slices a reflector into wall cells, the shortest path off its
 * outer surface is the same path.
 *
 * A candidate whose reflected leg (bounce -> target) passes through the shooter's own
 * hull is rejected: resolveBulletHits (bullets.ts) makes a shell lethal to its owner the
 * instant its velocity points back at it, so such a path is a self-kill dressed up as a
 * firing solution. Both legs being wall-clear says nothing about this.
 *
 * A candidate reflecting off a face buried inside a neighbouring wall (an interior seam
 * manufactured by how the level data sliced a reflector into cells) does not get its own
 * rejection here. An explicit `faceIsBuried` guard was deleted, on this evidence and with
 * this limit:
 *
 *   - On probes where both endpoints lie strictly outside every wall -- the only states
 *     the sim actually produces, since `resolveWalls` keeps every hull centre out of the
 *     wall mass -- removing the guard changed the answer on **0 of 4,195,692** (muzzle,
 *     target) pairs: 12 synthetic shapes (adjacent pair, three-in-a-row, column, L, T,
 *     plus-cross, fully-surrounded centre, diagonal staircase, overlapping pair,
 *     partial-overlap L, partial face cover, offset runs) plus all 4 shipped arenas'
 *     real merged geometry, compared per-config with and without the guard.
 *   - Off that domain it is not a no-op. With an endpoint lying exactly on a wall
 *     surface, **81 of 1,966,116** probes differ, all on arena-03, all with the target on
 *     a surface. Witness: muzzle (20.666666666666668, 0), target (20, 5.333333333333333)
 *     -- which sits exactly on the shared boundary of two wall boxes -- returns
 *     1.695151321341659 unguarded, off a face buried inside the neighbour, versus
 *     1.012197011451334 guarded.
 *
 * So the guard is unnecessary because of reachability, not for the tempting structural
 * reason ("reaching a buried point requires passing through the neighbour, which
 * `losIgnoring` already rejects"). That argument is false: the approach can arrive exactly
 * at the seam corner, where the neighbour is only touched and the graze check correctly
 * lets it through. Do not re-add the guard without a fixture that fails when it is removed
 * -- and such a fixture must place an endpoint on a wall surface, which is why none exists.
 *
 * @param maxBounces — Used only as a precondition: must be >= 1 to proceed. A larger budget
 *   (a ricochet shell's) still finds only single-bounce paths.
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
      // raySegmentVsAABB's normals are exact -- each component is ±1 or 0, never epsilon --
      // so `!==` is safe here. A bounce landing at a wall corner (within 1e-7) is modelled
      // here as a single-face reflection; reflectSweep retroreflects both axes there, but the
      // difference is negligible.
      const n = FACE_NORMALS[face];
      if (hit.normal.x !== n.x || hit.normal.y !== n.y) continue;
      const bounce = hit.point;
      if (!losIgnoring(muzzle, bounce, walls, w)) continue;
      if (!losIgnoring(bounce, target, walls, w)) continue;
      if (pointSegmentDistance(muzzle, bounce, target) < AI_HULL_CLEARANCE) continue;
      // Exact comparison, no AIM_EPS band: "within epsilon counts as a tie" is not
      // transitive, so an epsilon-tolerant comparator is not a total order and can give a
      // different winner depending on visitation order. Plain `<` and `===` on IEEE 754
      // doubles are a total order, so this is order-independent by construction. Exact ties
      // are real in symmetric arenas.
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
 * Own shells count. resolveBulletHits (bullets.ts) makes a shell lethal to its owner the
 * moment `vdot(b.vel, ownerPos - b.pos) > 0` — i.e. as soon as it heads back — and any
 * shell with a bounce left can come back. Skipping own bullets outright would leave a tank
 * standing still while its own ricochet killed it. The predicate below is the same one
 * resolveBulletHits uses, deliberately: anything looser makes a tank dodge the shell it
 * just fired (a shell spawned at the tank's centre, as on a blocked muzzle, has a zero rel
 * and a dot of exactly 0, which `<= 0` correctly treats as harmless).
 *
 * Limitation: models bullets as straight lines and ignores walls. A shell that will bank
 * off a wall into the tank is not flagged; a bullet that a wall will stop still is.
 *
 * Callers (grey.ts, teal.ts, player-profile.ts) pass a perceived corridor (directive B),
 * directly and through dangerAvoidMove: a perceived corridor narrower than the true one is
 * what makes a real threat go unflagged -- the "sometimes fatal" case, not merely cosmetic
 * scatter.
 */
export function incomingThreats(world: World, tank: Tank, dangerCorridor = DANGER_CORRIDOR): Bullet[] {
  const out: Bullet[] = [];
  for (const b of world.bullets) {
    if (!b.alive) continue;
    const speed = detHypot(b.vel.x, b.vel.y);
    if (speed < VEC_EPS) continue;
    const dir = vnorm(b.vel);
    const rel = { x: tank.pos.x - b.pos.x, y: tank.pos.y - b.pos.y };
    if (b.ownerId === tank.id && vdot(b.vel, rel) <= 0) continue;
    const along = vdot(rel, dir);
    if (along < 0) continue;
    if (along > speed * THREAT_HORIZON) continue;
    const perp = { x: rel.x - dir.x * along, y: rel.y - dir.y * along };
    if (detHypot(perp.x, perp.y) <= dangerCorridor) out.push(b);
  }
  return out;
}

/**
 * A pure hash of `(world.seed, tank.id, tick bucket)`, deliberately not threading PRNG
 * state from one call to the next: any caller, in any order, at any tick gets the same
 * answer for the same inputs, and it cannot desync any other RNG consumer in the sim.
 */
export function wanderMove(world: World, tank: Tank): Vec2 {
  const bucket = Math.floor(world.tick / WANDER_TICKS);
  const rng = nextRng(world.seed + tank.id * 1000 + bucket);
  return fromAngle(rng.value * Math.PI * 2);
}

/**
 * Grey and teal's 0.3 chance, measured on the 60-seed harness (engagement.measure.test.ts's
 * minesPerGame column), lays about half the mines of laying one in every WANDER_TICKS window
 * the tactical gates allow, with lethality flat; fewer mines means fewer AI self-kills.
 *
 * 6101 is a fresh prime so no stream collides (wander 1000, retreat 4243, estimation 5303,
 * jitter 7919). The fixture-critical draw (seed 5, id 1, bucket 0) is 0.0444, below every
 * shipped chance, which the mine fixtures on that key rely on.
 */
export function mineInclination(world: World, tank: Tank, cfg: ResolvedTankConfig): boolean {
  const chance = cfg.ai.minePlacementChance ?? 0;
  if (chance <= 0) return false;
  const bucket = Math.floor(world.tick / WANDER_TICKS);
  return nextRng(world.seed + tank.id * 6101 + bucket).value < chance;
}

/**
 * The enemy-side mirror of `isOpponent` below. Kept separate rather than generalised: one
 * predicate serving both directions would have to branch on the subject's own kind, which
 * is the "branch on tank kind" the simulation rules forbid.
 */
export function isTargetable(world: World, subject: Tank, other: Tank): boolean {
  if (!other.alive || other.kind !== 'player') return false;
  // Teams matter only once both tanks carry one; campaign-coop enemies carry none.
  if (world.rules.mode === 'teams' && other.team !== undefined && other.team === subject.team) return false;
  return true;
}

/**
 * For a `subject` filling a player slot -- a human or a bot.
 *
 * Shared (issue #891) by the commitment `stepAi` writes for a bot slot (bot-commitment.ts)
 * and the threat pass of the bot's own decision (`decidePlayerInput`), so exactly one
 * opponent notion governs a bot's movement and firing by construction; two mode-aware
 * predicates in two files would diverge.
 *
 * Named `subject`, not `self`: purity.test.ts flags any bare `self.`/`self[` as the
 * DOM/worker global by regex, not by scope.
 */
export function isOpponent(world: World, subject: Tank, other: Tank): boolean {
  if (!other.alive) return false;
  switch (world.rules.mode) {
    case 'ffa':
      return other.kind === 'player' && other.id !== subject.id;
    case 'teams':
      return other.kind === 'player' && other.team !== subject.team;
    case 'campaign-coop':
    default:
      return other.kind !== 'player';
  }
}

/**
 * Rule 1 binds acquisition, not retention: a committed target is kept through a sight break
 * for the rest of its span (rules 5 and 7 -- "losing direct sight does not... immediately
 * pick a different player"). Gating retention here instead would drop the target the
 * instant a wall intervened and send seekMove straight to `wander`, a much larger behaviour
 * change than issue #359 asks for.
 */
function perceives(world: World, tank: Tank, other: Tank, cfg: ResolvedTankConfig): boolean {
  if (lineOfSight(tank.pos, other.pos, world.walls)) return true;
  // A banking profile perceives what it can bank at: that is the shipped role, not a
  // loophole. brown.ts and teal.ts both solve `bankShot` against a target with no line of
  // sight, so an LOS-only bound would silently delete indirect fire from every profile that
  // has it, which no ruling asked for.
  //
  // Gated on the weight rather than on solving a bank path here: bankShot is O(walls^2) and
  // selection runs per candidate per tick.
  //
  // Limitation: for a banking profile this makes the perception bound of rule 1 nearly
  // inert, because it can select an opponent it cannot see. Narrowing it needs a real
  // perception model with memory -- #372's bounded last-seen contact -- not a tighter
  // predicate here.
  return cfg.ai.bankShotWeight > 0;
}

/**
 * Rule 2 asks for the opponent closest to the profile's preferred range, not the nearest
 * one: a defensive kiter should pick the opponent it can hold at range over the one already
 * in its face.
 */
export function rangeCost(tank: Tank, other: Tank, preferred: number): number {
  return Math.abs(vdist(tank.pos, other.pos) - preferred);
}

/**
 * Rule 3's seeded per-AI tie-break. Keyed on the subject as well as the candidate: keyed
 * only on the candidate it would rank the players identically for every AI and swing the
 * whole enemy line onto one target at once, the symmetric result the rule forbids by name.
 *
 * Deliberately not tank-array or slot order, and deliberately not time-varying: a tie-break
 * that moved with `world.tick` would re-roll ties inside a commitment span.
 */
function tieBreak(world: World, subject: Tank, other: Tank): number {
  return nextRng(world.seed + subject.id * 2749 + other.id * 40529).value;
}

/**
 * The AI_TARGET_TIE_BAND quantisation is what makes rule 3 reachable at all: two opponents
 * are almost never at exactly equal distance in floating point, so an unquantised comparison
 * would make the tie-break dead code -- and a dead tie-break looks identical to a working one
 * until a symmetric fixture is written.
 */
function better(world: World, subject: Tank, a: Tank, b: Tank, preferred: number): boolean {
  const ba = Math.round(rangeCost(subject, a, preferred) / AI_TARGET_TIE_BAND);
  const bb = Math.round(rangeCost(subject, b, preferred) / AI_TARGET_TIE_BAND);
  if (ba !== bb) return ba < bb;
  return tieBreak(world, subject, a) > tieBreak(world, subject, b);
}

export function selectPerceived(world: World, tank: Tank, cfg: ResolvedTankConfig): Tank | undefined {
  const preferred = cfg.ai.preferredDistance;
  // The shipped default is full awareness (issue #359, owner ruling superseding rule 1).
  // The player sees every tank on the board -- the camera frames the whole playable area and
  // nothing fogs or culls -- so bounding selection by line of sight handed the AI a limit the
  // human does not have, whose counterplay was standing behind a wall until it forgot you.
  // Measured before the ruling, the bound never bit a banking profile (grey, teal) and left
  // non-banking ones (brown, olive) with no target for much of their life, because
  // `bankShotWeight`, a weapon-style knob, was deciding perception.
  //
  // Aiming is untouched either way: `hasSolution` still needs a real firing solution -- a
  // line of sight or a bank path -- so a tank that knows who it is fighting still cannot
  // shoot -- or track -- through a wall.
  const bounded = world.rules.aiTargetPerception === 'line-of-sight';
  // `chosen`, not `best`: `sidestepAroundBlockage` below ends with `return best;` and the
  // mutation manifest anchors an entry on that exact line. A second identical line here would
  // make that find string ambiguous and the entry would stop applying -- silently, since a
  // stale anchor reports failed-to-apply rather than a survivor.
  let chosen: Tank | undefined;
  for (const other of world.tanks) {
    if (!isTargetable(world, tank, other)) continue;
    if (bounded && !perceives(world, tank, other, cfg)) continue;
    if (!chosen || better(world, tank, other, chosen, preferred)) chosen = other;
  }
  return chosen;
}

/**
 * `commitTarget` (ai/target-selection.ts) is the only writer of an enemy's `aiTargetId`, and
 * `stepAi` calls it once per tank before the decision runs -- so brown, grey, teal and
 * `seekMove` all read one answer here, which makes issue #359's "movement and firing use the
 * same committed opponent" structural rather than coincidental.
 *
 * The pure selection is a fallback, not dead code: a decision function may be called
 * without the commitment layer having run (every unit test that drives `decideAi` directly
 * does), and "no opponent" because nothing had written yet would be an artefact of call
 * order. It is pure in `(world, tank)`, so it too gives every call site in a tick the same
 * answer.
 *
 * `isTargetable` re-checks `alive` on the committed path because a target can die to a blast
 * resolved later in the same tick than the commitment was written.
 */
export function resolveOpponent(world: World, tank: Tank, cfg: ResolvedTankConfig): Tank | undefined {
  if (tank.aiTargetId !== undefined) {
    const held = world.tanks.find((t) => t.id === tank.aiTargetId);
    if (held && isTargetable(world, tank, held)) return held;
  }
  return selectPerceived(world, tank, cfg);
}

/** Curve chosen by sweep: see AI_AIM_SPREAD's comment in constants.ts. */
export function profileAimSpread(cfg: ResolvedTankConfig): number {
  return AI_AIM_SPREAD / cfg.ai.aimAccuracy;
}

/** Directive B's hazard-estimation error: see AI_HAZARD_SPREAD's comment in constants.ts. */
export function profileHazardSpread(cfg: ResolvedTankConfig): number {
  return AI_HAZARD_SPREAD / cfg.ai.estimationAccuracy;
}

/**
 * An offset for `tank` to add to a true hazard radius (AI_MINE_FLEE_RADIUS, DANGER_CORRIDOR,
 * AI_MINE_TACTICAL_RADIUS) to get its perceived one. Held for `refreshTicks` so a
 * misjudgement lasts one dodge/flee encounter rather than flickering tick to tick and
 * averaging itself away.
 *
 * Because this is a pure function rather than threaded state, `perceiveHazards` (whose one
 * snapshot grey.ts/teal.ts reuse at every hazard site) and `stepAi`'s friendlyInMineBlast
 * gate get the identical offset without anything being passed between them -- "having a bad
 * read this window" is coherent across every hazard type at once, not an independent coin
 * flip per site.
 *
 * `* 5303` differs from every other per-window multiplier this file draws with -- wander
 * (1000), retreat (4243), mine inclination (6101), aim jitter (7919) -- so for the same
 * (tank.id, bucket) no two streams share a key. Nor can it hit a bot's per-slot stream
 * (game/loop.ts's BOT_SEED_SPACING): every bot key is `world.seed - BOT_SEED_SPACING + slot`,
 * strictly less than world.seed, while this key is strictly greater since tank.id >= 1.
 */
export function estimationError(
  world: World,
  tank: Tank,
  spread: number,
  /**
   * `perceiveHazards` (ai/hazard-perception.ts) passes the profile's own
   * `hazardRefreshTicks`, which makes the cadence a per-profile competence axis (issue #223).
   * Floored at 1 tick: it is a divisor, and a zero window would bucket every tick to the same
   * Infinity and freeze one draw for the whole round.
   */
  refreshTicks = WANDER_TICKS,
): number {
  const bucket = Math.floor(world.tick / Math.max(1, refreshTicks));
  const rng = nextRng(world.seed + tank.id * 5303 + bucket);
  return (rng.value * 2 - 1) * spread;
}

/**
 * The mobile decisions' baseline move; dodging overrides it (grey.ts/teal.ts). Approach and
 * retreat blend in the wander heading so closing in stays organic rather than a robotic
 * beeline.
 */
export function seekMove(world: World, tank: Tank, cfg: ResolvedTankConfig): Vec2 {
  const wander = wanderMove(world, tank);
  const player = resolveOpponent(world, tank, cfg);
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
  // The probe must test the injected cfg's speed, not the kind's -- the two can
  // differ under test injection, and the probe exists to predict moveTank's step.
  // Horizon probe, not a single step (issue #224): a seek heading that is legal for one
  // tick but runs into a wall a few ticks later would leave the tank grinding along that
  // wall for the rest of the window.
  return wallBlocksPath(world, tank, dir, AI_PATH_HORIZON_TICKS, cfg.movementSpeed) ? wander : dir;
}

/**
 * An aiming error in radians, for `tank` to add to its computed firing angle.
 *
 * `* 7919`, not wanderMove's `* 1000`, so a tank's wander heading and its aim error are
 * never correlated: a tank that always missed in the direction it happened to be walking
 * would look like a bug, not a feature.
 */
export function aimJitter(world: World, tank: Tank, spread: number): number {
  const bucket = Math.floor(world.tick / AI_JITTER_TICKS);
  const draw = (b: number): number => nextRng(world.seed + tank.id * 7919 + b).value * 2 - 1;
  // Drifts from this bucket's draw toward the next one across the bucket, rather than
  // holding one value and teleporting to the next at the boundary (issue #222 AC2: "aim
  // error changes read as a correction over time, not a stepwise target jump"). The
  // stepwise version moved the aim target about 30x further on a boundary tick than on any
  // other, leaving the slew-limited barrel visibly chasing it for ~10 ticks at the tail
  // (measured in commitment.measure.test.ts).
  //
  // Smoothstep, not a linear ramp, and the reason is the distribution rather than the
  // look. Its zero slope at both ends makes the value linger near each bucket's own
  // draw, so the marginal spread stays close to the uniform +/-spread each profile is
  // tuned for. A linear lerp spends its time mid-blend between two independent draws,
  // which narrows effective aim error -- i.e. makes every enemy more accurate -- and
  // that would be a silent difficulty change smuggled in as a smoothing fix.
  // targeting.test.ts's "still reaches the full +/- spread envelope" case is the guard.
  //
  // At a boundary tick the eased factor is exactly 0, so the value is exactly that
  // bucket's own draw: the two hand-derived PRNG pins in targeting.test.ts, and every
  // other boundary-sampled assertion, sample that draw unblended.
  const t = (world.tick % AI_JITTER_TICKS) / AI_JITTER_TICKS;
  const eased = t * t * (3 - 2 * t);
  const a = draw(bucket);
  const b = draw(bucket + 1);
  return (a + (b - a) * eased) * spread;
}

/**
 * The short-horizon navigability test issue #224 asks for.
 *
 * One probe per tick, so consecutive samples sit `speed * DT` apart (0.05 units at the base
 * speed of 3) against a TANK_RADIUS of 0.5: the swept hull is covered many times over and a
 * wall cannot slip between two samples.
 *
 * Approximate, deliberately, and in the conservative direction. `moveTank` turns the hull
 * toward the request and drives along the hull at a speed scaled by how far it still has to
 * swing, so a tank facing away from `dir` covers less ground than this straight-line probe
 * assumes and covers it in a different direction. Simulating that per candidate would mean
 * replaying the hull slew for each of ESCAPE_SAMPLES directions every tick. This over-states
 * forward progress instead, which makes the test reject some headings the tank could in fact
 * have taken -- never the reverse. Callers therefore need a real fallback for "everything is
 * blocked", which is exactly what issue #224's third acceptance criterion is about.
 */
export function wallBlocksPath(
  world: World,
  tank: Tank,
  dir: Vec2,
  ticks: number,
  speed = configFor(tank.kind).movementSpeed,
): boolean {
  const perTick = speed * DT;
  for (let i = 1; i <= ticks; i++) {
    const probe = { x: tank.pos.x + dir.x * perTick * i, y: tank.pos.y + dir.y * perTick * i };
    for (const w of world.walls) {
      if (w.destroyed) continue;
      if (circleVsAABB(probe, TANK_RADIUS, w.aabb).hit) return true;
    }
  }
  return false;
}

/**
 * The one-tick case of `wallBlocksPath` (same straight-line approximation), which
 * commitment.ts uses to break a held heading: moveTank resolves such an overlap by pushing
 * the tank straight back out, so holding a heading into a wall pins the tank in place.
 */
export function wallBlocksStep(world: World, tank: Tank, dir: Vec2, speed = configFor(tank.kind).movementSpeed): boolean {
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
 * Unarmed mines count. `armed` gates the proximity trigger, but stepMines detonates on
 * MINE_TIMER expiry regardless and the blast has no owner exemption -- so a tank loitering
 * inside MINE_PROXIMITY_RADIUS of its own unarmed mine still has to flee it before the
 * 3-second fuse runs out.
 */
function dangerousMines(world: World, tank: Tank, fleeRadius = AI_MINE_FLEE_RADIUS): Mine[] {
  const near: Mine[] = [];
  for (const m of world.mines) {
    if (m.detonated) continue;
    if (vdist(m.pos, tank.pos) <= fleeRadius) near.push(m);
  }
  return near;
}

/**
 * Escapes every mine in `mines` at once. Fleeing only the nearest mine deadlocks when two
 * are in range: running from one puts the tank on the other, which then becomes the nearest
 * (24 of 26 own-mine deaths over 30 seeded games had both mines in flee range).
 *
 * Directions are sampled on a fixed wheel rather than solved analytically: the wheel is
 * deterministic, cannot divide by a near-zero resultant when repulsions cancel, and
 * includes the exact axis directions, so the single-mine case still yields straight away.
 *
 * Deliberately untouched by directive B (estimation error): this is the literal "perfect
 * mine-dodge position" solve the ruling names, and it stays perfect for the mines it is
 * handed. The imperfection lives upstream, in which mines reach `mines` at all: a mine just
 * outside `dangerousMines`'s perceived `fleeRadius` never arrives, even though it is real
 * and inside the true radius.
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
    if (wallBlocksPath(world, tank, cand, AI_PATH_HORIZON_TICKS)) {
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
 * The deterministic way out when BOTH dodge perpendiculars are blocked (issue #224 AC3).
 * Scored by lateral clearance from the shell's line, so a heading that merely flees down the
 * corridor never beats one that actually leaves it. Candidates that step toward a mine already
 * in flee range are refused, the same constraint the two perpendicular passes apply.
 *
 * Returns null when the whole wheel is blocked, which is a real state in a dead end: the
 * caller then falls back to its preferred perpendicular, and that is the explicit, stable
 * choice the criterion asks for rather than an accident.
 */
function sidestepAroundBlockage(world: World, tank: Tank, bulletDir: Vec2, mines: Mine[]): Vec2 | null {
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < ESCAPE_SAMPLES; i++) {
    const a = (i * 2 * Math.PI) / ESCAPE_SAMPLES;
    // Snapped exactly as bestEscapeDirection snaps, so the axis directions stay exact rather
    // than 1e-16 off and a fixture comparing to {1,0} still matches.
    const cand = { x: Math.round(detCos(a) * 1e12) / 1e12, y: Math.round(detSin(a) * 1e12) / 1e12 };
    if (wallBlocksPath(world, tank, cand, AI_PATH_HORIZON_TICKS)) continue;
    if (mines.some((m) => vdot(cand, vsub(m.pos, tank.pos)) > 0)) continue;
    const score = 1 - Math.abs(vdot(cand, bulletDir));
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

/**
 * A unit dodge direction, or null when no bullet threatens and no mine is in flee range.
 *
 * The bullet dodge prefers the perpendicular on the side the tank already sits, so it dodges
 * outward rather than across the threat -- but that preference yields to two hard
 * constraints, because a dodge that kills the tank is worse than no dodge:
 *   1. it must not walk into a wall (moveTank would cancel the move entirely), and
 *   2. it must not step toward a mine that is already in flee range. The two
 *      perpendiculars are exact opposites, so a single mine can reject at most one of them.
 *
 * grey.ts and teal.ts pass their `perceiveHazards` radii here rather than this function
 * drawing anything itself: the noise lives at the caller, never in the shared geometry,
 * because `decidePlayerInput` reuses this same function and must never touch `world.seed`.
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
    const rel = { x: tank.pos.x - nearest.pos.x, y: tank.pos.y - nearest.pos.y };
    const preferred = vdot(rel, perpA) >= 0 ? perpA : perpB;
    const other = preferred === perpA ? perpB : perpA;

    // Vetted against every mine in flee range, not just the nearest: a dodge cleared by
    // the nearest mine could still step onto the second one.
    for (const cand of [preferred, other]) {
      if (wallBlocksPath(world, tank, cand, AI_PATH_HORIZON_TICKS)) continue;
      if (mines.some((m) => vdot(cand, vsub(m.pos, tank.pos)) > 0)) continue;
      return cand;
    }
    // Both sides compromised: a wall-free dodge still moves the tank out of the corridor,
    // whereas a wall-pinned one moves it nowhere at all, so that is the better tie-break.
    for (const cand of [preferred, other]) {
      if (!wallBlocksPath(world, tank, cand, AI_PATH_HORIZON_TICKS)) return cand;
    }
    // Both perpendiculars walk into a wall, so settling for `preferred` here would be the
    // "accidental blocked heading" issue #224's third acceptance criterion rules out.
    return sidestepAroundBlockage(world, tank, dir, mines) ?? preferred;
  }

  if (mines.length > 0) {
    // Defensive only: bestEscapeDirection returns a wheel heading whenever ESCAPE_SAMPLES > 0,
    // even standing exactly on the only mine, where every direction scores 0.
    return bestEscapeDirection(world, tank, mines) ?? { x: 1, y: 0 };
  }
  return null;
}
