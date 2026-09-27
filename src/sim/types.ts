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
 * Part of the world, not a runtime flag: src/sim/ is pure and a replay must
 * stay an exact function of its inputs. A dev flag chooses what world is
 * created; the sim only ever reads this field.
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
 * rules (world.ts's `resolveStatusFfa`/`resolveStatusTeams`) -- see WorldRules.mode's own
 * doc comment for the dispatch.
 */
export type GameMode = 'campaign-coop' | 'ffa' | 'teams';

/**
 * How competent a computer opponent filling a versus player slot is.
 *
 * Defined here rather than in `ai/bot-difficulty.ts`, which owns everything else about it
 * (the offer order, the default, the guard, the competence table) and re-exports this name.
 * `Tank.botDifficulty` needs the type, and `ai/bot-difficulty.ts` reaches `config/types.ts`,
 * which imports this file -- so owning the type there and importing it here would close a
 * types -> ai -> config -> types cycle. TypeScript accepts a cycle of type imports silently,
 * which is why `dependency-direction.test.ts` exists.
 */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/**
 * The grid a world's walls were built from -- `cols`/`rows`/`cellSize`/`grid`/`legend`,
 * exactly the shape `arena.ts`'s own `Arena` interface carries (structurally identical,
 * deliberately not imported from there: `arena.ts` already imports `world.ts`, so the
 * reverse import would close a cycle).
 *
 * Every field is `readonly`: one object is shared by reference across every tick's clone
 * (`resolveWorldRules`'s freeze is shallow and does not reach it), so the type states what
 * the sharing already required.
 *
 * Carried on `World.rules` (`null` when no grid exists -- see `WorldRules.arenaGeometry`) because
 * `pickVersusSpawnCell` (`versus-spawns.ts`) needs the grid CHARACTERS themselves to
 * find an open-floor cell; `World.walls` alone cannot answer that, since it only carries
 * already-merged solid rectangles and per-cell destructible boxes -- a former enemy
 * spawn letter is real floor but produces no wall entry, so nothing in `Wall[]`
 * distinguishes "open floor" from "a letter that happens not to be a wall".
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
   * commitment remain (issue #222). Absent means nothing is held -- a fresh tank, or a
   * stationary one that never acquires an intent.
   *
   * Optional for the same reason `aimTicks` below is: every existing fixture that builds
   * a Tank by hand keeps compiling, and "no commitment yet" is genuinely the absence of a
   * value rather than a sentinel. Written back by `stepAi` from `AiDecision`, exactly like
   * `aiState`/`aiTimer` -- decisions stay pure, the dispatcher owns the write.
   *
   * Not part of the golden trace's fingerprint: `traceText` samples pos/turretAngle/alive
   * per tank, so these fields move `BASELINE_HASH` only through the behaviour they cause.
   */
  aiIntent?: Vec2;
  aiIntentTicks?: number;
  /**
   * The AI turret's angular VELOCITY, in radians per tick (issue #347). Carried between
   * ticks so the turret can accelerate and decelerate instead of only ever being stopped
   * or travelling at the full rate cap.
   *
   * Undefined means at rest. MUST be cleared when a tank respawns -- a tank that comes back
   * carrying the angular momentum it died with starts its next life mid-swing.
   */
  turretVel?: number;
  /**
   * The aim solution this tank has committed to, and the ticks left before it re-solves
   * (issue #344). The turret slews toward THIS rather than toward a freshly recomputed
   * aimLead every tick, so the gun settles and dwells instead of micro-correcting at 60Hz.
   * Undefined rather than a sentinel when nothing is held, so "no commitment" is genuinely
   * absent -- an angle of 0 is a real heading (due east), exactly as for aiIntent above.
   *
   * Written only by stepAi's dispatcher, from AiDecision.nextAimHeld/nextAimHeldTicks.
   */
  aiAimHeld?: number;
  aiAimHeldTicks?: number;
  /**
   * The last position at which this AI tank actually observed its committed target, and how
   * many ticks that memory has left (issue #372). Same optional pair shape as the fields
   * around it; absent means no remembered contact.
   *
   * A snapshot, never a reference to the target tank: the target keeps moving while unseen,
   * so remembering the tank would remember the present, which is the hidden state #372
   * forbids. Written only by ai/target-memory.ts's updateTargetMemory.
   */
  aiLastSeenPos?: Vec2;
  aiLastSeenTicks?: number;
  /**
   * The opponent this AI tank is committed to, and how many ticks that commitment has left
   * (issue #359). Same optional pair shape as aiAimHeld/aiAimHeldTicks above, and absent
   * means "nothing committed" -- an id of 0 is a real tank.
   *
   * Written only by ai/target-selection.ts's applyCommitment, which stepAi reaches once per
   * tank per tick before the decision runs: through commitTarget for an enemy, through
   * ai/bot-commitment.ts's commitBotTarget for a bot-driven player slot. AI decisions read it
   * through resolveOpponent (enemies) or committedOpponent (bots), never directly, so movement
   * and firing cannot end up on different opponents.
   */
  aiTargetId?: number;
  aiTargetTicks?: number;
  /**
   * Why this tank's committed opponent last changed, and how long ago (issue #359). Recorded
   * by applyCommitment, the single writer of aiTargetId, so the change and its cause cannot
   * disagree.
   *
   * Deterministic sim state rather than an event, for two reasons. It is a property of the
   * tank at a tick, so a trace that samples the world sees it for free and needs no new
   * channel; and adding a `SimEvent` would put a diagnostic on the stream that render,
   * audio and haptics all consume, which is a wide change for something only a developer
   * reads.
   *
   * `aiRetargetAgeTicks` counts up from the change and is not a countdown: it answers "how
   * recently", where `aiTargetTicks` already answers "how much longer". Both optional like
   * the pair above; absent means this tank has never chosen a target.
   */
  aiRetargetReason?: 'acquired' | 'target-lost' | 'switched-on-expiry';
  aiRetargetAgeTicks?: number;
  /**
   * Set on a `kind: 'player'` tank whose slot is filled by a computer opponent, and absent on
   * a human's (issue #891). The value is that bot's difficulty.
   *
   * One field, not two, deliberately. An `aiDriven` boolean beside a difficulty is two facts
   * that can disagree -- a slot marked driven with no difficulty, or a difficulty on a human's
   * tank -- and nothing in the type would catch either. Presence is drivenness, so the pair
   * cannot drift.
   *
   * Simulation state because `stepAi`, the one place entitled to write commitment state, has
   * to tell a bot from a human to give a versus bot a committed opponent. Stamped by
   * `loadArena` from `WorldForInit.bots`, the same per-slot path `teams` already takes.
   *
   * A plain string union, so it survives `cloneTank`'s spread, a seeded replay and any
   * serialisation without special handling.
   */
  botDifficulty?: BotDifficulty;
  /** The held bank-first/direct-first shot plan and its countdown (issue #332). */
  aiShotPlan?: 'bank' | 'direct';
  aiShotPlanTicks?: number;
  /**
   * Consecutive live-phase ticks the AI has held a firing solution (decision.hasSolution),
   * reset to 0 on any tick without one or outside the live phase. The dispatcher's reaction
   * gate compares this against the profile's reactionTime (seconds) before letting a shot
   * off. Optional so the many existing fixtures stay valid; absent means 0 (never held one).
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
   * question 2, the field route -- kind stays 'player' for every human-driven tank, so every
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
   * Per-tank respawn: the absolute tick (world.tick, not a countdown) this corpse revives
   * on. Set the tick a player-kind tank dies with a respawn still owed -- by
   * resolveStatusCoop's pool mode while the shared pool has lives left, and by
   * applyVersusStock while the tank has stock left (both world.ts) -- and cleared by the
   * stage that resolves it (stepRespawns, world.ts). An absolute tick, deliberately
   * mirroring world.roundStartTick's own convention rather than fireCooldown's
   * decrementing-counter one -- see the coop semantics plan
   * (docs/superpowers/plans/2026-08-15-coop-semantics.md) for why. OPTIONAL like
   * `controlledBy`: absent on every enemy always, and absent on every player-kind tank in a
   * single-player campaign world, so no existing fixture is affected by this field's mere
   * existence.
   */
  respawnAtTick?: number;
  /**
   * Post-respawn damage immunity and action lockout: the absolute tick (world.tick)
   * until which this tank cannot be killed (isDamageImmune below) and cannot fire or
   * lay a mine (isActionLocked below) -- movement and aim are not gated by this field,
   * only the two weapon triggers. Set only at the moment of revival (stepRespawns,
   * world.ts), for every per-tank respawn it handles: coop's shared-pool mode and versus's
   * stock respawns alike. No explicit clear, self-expires by comparison, the same idiom
   * round.ts's roundPhase already uses for elapsed-based checks. OPTIONAL for the same
   * reason as `respawnAtTick`.
   */
  shieldUntilTick?: number;
  /**
   * Versus's Smash-style life counter: how many more times this player-kind tank may
   * respawn after its current death. OPTIONAL like `team`: stamped only by `loadArena` when
   * `mode === 'ffa' || mode === 'teams'` (arena.ts's PASS 1a/1b), to the session's stock
   * (default `VERSUS_STOCK`, constants.ts) -- so every campaign-coop fixture, including a
   * full-object `toEqual`, is unaffected by this field's mere existence. A tank field rather
   * than a parallel `Map<tankId, number>` on `World`: it clones with the tank for free
   * (cloneWorld already deep-clones every `Tank`) and needs no id bookkeeping of its own.
   *
   * Decremented by `applyVersusStock` (world.ts) the tick a player-kind tank dies with
   * `respawnAtTick` still `undefined` (the same tally-once idempotency guard
   * `resolveStatusCoop`'s POOL MODE block already uses). A tank whose stock reaches 0 is
   * eliminated -- `!alive && (stockRemaining ?? 0) === 0`, see world.ts's
   * `isVersusEliminated` -- and stays down for the rest of the round; stock still
   * remaining schedules a respawn exactly like coop's pool. The `?? 0` fallback means a
   * hand-built fixture Tank that never sets this field reads as already at zero stock:
   * single-life FFA/teams behaviour for every test that does not opt in.
   */
  stockRemaining?: number;
  /**
   * This tank's active-shell budget, when a session overrides the roster's (issue #358).
   *
   * Absent is the shipped case and means "use `configFor(kind).weapon.maxActiveProjectiles`",
   * so every existing world, fixture and save is unchanged by this field's existence. It is
   * stamped at spawn, by `loadArena`, only when a session asks for the PP1 role-first arm --
   * today that is `?dev=1&pp1Roles=1` and nothing else.
   *
   * Per tank rather than per world or per module, following `stockRemaining` directly above:
   * an ordnance budget is a property of the tank that owns it, the firing refusal already
   * has the owner in hand, and a value stamped at spawn cannot drift from the tank it
   * belongs to. A module-level override would also have had to be readable from `src/sim/`,
   * which forbids runtime flags outright.
   */
  shellCap?: number;
  /**
   * This tank's active-mine budget, when a session overrides the roster's (issue #358).
   *
   * The exact counterpart of `shellCap` above, and absent is likewise the shipped case,
   * meaning "use `configFor(kind).mineCapacity`". Separate from `shellCap` rather than one
   * combined "ordnance" field because the two axes are approved independently and one of
   * them can be applied without the other -- Grey takes the shell arm but keeps its
   * authored mine capacity, since its approved mine direction is a placement policy.
   */
  mineCap?: number;
  /**
   * Which team this player-kind tank belongs to: the setup's per-slot choice
   * (`WorldForInit.teams`), else `teamOf(slot) = slot % 2` (arena.ts). OPTIONAL like
   * `controlledBy`/`respawnAtTick`: stamped only when `loadArena` is called with
   * `mode === 'teams'` (arena.ts's PASS 1a/1b), so every existing fixture -- including a
   * full-object `toEqual` at the shipped default `'campaign-coop'` -- is unaffected by this
   * field's mere existence. Never set on an enemy-kind tank: enemies do not spawn at all in
   * a versus mode (see loadArena), and campaign-coop's enemies have no team concept.
   *
   * Inert outside `'teams'` by construction. bullets.ts's and mines.ts's friendly-fire gates
   * (`WorldRules.friendlyFire` only matters once two tanks both carry a team) and
   * ai/targeting.ts's `isTargetable` require both tanks to carry one; ai/targeting.ts's
   * `isOpponent` and world.ts's `resolveStatusTeams` read it only in `'teams'` mode.
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
 * `shieldUntilTick` is only ever set by a per-tank respawn, which a single-player campaign
 * world never runs, so there the OR collapses to the `invincible` check alone.
 */
export function isDamageImmune(t: Tank, tick: number): boolean {
  return t.invincible === true || (t.shieldUntilTick !== undefined && tick < t.shieldUntilTick);
}

/**
 * Is this tank locked out of firing and mine-laying by its own post-respawn shield?
 *
 * A directive-scoped subset of the shield window, not the same question
 * `isDamageImmune` answers: `invincible` (the permanent dev playtest cheat) has no
 * bearing here at all -- an `?dev=1&invincible=1` player fights normally, it is only
 * damage that cannot touch it -- so this checks `shieldUntilTick` alone, never
 * `invincible`. Movement and aim are deliberately not gated by this: the directive is
 * "shots can't be fired and mines can't be placed... only movement [is unrestricted]",
 * a narrower lockout than the per-world round countdown/grace phase (round.ts's
 * `roundPhase`, which blocks movement too and applies to every tank at once) -- this is
 * per-tank and fires-only.
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
  /**
   * Ticks left in the PROXIMITY reaction delay (issue #275, owner-revised):
   * absent = not tripped (optional like Tank's flags, so existing mine fixtures
   * stay valid). Stamped once on proximity entry and only ever counted DOWN --
   * re-entry is a no-op, so the countdown cannot restart or shorten. Fuse and
   * shell triggers never touch it: fuse expiry detonates on its own schedule
   * (`timer`), a shell detonates immediately.
   */
  proximityDelayLeft?: number;
  /**
   * One-shot latch for the `mine-fuse-warning` event, fired when `timer` first
   * enters the final MINE_FUSE_WARNING_TICKS of the fuse. Event data only -- the
   * fuse's own expiry, not this flag, is what detonates.
   */
  fuseWarned?: boolean;
}

// move components in [-1,1] (not normalized); aim is a world-space ground point;
// fire/mine are edge-triggered (press-this-tick).
//
// One InputState is one player slot's intent for one tick -- a human's, or a bot's from
// decidePlayerInput. `stepInputs` (world.ts) takes a list of them and pairs entry i with the
// i-th `kind === 'player'` tank in tank-array order, so nothing here identifies its tank:
// the position in the list is the binding. `step(world, input)` is the one-argument adapter
// over that -- see world.ts.
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

// Steps `current` toward `target` by at most `maxDelta` radians (`maxDelta` must be
// >= 0), taking the shortest arc across the +/-pi wrap. Mirrors lerpAngle's wrap
// correction in src/render/interpolate.ts, but advances by a fixed per-call budget
// instead of interpolating by a fraction `t` -- this is what gives a finite turn rate
// instead of an instantaneous snap. Applied to the player turret (world.ts's driveTank)
// and to the hull (collision.ts's moveTank); the AI turret uses ai/turret-accel.ts's
// accelSlew instead.
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
// The world's seeded randomness. ai/player-profile.ts's `mulberry32` is the same algorithm as
// a stateful stream, for draws kept off `world.seed`. Never use Math.random.
export function nextRng(seed: number): { value: number; seed: number } {
  const z = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(z ^ (z >>> 15), z | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { value, seed: z };
}
