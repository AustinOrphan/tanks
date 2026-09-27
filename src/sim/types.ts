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
 * What may detonate an unarmed mine -- one dropped but not yet armed.
 *
 * `none` is the shipped rule and the safe one: arming (the owner stepping
 * clear) is what makes a mine dangerous. The others reintroduce the "instant
 * bomb" deliberately, for playtesting: a mine spawns at the owner's feet and
 * the blast reaches further than the trigger, so dropping one beside an enemy
 * can kill at range zero.
 *
 * A dev flag (game/devflags.ts's `mineTrigger`) chooses the value a world is created
 * with; src/sim/ only ever reads this field, never a live flag.
 */
export type UnarmedTrigger = 'none' | 'proximity' | 'bullet' | 'both';

/**
 * How much of the board an AI may consider when choosing WHO to fight (issue #359).
 *
 * `'full'` -- any live opponent, matching what the player can see. The shipped default.
 * `'line-of-sight'` -- only opponents it currently perceives, behind `?dev=1&aiPerception=los`.
 *
 * A SELECTION policy, not a firing one: aiming still requires a real line of sight either way.
 */
export type AiTargetPerception = 'full' | 'line-of-sight';

export type TankKind = 'player' | 'brown' | 'grey' | 'teal' | 'olive' | 'green' | 'yellow';
export type AiState = 'idle' | 'aim' | 'fire' | 'reposition';

/**
 * Which win/lose rule and which spawn set a world builds with. `'campaign-coop'` is the
 * shipped rule (default): enemies spawn, win is "every non-player tank dead",
 * `resolveStatusCoop` (world.ts) governs multi-player life-sharing. `'ffa'` and `'teams'`
 * strip enemies entirely (arena.ts's `loadArena`) and replace win/lose with player-vs-player
 * rules (world.ts's `resolveStatusFfa`/`resolveStatusTeams`).
 */
export type GameMode = 'campaign-coop' | 'ffa' | 'teams';

/**
 * How competent a computer opponent filling a versus player slot is.
 *
 * Defined here rather than in `ai/bot-difficulty.ts`, which owns everything else about it
 * and re-exports this name: `ai/bot-difficulty.ts` reaches `config/types.ts`, which imports
 * this file, so owning the type there would close a types -> ai -> config -> types cycle.
 * TypeScript accepts a cycle of type imports silently.
 */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/**
 * The grid a world's walls were built from: structurally the same as `arena.ts`'s `Arena`,
 * deliberately not imported from there, because `arena.ts` already imports `world.ts` and
 * the reverse import would close a cycle.
 *
 * Every field is `readonly` because one object is shared by reference across every tick's
 * clone, and `resolveWorldRules`'s freeze is shallow and does not reach it.
 *
 * `pickVersusSpawnCell` (`versus-spawns.ts`) needs the grid CHARACTERS to find an open-floor
 * cell: `World.walls` cannot tell open floor from a former enemy spawn letter, which is real
 * floor but produces no wall entry.
 */
export interface ArenaGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly grid: readonly string[];
  readonly legend: Readonly<Record<string, WallKind>>;
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
   * The movement heading this AI tank has committed to, and how many ticks of that
   * commitment remain (issue #222). Absent means nothing is held. Written back by `stepAi`
   * from `AiDecision`, like `aiState`/`aiTimer`: decisions stay pure, the dispatcher owns the
   * write.
   *
   * Not part of the golden trace's fingerprint: `traceText` samples pos/turretAngle/alive
   * per tank, so these fields move `BASELINE_HASH` only through the behaviour they cause.
   */
  aiIntent?: Vec2;
  aiIntentTicks?: number;
  /**
   * The AI turret's angular VELOCITY, in radians per tick (issue #347). Undefined means at
   * rest. MUST be cleared when a tank respawns -- a tank that comes back carrying the angular
   * momentum it died with starts its next life mid-swing.
   */
  turretVel?: number;
  /**
   * The aim solution this tank has committed to, and the ticks left before it re-solves
   * (issue #344), so the gun settles and dwells instead of micro-correcting at 60Hz.
   * Undefined when nothing is held: an angle of 0 is a real heading (due east). Written only
   * by stepAi's dispatcher.
   */
  aiAimHeld?: number;
  aiAimHeldTicks?: number;
  /**
   * The last position at which this AI tank actually observed its committed target, and how
   * many ticks that memory has left (issue #372); absent means no remembered contact.
   *
   * A snapshot, never a reference to the target tank: the target keeps moving while unseen,
   * so remembering the tank would remember the present, which is the hidden state #372
   * forbids. Written only by ai/target-memory.ts's updateTargetMemory.
   */
  aiLastSeenPos?: Vec2;
  aiLastSeenTicks?: number;
  /**
   * The opponent this AI tank is committed to, and how many ticks that commitment has left
   * (issue #359). Absent means nothing committed; an id of 0 is a real tank.
   *
   * Written only by ai/target-selection.ts's applyCommitment. AI decisions read it through
   * resolveOpponent (enemies) or committedOpponent (bots), never directly, so movement and
   * firing cannot end up on different opponents.
   */
  aiTargetId?: number;
  aiTargetTicks?: number;
  /**
   * Why this tank's committed opponent last changed, and how long ago (issue #359). Recorded
   * by applyCommitment, the single writer of aiTargetId, so the change and its cause cannot
   * disagree.
   *
   * Sim state rather than a `SimEvent`: a trace that samples the world sees it for free, and
   * an event would put a developer-only diagnostic on the stream render, audio and haptics
   * all consume.
   *
   * `aiRetargetAgeTicks` counts UP from the change, not down. Absent means this tank has
   * never chosen a target.
   */
  aiRetargetReason?: 'acquired' | 'target-lost' | 'switched-on-expiry';
  aiRetargetAgeTicks?: number;
  /**
   * Set on a `kind: 'player'` tank whose slot is filled by a computer opponent, and absent on
   * a human's (issue #891). One field rather than an `aiDriven` boolean beside a difficulty,
   * which could disagree: presence is drivenness.
   *
   * Simulation state because `stepAi` has to tell a bot from a human to give a versus bot a
   * committed opponent. Stamped by `loadArena` from `WorldForInit.bots`.
   */
  botDifficulty?: BotDifficulty;
  aiShotPlan?: 'bank' | 'direct';
  aiShotPlanTicks?: number;
  /**
   * Consecutive live-phase ticks the AI has held a firing solution (decision.hasSolution),
   * reset to 0 on any tick without one or outside the live phase. The dispatcher's reaction
   * gate compares this against the profile's reactionTime (seconds) before letting a shot
   * off. Absent means 0.
   */
  aimTicks?: number;
  /**
   * Weapons off: never fires, never lays a mine; absent means armed. For the dev sandbox,
   * where enemies drive around as moving scenery.
   */
  disarmed?: boolean;
  /**
   * Cannot be killed: shells detonate on it harmlessly, blasts wash over it. Set by the game
   * layer on the PLAYER under ?dev=1&invincible=1.
   */
  invincible?: boolean;
  /**
   * Which input-list SLOT drives this tank, 0-based (docs/research/multiplayer.md open
   * question 2); `kind` stays 'player' for every human-driven tank. Absent on every enemy.
   * Stamped by `loadArena` only when `playerCount > 1`, so single-player output (including a
   * full-object `toEqual`) is unchanged by this field.
   */
  controlledBy?: number;
  /**
   * Per-tank respawn: the absolute tick (world.tick, not a countdown) this corpse revives on.
   * Set the tick a player-kind tank dies with a respawn still owed -- by resolveStatusCoop's
   * pool mode and by applyVersusStock (both world.ts) -- and cleared by stepRespawns.
   * Absolute like world.roundStartTick rather than decrementing like fireCooldown; the coop
   * semantics plan (docs/superpowers/plans/2026-08-15-coop-semantics.md) says why. Absent on
   * every enemy and in a single-player campaign world.
   */
  respawnAtTick?: number;
  /**
   * Post-respawn damage immunity and weapon lockout until this absolute tick (isDamageImmune
   * and isActionLocked below); movement and aim are not gated. Set only at revival
   * (stepRespawns, world.ts), for coop pool and versus stock respawns alike. No explicit
   * clear: it expires by comparison.
   */
  shieldUntilTick?: number;
  /**
   * Versus's Smash-style life counter: how many more times this player-kind tank may respawn
   * after its current death. Stamped only by `loadArena` in `'ffa'`/`'teams'`, to the
   * session's stock (default `VERSUS_STOCK`, constants.ts). A tank field rather than a
   * `Map<tankId, number>` on `World`, so it clones with the tank.
   *
   * Decremented by `applyVersusStock` (world.ts) the tick the tank dies with `respawnAtTick`
   * still `undefined`. At 0 the tank is eliminated for the round (world.ts's
   * `isVersusEliminated`), whose `?? 0` makes a fixture that never sets this single-life.
   */
  stockRemaining?: number;
  /**
   * This tank's active-shell budget, when a session overrides the roster's (issue #358).
   * Absent means `configFor(kind).weapon.maxActiveProjectiles`. Stamped at spawn by
   * `loadArena`, today only under `?dev=1&pp1Roles=1`.
   *
   * Per tank because the firing refusal already has the owner in hand, and a module-level
   * override would have to be a runtime flag readable from `src/sim/`.
   */
  shellCap?: number;
  /**
   * The mine counterpart of `shellCap`: absent means `configFor(kind).mineCapacity`.
   * Separate because the two axes are approved independently -- Grey takes the shell arm but
   * keeps its authored mine capacity.
   */
  mineCap?: number;
  /**
   * The setup's per-slot choice (`WorldForInit.teams`), else `teamOf(slot) = slot % 2`
   * (arena.ts). Stamped only when `loadArena` runs in `'teams'` mode, and never on an enemy.
   *
   * Inert outside `'teams'` by construction: bullets.ts's and mines.ts's friendly-fire gates
   * and ai/targeting.ts's `isTargetable` require both tanks to carry one; ai/targeting.ts's
   * `isOpponent` and world.ts's `resolveStatusTeams` read it only in `'teams'` mode.
   */
  team?: number;
}

/**
 * Lives here, not in world.ts: world.ts already imports bullets.ts/mines.ts, so a helper
 * there imported back by them would be circular.
 */
export function isDamageImmune(t: Tank, tick: number): boolean {
  return t.invincible === true || (t.shieldUntilTick !== undefined && tick < t.shieldUntilTick);
}

/**
 * Deliberately ignores `invincible`: an `?dev=1&invincible=1` player fights normally, only
 * damage cannot touch it. Movement and aim are not gated: this locks only shots and mines,
 * per tank, unlike round.ts's `roundPhase`, which blocks movement too for every tank.
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

export interface Blast {
  id: number;
  /** The owner of the mine that produced it. */
  ownerId: number;
  /**
   * Who gets CREDIT for what this blast destroys. Usually the mine's owner via 'blast', but a
   * mine detonated by a SHELL credits the shooter via 'shell': shooting an enemy's mine to
   * kill the tank beside it is a skill shot, and crediting the mine's owner made the stats
   * page call it "AI friendly fire" and score the killing shot as a miss.
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
  /**
   * Ticks left in the PROXIMITY reaction delay (issue #275); absent = not tripped. Stamped
   * once on proximity entry and only ever counted DOWN -- re-entry is a no-op, so the
   * countdown cannot restart or shorten. Fuse and shell triggers never touch it.
   */
  proximityDelayLeft?: number;
  /**
   * One-shot latch for the `mine-fuse-warning` event, fired when `timer` first enters the
   * final MINE_FUSE_WARNING_TICKS of the fuse. The fuse's expiry, not this flag, detonates.
   */
  fuseWarned?: boolean;
}

// move components in [-1,1] (not normalized); aim is a world-space ground point;
// fire/mine are edge-triggered (press-this-tick).
//
// One InputState is one player slot's intent for one tick. `stepInputs` (world.ts) pairs
// entry i with the i-th `kind === 'player'` tank in tank-array order, so the position in the
// list is the binding.
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

/**
 * Shortest signed angle from `current` to `target`, in [-PI, PI]: a difference of exactly
 * -PI or +PI is returned unchanged, so both ends are reachable.
 */
export function angleDelta(current: number, target: number): number {
  const TWO_PI = Math.PI * 2;
  let delta = (target - current) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

// `maxDelta` must be >= 0. The AI turret uses ai/turret-accel.ts's accelSlew instead.
//
// The antipodal case (exactly pi apart) is a tie: the wrap correction fires only on strict
// inequality, so the direction follows the sign of (target - current) -- arbitrary but
// deterministic and stable call-to-call.
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
// ai/player-profile.ts's `mulberry32` is the same algorithm as a stateful stream, for draws
// kept off `world.seed`.
export function nextRng(seed: number): { value: number; seed: number } {
  const z = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(z ^ (z >>> 15), z | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { value, seed: z };
}
