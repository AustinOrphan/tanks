// ---- Geometry ----
export type Vec2 = { x: number; y: number };

export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---- Walls ----
export type WallKind = 'solid' | 'destructible';

export interface Wall {
  id: number;
  aabb: AABB;
  kind: WallKind;
  destroyed: boolean;
}

// ---- Entities ----
export type BulletType = 'normal' | 'fast' | 'ricochet';
/**
 * What may detonate an UNARMED mine -- one dropped but not yet armed.
 *
 * `none` is the shipped rule and the safe one: arming (the owner stepping
 * clear) is what makes a mine dangerous. The others reintroduce the "instant
 * bomb" deliberately, for playtesting: a mine spawns at the owner's feet and
 * the blast reaches further than the trigger, so dropping one beside an enemy
 * can kill at range zero. When that shipped by accident it also made the AI
 * wipe itself out -- at the first live tick two enemies laid mines beside each
 * other and all three tanks died on the spot.
 *
 * Part of the WORLD, not a runtime flag: src/sim/ is pure and a replay must
 * stay an exact function of its inputs. A dev flag chooses what world is
 * created; the sim only ever reads this field.
 */
export type UnarmedTrigger = 'none' | 'proximity' | 'bullet' | 'both';

export type TankKind = 'player' | 'brown' | 'grey' | 'teal';
export type AiState = 'idle' | 'aim' | 'fire' | 'reposition';

export interface Spawn {
  kind: TankKind;
  pos: Vec2;
  angle: number;
}

export interface Tank {
  id: number;
  kind: TankKind;
  pos: Vec2;
  bodyAngle: number;
  turretAngle: number;
  alive: boolean;
  desiredMove: Vec2;
  activeMineIds: number[];
  /** Whole TICKS until ready, not seconds -- see FIRE_COOLDOWN_TICKS. */
  fireCooldown: number;
  /** Whole TICKS until ready, not seconds. */
  mineCooldown: number;
  aiState: AiState;
  aiTimer: number;
}

export interface Bullet {
  id: number;
  ownerId: number;
  type: BulletType;
  pos: Vec2;
  vel: Vec2;
  bouncesLeft: number;
  alive: boolean;
}

/**
 * A detonation in progress. Lives for MINE_BLAST_EXPAND_TICKS +
 * MINE_BLAST_HOLD_TICKS and kills whatever its edge reaches on the way out.
 */
export interface Blast {
  id: number;
  /** The mine that produced it, for attribution. */
  ownerId: number;
  pos: Vec2;
  /** Ticks since detonation; 0 on the tick it was created. */
  age: number;
}

export interface Mine {
  id: number;
  ownerId: number;
  pos: Vec2;
  timer: number;
  armed: boolean;
  detonated: boolean;
}

// move components in [-1,1] (not normalized); aim is a world-space ground point;
// fire/mine are edge-triggered (press-this-tick).
export interface InputState {
  move: Vec2;
  aim: Vec2;
  fire: boolean;
  mine: boolean;
}

// ---- Vec math ----
export function vadd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vsub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vscale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function vlen(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function vnorm(a: Vec2): Vec2 {
  const len = vlen(a);
  if (len === 0) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

export function vdot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function vdist(a: Vec2, b: Vec2): number {
  return vlen(vsub(a, b));
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

export function fromAngle(r: number): Vec2 {
  return { x: Math.cos(r), y: Math.sin(r) };
}

// Steps `current` toward `target` by at most `maxDelta` radians (`maxDelta` must be
// >= 0), taking the shortest arc across the +/-pi wrap. Mirrors lerpAngle's wrap
// correction in src/render/interpolate.ts, but advances by a fixed per-call budget
// instead of interpolating by a fraction `t` -- this is what gives a turret a finite
// turn rate instead of an instantaneous snap (see applyPlayerInput in world.ts and
// stepAi in ai/index.ts, the two places this is applied).
//
// Returns `target` exactly (no overshoot, no jitter at rest) once the remaining
// angular distance is <= maxDelta -- this is why a tank already facing its target
// does not jitter every tick.
//
// The antipodal case (exactly pi apart) is a genuine tie between the two equal-length
// arcs. As in lerpAngle, the wrap correction below only fires on strict inequality
// (`> pi` / `< -pi`), so a raw delta of exactly +pi or -pi is left unchanged. Which
// value that raw delta comes out to depends on the sign of (target - current), so the
// resolved direction is arbitrary but deterministic and stable call-to-call.
/**
 * Shortest signed angle from `current` to `target`, in (-PI, PI].
 *
 * Used to decide whether a hull should drive forwards or reverse: if the requested
 * heading is more than a quarter turn away, its opposite is nearer.
 */
export function angleDelta(current: number, target: number): number {
  const TWO_PI = Math.PI * 2;
  let delta = (target - current) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

export function slewAngle(current: number, target: number, maxDelta: number): number {
  const TWO_PI = Math.PI * 2;
  // NaN sink: without this, `Math.abs(NaN) <= maxDelta` is false and the fall-
  // through returns `current + Math.sign(NaN) * maxDelta` -- NaN. Once the
  // angle is NaN it stays NaN for the rest of the game, because every later
  // (good) target is subtracted from a NaN `current`. Hold the last good angle.
  if (!Number.isFinite(target)) return current;
  if (!Number.isFinite(current)) return target;
  let delta = (target - current) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ---- Deterministic PRNG (mulberry32) ----
// The ONLY source of randomness in sim/. Never use Math.random.
export function nextRng(seed: number): { value: number; seed: number } {
  const z = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(z ^ (z >>> 15), z | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { value, seed: z };
}
