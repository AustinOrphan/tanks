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
 * Deliberately reuses the geometry/threat-assessment helpers `src/sim/ai/*.ts` already
 * proved out for the enemy AI -- lineOfSight, aimLead, dangerAvoidMove, profileAimSpread,
 * profileHazardSpread -- rather than reimplementing them (see brown.ts/grey.ts/teal.ts,
 * which this mirrors in spirit). What it does not reuse is any of targeting.ts's
 * probabilistic helpers (wanderMove, aimJitter, mineInclination, seekMove's own draws,
 * estimationError): those are pure hashes of `world.seed`, and driving the player through
 * them would make its behaviour a function of the same seed the enemy AI draws from, the
 * coupling pacifist.test.ts's local PRNG exists to avoid. `decidePlayerInput` instead takes
 * its own injected `rnd` stream; `mulberry32` below is exported so the callers that drive
 * this bot share one implementation. Directive B's hazard estimation error rides that same
 * stream, drawn once per hazard-refresh window and held in `PlayerAiState`.
 */

/**
 * A tiny, fast, deterministic PRNG (mulberry32). NOT `Math.random` and NOT `Date.now` --
 * both are banned in src/sim/ by purity.test.ts, and this module lives there. Seeded
 * explicitly by the caller; same seed, same sequence, forever.
 */
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
 * The scratch state a real input device would keep between samples: how long a firing
 * solution has been held (mirrors Tank.aimTicks, which the enemy dispatcher owns for
 * enemies but never touches for the player -- see ai/index.ts's decideAi, which routes
 * the player straight to an inert decision) and the current wander heading/countdown.
 *
 * Threaded explicitly by the caller rather than mutated onto `world`: `step()` clones
 * its input and never mutates what it is given (see CLAUDE.md), and decidePlayerInput
 * holds itself to the same rule -- this state is the caller's object, not the sim's.
 */
export interface PlayerAiState {
  /** Consecutive ticks a firing solution (a visible enemy) has been held. */
  aimTicks: number;
  /** The current wander heading, radians. */
  wanderHeading: number;
  /** Ticks left before the wander heading (and the mine inclination) are redrawn. */
  wanderTicksLeft: number;
  /** This window's mine inclination -- drawn once per WANDER_TICKS window, like the AI. */
  mineInclined: boolean;
  /**
   * The committed movement heading and its remaining ticks (issue #222), the bot-player
   * mirror of `Tank.aiIntent`/`aiIntentTicks`. It lives HERE rather than on the tank
   * because this module is forbidden from writing to the world at all -- see this file's
   * "never writes to the world on ANY branch it can reach" test -- while `stepAi` writes
   * the enemy AI's copy straight onto the tank. Same `commitHeading` implementation,
   * different owner of the state.
   */
  intent: Vec2 | null;
  intentTicks: number;
  /**
   * The held hazard snapshot (issue #223), this file's answer to the enemy AI's
   * `perceiveHazards`. The three fields are drawn together and expire together.
   *
   * It lives in state rather than being re-derived because of the split this module's own
   * comment describes: the enemy side re-derives its snapshot from a pure hash of
   * `(world.seed, tank.id, bucket)`, while this bot deliberately does not key on `world.seed`
   * -- it draws from an injected `rnd` stream, which is linear and cannot be asked what it
   * said 20 ticks ago. Holding the answer is the only way to give this side the same "one
   * read per window" property, and #223 requires it: a per-tick draw is the frame-to-frame
   * noise the issue opens against, not a mistaken judgment.
   */
  hazardTicksLeft: number;
  /** This window's signed radius-estimation offset, world units. */
  hazardOffset: number;
  /** This window's awareness delay, whole ticks. */
  hazardDelayTicks: number;
}

export function createPlayerAiState(rnd: () => number): PlayerAiState {
  return {
    aimTicks: 0, wanderHeading: rnd() * Math.PI * 2, wanderTicksLeft: 0, mineInclined: false,
    intent: null, intentTicks: 0,
    // Zero ticks left, so the FIRST call draws rather than acting on a fabricated read.
    // The two values below are never consumed in that state; they are initialised anyway
    // because a partially-populated state object is a footgun for the next reader.
    hazardTicksLeft: 0, hazardOffset: 0, hazardDelayTicks: 0,
  };
}

// Movement-band tuning. The player's own resolved profile (STATIC_BASIC, shared with
// Brown) is a STATIONARY gunner's tuning -- preferredDistance 10 with minimumDistance 0
// and retreatChance 0, which a mobile consumer would read as "always close to point-blank,
// never give ground": exactly the ramming behaviour the issue asks us to avoid. Rather
// than consume those specific numbers in a context they were never meant for, these
// mirror teal's MOBILE_MINE_LAYER band (config/data/ai-profiles.json) -- the shipped
// archetype closest to what a mobile combatant driving itself should look like.
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
 * Directive A, part 2: whole-map awareness. `assessThreats` is the single bounded per-tick
 * pass over the opponents: one loop, no pairwise term.
 *
 * Carries only what has a real consumer: `engaged` with its `engagedInSight` flag (the one
 * opponent movement, mines, aim and fire all reason about -- issue #893) and `centroid` (the
 * retreat branch's whole-map answer to "which way is actually away"). Add a field only
 * alongside the consumer that needs it: a computed value with no consumer is untestable dead
 * weight, not scaffolding for later.
 */
interface ThreatSummary {
  /**
   * The one opponent this tick: nearest visible, or nearest outright when none is visible; a
   * versus bot's committed opponent instead. Every consumer reads this. See `assessThreats`
   * for why it is not two fields.
   */
  engaged: Tank | null;
  /**
   * Whether `engaged` is the one that can be seen, which is the only thing entitled to a
   * firing solution. False also when there are no opponents at all.
   */
  engagedInSight: boolean;
  /**
   * Centroid of every opponent's position, or null when there are none. Equal to the engaged
   * tank's position when there is exactly one opponent, so the retreat that reads it in place
   * of that position only diverges once a second opponent presses at the same time -- the
   * case directive A asks the movement band to handle differently.
   */
  centroid: Vec2 | null;
}

/**
 * The one opponent this tick, and everything the decision needs to know about it.
 *
 * Movement, the mine gate, aim, the reaction clock and fire all read `engaged`, so the bot
 * cannot drive at one tank while shooting at another (issue #893). Off the bot path it is
 * `nearestVisible ?? nearest`: where an opponent is visible, aim and fire see the nearest
 * visible one; where none is, `engagedInSight` is false and the bot holds fire.
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
  // a world built without `WorldForInit.bots` -- so off the bot path the branch below adds no
  // line-of-sight call and changes no behaviour.
  const committed = committedOpponent(world, subject);
  if (committed === null) {
    return { engaged: nearestVisible ?? nearest, engagedInSight: nearestVisible !== null, centroid };
  }
  return {
    engaged: committed,
    // The committed tank is entitled to a firing solution only if it can actually be seen.
    // `=== nearestVisible` is the free case; anything else costs one line-of-sight test,
    // because a commitment is deliberately HELD through a sight break (rule 7) and the tank
    // it is held to is therefore often not the visible one.
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
 * The baseline move when nothing more urgent (a dodge) overrides it: approach the
 * engaged opponent beyond PLAYER_PREFERRED_DISTANCE, retreat-by-draw inside
 * PLAYER_MINIMUM_DISTANCE, wander in the band -- the same three-way shape as
 * targeting.ts's seekMove, reimplemented against the injected `rnd` stream instead of
 * seekMove's world.seed-keyed hash (see the module comment for why).
 *
 * Also redraws the wander heading and the window's mine inclination together, once every
 * WANDER_TICKS ticks -- one cadence for both, rather than a separate clock for each.
 *
 * Directive A, part 2: the retreat branch pulls away from `threats.centroid`, not
 * `threats.engaged.pos` -- retreating from only the opponent you are engaging can walk the
 * player straight at a second one, and the centroid is the whole-map-aware answer to
 * "which way is actually away from the pressure" (see ThreatSummary's doc comment). The
 * approach band and the mine gate read `threats.engaged` directly instead, since driving at,
 * shooting at or mining one specific opponent is the thing issue #893 made them agree about;
 * the mass is a retreat question only.
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
  // The shared horizon probe (issue #224), so the bot player and the enemy AI vet a seek
  // heading against identical geometry over an identical horizon.
  return wallBlocksPath(world, player, dir, AI_PATH_HORIZON_TICKS, speed) ? wander : dir;
}

/**
 * Deterministic in `world`, `playerId`, `rnd` and the caller's own `state`: same inputs,
 * same InputState, every time. `world` is read, never mutated -- the scratch this function
 * updates lives in the caller-owned `state`, not on `world.tanks` -- so it holds to the same
 * "never mutate what you are given" rule `step()` itself follows for `world`.
 *
 * Behaviour, in priority order: dodge incoming shells / flee live mines (dangerAvoidMove,
 * the same shared geometry the enemy AI uses, fed a perceived radius/corridor and a
 * back-dated hazard picture drawn from `rnd` and held for the profile's hazard-refresh
 * window, never `world.seed`, so the player can misjudge a hazard exactly as an enemy can,
 * through its own stream rather than the shared one); otherwise keep a sensible distance
 * from the engaged opponent rather than ramming, retreating from the whole-map opponent
 * centroid once a second opponent is in play (see ThreatSummary); aim at the engaged
 * opponent while it is in sight, jittered by the player's own resolved profile's aimAccuracy
 * (STATIC_BASIC: 0.55, the same as Brown and below Grey's 0.6); fire only once that solution
 * has been held for the profile's own reactionTime (0.8s), so the player does not snap to a
 * frame-perfect shot the instant an enemy peeks a corner; occasionally lay a mine when an
 * enemy is close enough for one to matter.
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
  // Trailing and defaulted (issue #267): `normal` is the exact no-op, and
  // `withBotDifficulty` returns its input unchanged for it, so every call site that omits it
  // -- the autoplay dev flag, scenarios.ts, the measurement harnesses except
  // bot-difficulty.measure.test.ts (which passes presets to compare them) -- resolves the
  // authored config unchanged. In the game, only a versus bot slot passes anything else.
  difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
): InputState {
  const player = world.tanks.find((t) => t.id === playerId);
  if (!player || !player.alive) {
    return { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, mine: false };
  }

  // The authored profile, scaled on its COMPETENCE axes only. Applied here rather than at
  // each read site because `profileAimSpread`, `profileHazardSpread` and the reaction gate
  // all derive from `cfg.ai`, so one substitution at the source reaches every one of them
  // and no future read can miss it.
  const cfg = withBotDifficulty(configFor(player.kind), difficulty);

  // The one bounded per-tick pass (directive A, part 2) -- computed once and read by
  // movement, targeting and the mine gate below.
  const threats = assessThreats(world, player);

  // Directive B, widened to issue #223's whole hazard picture: the bot's own perceived
  // hazard state, drawn from the injected `rnd` stream (never `world.seed` -- see the
  // module comment) and held for `hazardRefreshTime`, the same competence axis the enemy
  // side buckets on. Every mine/dodge gate below reads the same window's belief, exactly as
  // grey.ts/teal.ts reuse one `perceiveHazards` snapshot across their sites.
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
  // The world this bot BELIEVES it is looking at: shells back-dated by its awareness delay,
  // mines it has not noticed yet absent. Identical to `world` at a zero delay, and used for
  // the hazard reads only -- targeting, line of sight and the movement band below still
  // read the real world, because difficulty may not reach those.
  const seen = backdateHazards(world, state.hazardDelayTicks);

  // ---- Movement: dodge overrides the band/wander baseline, never the reverse. ----
  const avoid = dangerAvoidMove(seen, player, fleeRadius, dangerCorridor);
  const candidate = avoid ?? seekLikeMove(world, player, rnd, state, threats);
  // The commitment layer (issue #222), shared with the enemy AI via `commitHeading`. A bot
  // driving a player slot reaches the same `dangerAvoidMove` geometry and so would show the
  // same tick-to-tick reversal; holding the heading here keeps a versus bot from jittering.
  // The held state is this caller's `PlayerAiState`, never the world (see that field's own
  // comment).
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

  // ---- Targeting: the opponent already resolved for this tick. ----
  // Aim and fire read the same `engaged` tank movement does (issue #893), and only while it
  // is in sight.
  const target: Tank | null = threats.engagedInSight ? threats.engaged : null;

  // No tank in sight: hold the current turret heading rather than snapping to some
  // default or firing on a wall (see this function's own doc comment for why not a wall).
  let aimPoint: Vec2;
  const hasSolution = target !== null;
  if (target) {
    const targetVel = driveVelocity(target);
    const lead = aimLead(player.pos, target.pos, targetVel, cfg.weapon.speed);
    // Jitter only the live solution, exactly as brown.ts/grey.ts/teal.ts document: a
    // held/passthrough angle must not drift with nothing to aim at.
    const jitter = (rnd() * 2 - 1) * profileAimSpread(cfg);
    const dir = fromAngle(lead + jitter);
    aimPoint = { x: player.pos.x + dir.x, y: player.pos.y + dir.y };
  } else {
    const dir = fromAngle(player.turretAngle);
    aimPoint = { x: player.pos.x + dir.x, y: player.pos.y + dir.y };
  }

  // The reaction clock: same shape as the enemy dispatcher's (ai/index.ts) aimTicks/
  // reactionTime gate, applied here instead since the player never passes through
  // decideAi/stepAi (idleDecision short-circuits kind === 'player').
  //
  // Gated on the live phase for the same reason and by the same rule as the enemy clock
  // (issue #367): a countdown is a phase in which nobody may fire, so time spent in it
  // must not satisfy a reaction requirement. world.ts already refuses the shot itself
  // during the countdown, which is why the clock needs its own gate: without it the
  // scripted player banks the whole countdown and is entitled to fire on the first live
  // tick. The phase, not "can I fire": see the enemy site's comment.
  state.aimTicks = roundPhase(world) === 'live' && hasSolution ? state.aimTicks + 1 : 0;
  const reactionTicks = Math.round(cfg.ai.reactionTime * TICK_HZ);
  const fire = hasSolution && state.aimTicks >= reactionTicks;

  // ---- Mines: only while not dodging, off cooldown, and actually near an enemy --
  // mirrors grey.ts/teal.ts's mineThreatensPlayer gate with the roles swapped (there is
  // no "mineThreatensNearestEnemy" in targeting.ts to reuse: that helper is hardcoded to
  // the player as the threatened party). This is oracle-knowledge site #5 (directive B):
  // an independently written parallel to targeting.ts's mine gates, not shared code, so
  // it draws its own perceived radii above (`fleeRadius`, `tacticalRadius`) rather than
  // calling estimationError (world.seed-keyed, enemy-only).
  //
  // Capped at one of the player's own active mines, not cfg.mineCapacity (2): at the
  // original 0.3 chance the cap cut arena-02's self-mine losses to 9 of 31 (see
  // PLAYER_MINE_CHANCE's comment for the failure and the method caveat). Also refuses to lay
  // any mine while already standing within the perceived flee radius of a live mine (own or
  // not) -- the same margin dangerAvoidMove flees to, so a mine is never dropped somewhere
  // the player's own (possibly mistaken) read says it would have to dodge again.
  const nearest = threats.engaged;
  // `seen`, not `world`: this is a hazard read, so it goes through the same believed picture
  // the dodge above did. A mine the bot has not noticed cannot be a reason not to lay one.
  const nearLiveMine = seen.mines.some(
    (m) => !m.detonated && vdist(player.pos, m.pos) <= fleeRadius,
  );
  // Also requires the enemy to be at a comfortable range, not point-blank -- a plausible
  // objection (don't mine while being pressed at close quarters) rather than a measured
  // fix: at 0.3 chance it left arena-02's share roughly where the cap alone did (11 vs 9
  // of 31). Kept on the same principle dangerAvoidMove already applies, not because it
  // was shown to reduce the residual named in PLAYER_MINE_CHANCE's comment.
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
