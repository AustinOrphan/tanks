import { detSin, detCos, detAtan2 } from './math/trig';

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

export type TankKind = 'player' | 'brown' | 'grey' | 'teal' | 'olive' | 'green' | 'yellow';
export type AiState = 'idle' | 'aim' | 'fire' | 'reposition';

/**
 * Which win/lose rule and which spawn set a world builds with -- the n-player arc's PR 4
 * (FFA + teams). `'campaign-coop'` is the shipped rule (default): enemies spawn, win is
 * "every non-player tank dead", `resolveStatusCoop` (world.ts) governs multi-player
 * life-sharing. `'ffa'` and `'teams'` strip enemies entirely (arena.ts's `loadArena`) and
 * replace win/lose with player-vs-player rules (world.ts's `resolveStatusFfa`/
 * `resolveStatusTeams`) -- see World.mode's own doc comment for the dispatch.
 */
export type GameMode = 'campaign-coop' | 'ffa' | 'teams';

/**
 * The grid a world's walls were built from -- `cols`/`rows`/`cellSize`/`grid`/`legend`,
 * exactly the shape `arena.ts`'s own `Arena` interface carries (structurally identical,
 * deliberately not imported from there: `arena.ts` already imports `world.ts`, so the
 * reverse import would close a cycle -- see `arena.ts`'s own comment on the analogous
 * `versus-spawns.ts` situation).
 *
 * Carried on `World` (optional -- see `World.arenaGeometry`) because
 * `pickVersusSpawnCell` (`versus-spawns.ts`) needs the grid CHARACTERS themselves to
 * find an open-floor cell; `World.walls` alone cannot answer that, since it only carries
 * already-merged solid rectangles and per-cell destructible boxes -- a former enemy
 * spawn letter is real floor but produces no wall entry, so nothing in `Wall[]`
 * distinguishes "open floor" from "a letter that happens not to be a wall".
 */
export interface ArenaGeometry {
  cols: number;
  rows: number;
  cellSize: number;
  grid: string[];
  legend: Record<string, WallKind>;
}

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
  /**
   * Consecutive ticks the AI has HELD a firing solution (decision.hasSolution),
   * reset the tick it loses one. The dispatcher's reaction gate compares this
   * against the profile's reactionTime before letting a shot off -- an enemy
   * must SEE you for reactionTime seconds before it may punish you. OPTIONAL so
   * the many existing fixtures stay valid; absent means 0 (never held one).
   */
  aimTicks?: number;
  /**
   * Weapons off: never fires, never lays a mine. OPTIONAL, so the dozens of existing
   * tank fixtures stay valid; absent means armed. Exists for the dev sandbox, where
   * enemies drive around as moving scenery -- it is world DATA, so replays stay exact
   * functions of their inputs.
   */
  disarmed?: boolean;
  /**
   * Cannot be killed: shells detonate on it harmlessly, blasts wash over it. OPTIONAL
   * like `disarmed`, and world data for the same reason -- replays stay exact functions
   * of their inputs. Set by the game layer on the PLAYER under ?dev=1&invincible=1.
   */
  invincible?: boolean;
  /**
   * Which input-list SLOT drives this tank, 0-based (docs/research/multiplayer.md open
   * question 2, route B -- kind stays 'player' for every human-driven tank, so every
   * `kind === 'player'` identity check in the tree still matches all of them). OPTIONAL
   * like `disarmed`/`invincible`, for the same reason: the many existing `kind: 'player'`
   * fixtures stay valid without an edit. Absent on every enemy, always. Present on a
   * player-kind tank only when `loadArena` was called with `playerCount > 1` -- at the
   * default `playerCount` of 1 it is never stamped, so every fixture built against
   * today's single-player output (including a full-object `toEqual`) is unaffected by
   * this field's existence, not merely tolerant of it. See arena.ts's `loadArena`.
   */
  controlledBy?: number;
  /**
   * Coop's per-tank respawn: the absolute tick (world.tick, not a countdown) this
   * corpse revives on. Set only by resolveStatus's coop branch (resolveStatusCoop,
   * world.ts) the tick a tracked player dies with lives still in the shared pool,
   * and cleared by the stage that resolves it (stepRespawns, world.ts). An absolute
   * tick, deliberately mirroring world.roundStartTick's own convention rather than
   * fireCooldown's decrementing-counter one -- see the coop semantics plan
   * (docs/superpowers/plans/2026-08-15-coop-semantics.md) for why. OPTIONAL like
   * `controlledBy`: absent on every enemy always, and absent on every player-kind
   * tank at playerCount 1, so no existing fixture is affected by this field's mere
   * existence.
   */
  respawnAtTick?: number;
  /**
   * Post-respawn damage immunity AND action lockout: the absolute tick (world.tick)
   * until which this tank cannot be killed (isDamageImmune below) and cannot fire or
   * lay a mine (isActionLocked below) -- movement and aim are NOT gated by this field,
   * only the two weapon triggers. Set only at the moment of revival (stepRespawns,
   * world.ts) for EVERY per-tank respawn stepRespawns handles -- coop's shared-pool
   * mode, and, since this field's own second reader was added, versus's per-tank
   * stock respawns too. No explicit clear, self-expires by comparison, the same idiom
   * round.ts's roundPhase already uses for elapsed-based checks. OPTIONAL for the same
   * reason as `respawnAtTick`.
   */
  shieldUntilTick?: number;
  /**
   * Versus's Smash-style life counter (n-player arc, stock PR): how many MORE times
   * this player-kind tank may respawn after its CURRENT death. OPTIONAL like `team`:
   * stamped only by `loadArena` when `mode === 'ffa' || mode === 'teams'` (arena.ts's
   * PASS 1a/1b), to `VERSUS_STOCK` (constants.ts) -- so every campaign-coop fixture,
   * including a full-object `toEqual`, is unaffected by this field's mere existence.
   * A TANK field rather than a parallel `Map<tankId, number>` on `World`: it clones with
   * the tank for free (cloneWorld already deep-clones every `Tank`) and needs no id
   * bookkeeping of its own.
   *
   * Decremented by `applyVersusStock` (world.ts) the tick a player-kind tank dies with
   * `respawnAtTick` still `undefined` (the same tally-once idempotency guard
   * `resolveStatusCoop`'s POOL MODE block already uses). A tank whose stock reaches 0 is
   * ELIMINATED -- `!alive && (stockRemaining ?? 0) === 0`, see world.ts's
   * `isVersusEliminated` -- and stays down for the rest of the round; stock still
   * remaining schedules a respawn exactly like coop's pool. The `?? 0` fallback means a
   * hand-built fixture Tank that never sets this field reads as "already at zero
   * stock" -- i.e. today's pre-stock single-life FFA/teams behaviour, unchanged for
   * every existing test that does not opt in.
   */
  stockRemaining?: number;
  /**
   * Which of the 2 alternating teams this player-kind tank belongs to, `teamOf(slot) =
   * slot % 2` (arena.ts). OPTIONAL like `controlledBy`/`respawnAtTick`: stamped ONLY when
   * `loadArena` is called with `mode === 'teams'` (arena.ts's PASS 1a/1b), so every
   * existing fixture -- including a full-object `toEqual` at the shipped default
   * `'campaign-coop'` -- is unaffected by this field's mere existence. Never set on an
   * enemy-kind tank: enemies do not spawn at all in a versus mode (see loadArena), and
   * campaign-coop's enemies have no team concept.
   *
   * Read in three places, all gated on `!== undefined` so the field is self-disabling
   * outside `'teams'` by construction, the same idiom `isDamageImmune` already uses for
   * `shieldUntilTick`: bullets.ts's and mines.ts's friendly-fire gate (`World.friendlyFire`
   * only matters once two tanks both carry a team), and `ai/player-profile.ts`'s
   * `isOpponent`.
   */
  team?: number;
}

/**
 * Is this tank immune to damage on the current tick?
 *
 * Two ways in: `invincible` (dev playtest mode, permanent for the tank's life) or a
 * live `shieldUntilTick` (post-respawn grace -- see world.ts's stepRespawns, which
 * stamps it for both coop's shared-pool respawns and versus's stock respawns).
 * Lives here, not in world.ts, for the same reason round.ts's own placement gives:
 * world.ts already imports bullets.ts/mines.ts, so a helper there importing back
 * would be circular.
 *
 * Replaces bullets.ts's and mines.ts's separate `t.invincible` checks -- both
 * already have `world` in scope at their call sites, so `world.tick` is available.
 * Value-identical at N=1: `shieldUntilTick` is only ever set by a per-tank respawn
 * stage, so it is always undefined in single-player, and the OR collapses to
 * today's `t.invincible` check exactly.
 */
export function isDamageImmune(t: Tank, tick: number): boolean {
  return t.invincible === true || (t.shieldUntilTick !== undefined && tick < t.shieldUntilTick);
}

/**
 * Is this tank locked out of FIRING and MINE-LAYING by its own post-respawn shield?
 *
 * A directive-scoped subset of the shield window, not the same question
 * `isDamageImmune` answers: `invincible` (the permanent dev playtest cheat) has no
 * bearing here at all -- an `?dev=1&invincible=1` player fights normally, it is only
 * damage that cannot touch it -- so this checks `shieldUntilTick` alone, never
 * `invincible`. Movement and aim are deliberately NOT gated by this: the directive is
 * "shots can't be fired and mines can't be placed... only movement [is unrestricted]",
 * a narrower lockout than the per-WORLD round countdown/grace phase (round.ts's
 * `roundPhase`, which blocks movement too and applies to every tank at once) -- this is
 * per-TANK and fires-only.
 *
 * Reuses `shieldUntilTick` rather than a second parallel timer: the brief window that
 * protects a freshly respawned tank from damage is the same window it may not act in.
 */
export function isActionLocked(t: Tank, tick: number): boolean {
  return t.shieldUntilTick !== undefined && tick < t.shieldUntilTick;
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
  /** The mine that produced it. */
  ownerId: number;
  /**
   * Who gets CREDIT for what this blast destroys, and by what instrument. Usually the
   * mine's owner via 'blast' -- but a mine detonated by a SHELL credits the shooter
   * via 'shell': shooting an enemy's mine to kill the tank beside it is a skill shot,
   * and filing it as the mine-owner's kill made the stats page call a player kill
   * "AI friendly fire" and score the killing shot as a miss.
   */
  credit: { source: 'shell' | 'blast'; ownerId: number };
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
//
// One InputState is ONE human's intent for ONE tick. `stepInputs` (world.ts) takes a
// LIST of them and pairs entry i with the i-th `kind === 'player'` tank in tank-array
// order, so nothing here identifies its tank: the position in the list is the binding.
// `step(world, input)` is the one-argument adapter over that -- see world.ts.
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
  return detAtan2(a.y, a.x);
}

export function fromAngle(r: number): Vec2 {
  return { x: detCos(r), y: detSin(r) };
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
