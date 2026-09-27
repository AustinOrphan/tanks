import type { World } from '../world';
import type { InputState, Tank, Vec2 } from '../types';
import { vsub, vdist, vnorm, vlen, fromAngle } from '../types';
import { lineOfSight, aimLead, dangerAvoidMove, incomingThreats, profileAimSpread, profileHazardSpread, wallBlocksPath, isOpponent } from './targeting';
import { backdateHazards, hazardRefreshTicks } from './hazard-perception';
import { commitHeading } from './commitment';
import { committedOpponent } from './bot-commitment';
import { driveVelocity } from '../collision';
import { configFor, hasAbility, TankAbility } from '../config';
import {
  TICK_HZ, WANDER_TICKS, SEEK_APPROACH_BIAS, VEC_EPS,
  AI_MINE_TACTICAL_RADIUS, AI_MINE_FLEE_RADIUS, DANGER_CORRIDOR, AI_PATH_HORIZON_TICKS,
} from '../constants';
import { roundPhase } from '../round';
import { withBotDifficulty, DEFAULT_BOT_DIFFICULTY, type BotDifficulty } from './bot-difficulty';

/**
 * A scripted "competent player": drives a player tank the way a decent human would, for
 * tests (a second headline metric alongside the pacifist harness), for demos (the `autoplay`
 * dev flag in game/loop.ts) and for versus bot slots.
 *
 * It does not reuse targeting.ts's probabilistic helpers (wanderMove, aimJitter,
 * mineInclination, seekMove's own draws, estimationError): those are pure hashes of
 * `world.seed`, and driving the player through them would make its behaviour a function of
 * the same seed the enemy AI draws from, the coupling pacifist.test.ts's local PRNG exists to
 * avoid. `decidePlayerInput` instead takes its own injected `rnd` stream.
 */

/** `Math.random` is banned in src/sim/ (purity.test.ts), hence a seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Caller-owned scratch, because decidePlayerInput never writes to the world (pinned by
 * player-profile.test.ts's "never writes to the world on ANY branch it can reach"). The enemy
 * AI keeps the equivalents on the tank -- `Tank.aimTicks`, `Tank.aiIntent`/`aiIntentTicks` --
 * but ai/index.ts never updates those for the player.
 */
export interface PlayerAiState {
  /** Consecutive live-phase ticks a firing solution (a visible enemy) has been held. */
  aimTicks: number;
  /** Radians. */
  wanderHeading: number;
  /** Ticks left before the wander heading (and the mine inclination) are redrawn. */
  wanderTicksLeft: number;
  mineInclined: boolean;
  /** Issue #222's committed movement heading, fed through the enemy AI's `commitHeading`. */
  intent: Vec2 | null;
  intentTicks: number;
  /**
   * The held hazard snapshot (issue #223), this file's answer to the enemy AI's
   * `perceiveHazards`. The three fields are drawn together and expire together.
   *
   * Held rather than re-derived: the enemy side re-derives its snapshot from a pure hash of
   * `(world.seed, tank.id, bucket)`, but an injected `rnd` stream is linear and cannot be
   * asked what it said earlier in the window. #223 requires one read per window: a per-tick
   * draw is the frame-to-frame noise the issue opens against, not a mistaken judgment.
   */
  hazardTicksLeft: number;
  /** Signed radius-estimation offset, world units. */
  hazardOffset: number;
  hazardDelayTicks: number;
}

export function createPlayerAiState(rnd: () => number): PlayerAiState {
  return {
    aimTicks: 0, wanderHeading: rnd() * Math.PI * 2, wanderTicksLeft: 0, mineInclined: false,
    intent: null, intentTicks: 0,
    // Zero ticks left, so the FIRST call draws rather than acting on a fabricated read.
    hazardTicksLeft: 0, hazardOffset: 0, hazardDelayTicks: 0,
  };
}

// Movement band. The player's own resolved profile (STATIC_BASIC, shared with Brown) is a
// STATIONARY gunner's tuning -- preferredDistance 10 with minimumDistance 0 and retreatChance
// 0, which a mobile consumer would read as "always close to point-blank, never give ground",
// i.e. ramming. These copy teal's MOBILE_MINE_LAYER band (config/data/ai-profiles.json)
// instead: the shipped archetype closest to a mobile combatant driving itself.
const PLAYER_PREFERRED_DISTANCE = 7.5;
const PLAYER_MINIMUM_DISTANCE = 4;
const PLAYER_RETREAT_CHANCE = 0.4;
/**
 * Per-window mine inclination. At grey/teal's shipped 0.3, 25 of 52 arena-02 losses were the
 * player's own mine (60 seeds x 4 shipped arenas, the measurement block in
 * player-profile.test.ts): unlike an enemy, the player has no reason to stand its ground near
 * a chokepoint it just mined, so it laid a second mine near a first still in flee range and
 * boxed itself in -- the failure targeting.ts's bestEscapeDirection doc measures for the AI.
 * The one-mine cap in decidePlayerInput's mine gate answers that.
 *
 * Lowering the chance (0.3 -> 0.12 -> 0.05, cap and range gates held constant) cut the
 * absolute count without closing the share of losses that are self-inflicted (29-36% either
 * way), consistent with a residual that is arena-02's geometry under pressure rather than raw
 * frequency: a mine detonates on MINE_TIMER regardless of arming, and a player forced to
 * dodge other fire in a tight arena can run out of ticks to clear AI_MINE_FLEE_RADIUS.
 *
 * Shipped at 0.05: rare enough to read as occasional rather than compulsive. The residual
 * self-mine risk is left in on purpose and held open by player-profile.test.ts's "does not
 * routinely kill itself with its own mine" assertion. The sim is deterministic but chaotic --
 * refusing one placement changes every later tick -- so per-gate deltas are directional
 * rather than attributable, and a behaviour change anywhere can move these numbers:
 * re-measure before trusting an old one.
 */
const PLAYER_MINE_CHANCE = 0.05;


/**
 * Directive A, part 2: whole-map awareness from one bounded per-tick pass over the opponents,
 * with no pairwise term.
 */
interface ThreatSummary {
  engaged: Tank | null;
  engagedInSight: boolean;
  centroid: Vec2 | null;
}

/**
 * Movement, the mine gate, aim, the reaction clock and fire all read `engaged`, so the bot
 * cannot drive at one tank while shooting at another (issue #893).
 *
 * `nearest` is deliberately not exposed. A second opinion available to a caller is how the
 * two derivations #893 fixed grew apart in the first place.
 */
function assessThreats(world: World, subject: Tank): ThreatSummary {
  let nearest: Tank | null = null;
  let nearestDist = Infinity;
  let nearestVisible: Tank | null = null;
  let nearestVisibleDist = Infinity;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (const t of world.tanks) {
    if (!isOpponent(world, subject, t)) continue;
    count += 1;
    sumX += t.pos.x;
    sumY += t.pos.y;
    const d = vdist(subject.pos, t.pos);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = t;
    }
    if (d < nearestVisibleDist && lineOfSight(subject.pos, t.pos, world.walls)) {
      nearestVisibleDist = d;
      nearestVisible = t;
    }
  }
  // Whole-map, deliberately, and not narrowed to `engaged` with the rest. This is the
  // retreat direction (`seekLikeMove`), and backing away from the one tank you are engaging
  // while reversing into the two behind you is worse than the defect #893 fixed.
  const centroid = count > 0 ? { x: sumX / count, y: sumY / count } : null;

  // Issue #891: a bot in a versus slot engages the opponent it is committed to, written by
  // `stepAi` one tick ago, rather than re-picking the nearest every tick. `committedOpponent`
  // returns null for anything that is not a bot-driven slot -- a human, and any player tank in
  // a world built without `WorldForInit.bots`.
  const committed = committedOpponent(world, subject);
  if (committed === null) {
    return { engaged: nearestVisible ?? nearest, engagedInSight: nearestVisible !== null, centroid };
  }
  return {
    engaged: committed,
    // A commitment is deliberately HELD through a sight break (rule 7), so the committed
    // tank is often not the visible one.
    engagedInSight:
      committed === nearestVisible || lineOfSight(subject.pos, committed.pos, world.walls),
    centroid,
  };
}

function blend(toward: Vec2, wander: Vec2): Vec2 {
  return vnorm({
    x: toward.x * SEEK_APPROACH_BIAS + wander.x * (1 - SEEK_APPROACH_BIAS),
    y: toward.y * SEEK_APPROACH_BIAS + wander.y * (1 - SEEK_APPROACH_BIAS),
  });
}

/**
 * targeting.ts's seekMove, reimplemented against the injected `rnd` stream (see the module
 * comment). Also redraws the window's mine inclination, on the wander cadence.
 */
function seekLikeMove(world: World, player: Tank, rnd: () => number, state: PlayerAiState, threats: ThreatSummary): Vec2 {
  if (state.wanderTicksLeft <= 0) {
    state.wanderHeading = rnd() * Math.PI * 2;
    state.mineInclined = rnd() < PLAYER_MINE_CHANCE;
    state.wanderTicksLeft = WANDER_TICKS;
  }
  state.wanderTicksLeft -= 1;
  const wander = fromAngle(state.wanderHeading);

  const nearest = threats.engaged;
  if (!nearest) return wander;

  const d = vdist(player.pos, nearest.pos);
  const speed = configFor(player.kind).movementSpeed;
  let dir: Vec2 | null = null;
  if (d > PLAYER_PREFERRED_DISTANCE) {
    dir = blend(vnorm(vsub(nearest.pos, player.pos)), wander);
  } else if (d < PLAYER_MINIMUM_DISTANCE) {
    if (rnd() < PLAYER_RETREAT_CHANCE) {
      const away = threats.centroid ?? nearest.pos;
      dir = blend(vnorm(vsub(player.pos, away)), wander);
    }
  }

  if (dir === null || vlen(dir) < VEC_EPS) return wander;
  return wallBlocksPath(world, player, dir, AI_PATH_HORIZON_TICKS, speed) ? wander : dir;
}

/**
 * Deterministic in `world`, `playerId`, `rnd` and the caller's own `state`. `world` is read,
 * never mutated; the scratch this function updates lives in `state`.
 *
 * With no tank in sight, this does not aim at or fire on a destructible wall in the way: a
 * shell never destroys one (only a mine blast does, mines.ts's `applyBlast`), so spending a
 * shell on it is strictly worse than holding fire -- it burns a
 * `weapon.maxActiveProjectiles` slot for nothing. The plan doc
 * (docs/superpowers/plans/2026-08-16-bot-competence.md) records the finding and names
 * mine-breaching, the mechanic that actually opens a destructible wall, as the follow-up.
 */
export function decidePlayerInput(
  world: World,
  playerId: number,
  rnd: () => number,
  state: PlayerAiState,
  // Issue #267: `withBotDifficulty` returns its input unchanged for the default, so a call
  // site that omits this resolves the authored config. In the game, only a versus bot slot
  // passes anything else.
  difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
): InputState {
  const player = world.tanks.find((t) => t.id === playerId);
  if (!player || !player.alive) {
    return { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, mine: false };
  }

  // Scaled here rather than at each read site because `profileAimSpread`,
  // `profileHazardSpread` and the reaction gate all derive from `cfg.ai`, so one substitution
  // at the source reaches every one of them and no future read can miss it.
  const cfg = withBotDifficulty(configFor(player.kind), difficulty);

  const threats = assessThreats(world, player);

  // Directive B / issue #223: one perceived hazard read per `hazardRefreshTime` window, so
  // every mine/dodge gate below reads the same window's belief.
  //
  // This is the difficulty-bearing site. `withBotDifficulty` is applied in this file and
  // nowhere else, because a versus bot fills a player slot -- campaign enemies resolve
  // `configFor(tank.kind)` with no preset. So all six competence axes have to reach a
  // decision here or the feature is a menu label: aimAccuracy, reactionTime and
  // estimationAccuracy reach aim, the reaction gate and the hazard spread, and this block
  // adds awarenessDelay, hazardRefreshTime and safetyMargin.
  if (state.hazardTicksLeft <= 0) {
    state.hazardOffset = (rnd() * 2 - 1) * profileHazardSpread(cfg);
    // Uniform on [0, awarenessDelay], matching `awarenessDelayTicks`'s enemy-side draw --
    // the profile's value is the worst case, not a flat handicap.
    state.hazardDelayTicks = Math.round(rnd() * cfg.ai.awarenessDelay * TICK_HZ);
    state.hazardTicksLeft = hazardRefreshTicks(cfg);
  }
  state.hazardTicksLeft -= 1;
  const hazardOffset = state.hazardOffset + cfg.ai.safetyMargin;
  const fleeRadius = AI_MINE_FLEE_RADIUS + hazardOffset;
  const dangerCorridor = DANGER_CORRIDOR + hazardOffset;
  const tacticalRadius = AI_MINE_TACTICAL_RADIUS + hazardOffset;
  // The world this bot BELIEVES it is looking at, for the hazard reads only -- targeting,
  // line of sight and the movement band below still read the real world, because difficulty
  // may not reach those.
  const seen = backdateHazards(world, state.hazardDelayTicks);

  // ---- Movement ----
  const avoid = dangerAvoidMove(seen, player, fleeRadius, dangerCorridor);
  const candidate = avoid ?? seekLikeMove(world, player, rnd, state, threats);
  // Issue #222: a bot driving a player slot reaches the same `dangerAvoidMove` geometry as
  // the enemy AI and so would show the same tick-to-tick reversal; holding the heading keeps a
  // versus bot from jittering.
  const avoidKind = avoid === null
    ? null
    : incomingThreats(seen, player, dangerCorridor).length > 0 ? 'bullet' as const : 'mine' as const;
  const committed = commitHeading(
    world, player, state.intent, state.intentTicks,
    Math.round(cfg.ai.commitmentTime * TICK_HZ), candidate, avoid, avoidKind,
  );
  state.intent = committed.nextIntent;
  state.intentTicks = committed.nextIntentTicks;
  const move = committed.move;

  // ---- Targeting ----
  const target: Tank | null = threats.engagedInSight ? threats.engaged : null;

  let aimPoint: Vec2;
  const hasSolution = target !== null;
  if (target) {
    const targetVel = driveVelocity(target);
    const lead = aimLead(player.pos, target.pos, targetVel, cfg.weapon.speed);
    // Jitter only the live solution: a held angle must not drift with nothing to aim at.
    const jitter = (rnd() * 2 - 1) * profileAimSpread(cfg);
    const dir = fromAngle(lead + jitter);
    aimPoint = { x: player.pos.x + dir.x, y: player.pos.y + dir.y };
  } else {
    const dir = fromAngle(player.turretAngle);
    aimPoint = { x: player.pos.x + dir.x, y: player.pos.y + dir.y };
  }

  // The reaction clock, mirroring the enemy one in ai/index.ts, including its live-phase gate
  // (issue #367): a countdown is a phase in which nobody may fire, so time spent in it
  // must not satisfy a reaction requirement. world.ts already refuses the shot itself
  // during the countdown, which is why the clock needs its own gate: without it the
  // scripted player banks the whole countdown and is entitled to fire on the first live
  // tick. The phase, not "can I fire": see the enemy site's comment.
  state.aimTicks = roundPhase(world) === 'live' && hasSolution ? state.aimTicks + 1 : 0;
  const reactionTicks = Math.round(cfg.ai.reactionTime * TICK_HZ);
  const fire = hasSolution && state.aimTicks >= reactionTicks;

  // ---- Mines ----
  // Mirrors grey.ts/teal.ts's mineThreatensPlayer gate with the roles swapped; that helper is
  // hardcoded to the player as the threatened party, so there is nothing to reuse. This is
  // oracle-knowledge site #5 (directive B), so it uses the perceived radii above rather than
  // estimationError (world.seed-keyed, enemy-only).
  //
  // Capped at one of the player's own active mines, not cfg.mineCapacity (2): at the
  // original 0.3 chance the cap cut arena-02's self-mine losses to 9 of 31 (see
  // PLAYER_MINE_CHANCE's comment for the failure and the method caveat). Also refuses to lay
  // any mine while already standing within the perceived flee radius of a live mine (own or
  // not) -- the same margin dangerAvoidMove flees to, so a mine is never dropped somewhere
  // the player's own (possibly mistaken) read says it would have to dodge again.
  const nearest = threats.engaged;
  // `seen`, not `world`: a mine the bot has not noticed cannot be a reason not to lay one.
  const nearLiveMine = seen.mines.some(
    (m) => !m.detonated && vdist(player.pos, m.pos) <= fleeRadius,
  );
  // The PLAYER_MINIMUM_DISTANCE floor (no mining while pressed at close quarters) is a
  // plausible objection rather than a measured fix: at 0.3 chance it left arena-02's share
  // roughly where the cap alone did (11 vs 9 of 31).
  const mine =
    hasAbility(player.kind, TankAbility.MINE_LAYER) &&
    state.mineInclined &&
    !avoid &&
    player.mineCooldown <= 0 &&
    player.activeMineIds.length < 1 &&
    !nearLiveMine &&
    nearest !== null &&
    vdist(player.pos, nearest.pos) >= PLAYER_MINIMUM_DISTANCE &&
    vdist(player.pos, nearest.pos) <= tacticalRadius;

  return { move, aim: aimPoint, fire, mine };
}
