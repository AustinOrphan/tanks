import type { World } from '../world';
import type { InputState, Tank, Vec2 } from '../types';
import { vsub, vdist, vnorm, vlen, fromAngle } from '../types';
import { lineOfSight, aimLead, dangerAvoidMove, incomingThreats, profileAimSpread, profileHazardSpread } from './targeting';
import { commitHeading } from './commitment';
import { driveVelocity, circleVsAABB } from '../collision';
import { configFor, hasAbility, TankAbility } from '../config';
import {
  TANK_RADIUS, DT, TICK_HZ, WANDER_TICKS, SEEK_APPROACH_BIAS, VEC_EPS,
  AI_MINE_TACTICAL_RADIUS, AI_MINE_FLEE_RADIUS, DANGER_CORRIDOR,
} from '../constants';

/**
 * A scripted "competent player": drives the PLAYER tank the way a decent human would,
 * for tests (a second headline metric alongside the pacifist harness) and for demos
 * (the `autoplay` dev flag in game/loop.ts).
 *
 * Deliberately reuses the geometry/threat-assessment helpers `src/sim/ai/*.ts` already
 * proved out for the enemy AI -- lineOfSight, aimLead, dangerAvoidMove, profileAimSpread,
 * profileHazardSpread -- rather than reimplementing them (see brown.ts/grey.ts/teal.ts,
 * which this mirrors in spirit). What it does NOT reuse is any of targeting.ts's
 * PROBABILISTIC helpers (wanderMove, aimJitter, mineInclination, seekMove's own draws,
 * estimationError): those are pure hashes of `world.seed`, and driving the player through
 * them would mean the player's behaviour is a function of the exact same seed the enemy AI
 * draws from -- change one enemy's profile in a way that shifts how many `nextRng` calls
 * happen before tick T (it never does today, since the hashes are keyed by tick bucket,
 * not call count -- but relying on that is exactly the kind of coupling the pacifist
 * harness's comment warns against) and you would be at risk of silently perturbing the
 * very thing engagement.measure.test.ts and pacifist.test.ts measure. `decidePlayerInput`
 * instead takes its own injected `rnd` stream, precisely mirroring pacifist.test.ts's
 * local `mulberry` PRNG -- see `mulberry32` below, exported so the test file and the
 * game's `autoplay` dev-flag wiring share one implementation instead of three copies of
 * the same 6 lines. Directive B's estimation error rides that same injected stream (a
 * fresh `rnd()` draw per tick, mirroring `profileHazardSpread`'s enemy-side shape but
 * with no `world.seed`-keyed bucket to re-derive from -- see decidePlayerInput's own
 * comment for why per-tick, not per-window, is this file's equivalent).
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
}

export function createPlayerAiState(rnd: () => number): PlayerAiState {
  return {
    aimTicks: 0, wanderHeading: rnd() * Math.PI * 2, wanderTicksLeft: 0, mineInclined: false,
    intent: null, intentTicks: 0,
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
 * Per-window mine inclination. Measured (60 seeds x 4 shipped arenas, headless harness
 * in player-profile.test.ts's measurement block) at grey/teal's shipped 0.3: 25 of 52
 * arena-02 LOSSES were the player's own mine, because unlike an enemy the player has no
 * reason to stand its ground near a chokepoint it just mined -- it was laying a second
 * mine near a first still in flee range and boxing itself in, the same failure mode
 * targeting.ts's bestEscapeDirection doc measures for the AI ("24 of 26 own-mine AI
 * deaths had both mines in flee range"). Capping the player at ONE active mine (below,
 * `activeMineIds.length < 1`) cut that to 9 of 31 arena-02 losses.
 *
 * NOTE ON METHOD: the sim is deterministic but chaotic -- refusing one mine placement
 * changes the world from that tick on, so later ticks are a genuinely different game,
 * not the same game minus one mine. Adding the minimum-range gate (below) on top of the
 * cap moved arena-02's count to 11 of 31, i.e. the WRONG direction for a strictly more
 * restrictive gate, which is only possible because of that path divergence, not because
 * the gate made anything more dangerous. So the per-gate deltas below are directional,
 * not attributable to a single cause in isolation.
 *
 * Dropping the chance further (0.3 -> 0.12 -> 0.05, cap and both range gates held
 * constant) lowered the ABSOLUTE count (minesPerGame ~11.6 -> ~7.7 at arena-02) without
 * closing the PROPORTION of losses that are self-inflicted (9/31 -> 9/25, 29-36% either
 * way) -- consistent with a residual that is arena-02's geometry under pressure (a mine
 * detonates on MINE_TIMER regardless of arming, and a player repeatedly forced to dodge
 * OTHER incoming fire in a tight arena can run out of clear ticks to clear
 * AI_MINE_FLEE_RADIUS before it goes off) rather than raw frequency -- though with only
 * three chance values tried, "consistent with" is as far as this evidence goes.
 *
 * Shipped at 0.05: rare enough to read as occasional rather than compulsive. The last
 * figure taken from the 60-seed measurement harness was minesPerGame 1.73-7.15 across
 * the 5 arenas, with directive A part 1 (destructible-wall shots, since stripped -- see
 * decidePlayerInput's doc comment) and part 2 (centroid retreat) both active; that
 * range itself had moved from an earlier 1.6-7.7-across-4-arenas figure measured before
 * arena-05 shipped, a population change more than a behavior one. NOT re-measured again
 * at that 60-seed population after part 1 was stripped -- the sim is deterministic but
 * chaotic (see the NOTE ON METHOD above), so a behavior change anywhere can move a
 * downstream number like this one even when it is not the gate that changed; the pinned
 * 25-seed population WAS re-measured post-strip (player-profile.test.ts's own comment
 * block) and its mines/game range moved too (1.52-8.00 -> 1.44-7.80), which is the
 * concrete evidence that "unrelated behavior changed, so re-check before trusting an
 * old number" is not just a caveat here. With the residual self-mine risk left in on
 * purpose -- see player-profile.test.ts's pinned self-mine-share assertion, which is
 * the honest way to hold this open rather than papering over it.
 */
const PLAYER_MINE_CHANCE = 0.05;

/**
 * True if `other` should be treated as an opponent of `subject` -- the single predicate
 * both `nearestEnemy`'s positional scan and the LOS target-acquisition loop hardcoded
 * separately (`t.kind === 'player'` / `!== 'player'`, both gated on `t.alive`).
 *
 * Mode-aware (n-player arc PR 4 -- the seam PR 2b built for exactly this). This is the
 * fix that lets a BOT actually fight in FFA/teams -- without it, a bot dropped into a
 * versus match finds zero targets under the old kind-only rule and just wanders (caught
 * before PR 4 was written, named in its design doc, not discovered after shipping).
 *
 *  - `'campaign-coop'`: today's rule, byte-for-byte -- every non-player-kind, alive tank
 *    is an opponent. Multiplayer teammates (any OTHER player-kind tank) never fight each
 *    other here.
 *  - `'ffa'`: any OTHER alive player-kind tank (`other.id !== subject.id`) -- there are
 *    no enemy-kind tanks in this mode at all (loadArena strips them), so the predicate's
 *    whole job shifts from "not a teammate" to "not myself".
 *  - `'teams'`: any OTHER alive player-kind tank on a DIFFERENT team
 *    (`other.team !== subject.team`). `Tank.team` is only ever stamped when
 *    `mode === 'teams'` (arena.ts), so both sides are always defined here in real play.
 *
 * Named `subject`, not `self`: purity.test.ts's guard flags any bare `self.`/`self[` as
 * the DOM/worker global by regex, not by scope, so a LOCAL `self` parameter that is ever
 * dotted (`self.pos`) is a real false positive there, not a hypothetical one --
 * confirmed by running into it while writing this function's first draft.
 */
function isOpponent(world: World, subject: Tank, other: Tank): boolean {
  if (!other.alive) return false;
  switch (world.mode) {
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
 * Directive A, part 2: whole-map awareness. `world.walls`/`world.tanks`/`world.mines`
 * were already handed to this file in full -- the gap was never what it's GIVEN, only
 * what it COMPUTES from that, which used to be nearest-only. `assessThreats` is the
 * single bounded per-tick pass that replaces the old standalone `nearestEnemy` scan:
 * one O(tanks) loop, no pairwise term, so folding it into `decidePlayerInput` keeps the
 * whole function O(tanks+mines+walls) per tick, the order it already was.
 *
 * Carries only what has a real consumer today: `nearest` (the movement band and the
 * mine gate both still reason about ONE specific opponent) and `centroid` (the retreat
 * branch's whole-map answer to "which way is actually away"). Second-nearest and a bare
 * opponent count were part of an earlier draft and were cut before landing -- nothing
 * in this file ever read them, and a computed value with no consumer is untestable dead
 * weight, not scaffolding for later; add them back only alongside the consumer that
 * needs them.
 */
interface ThreatSummary {
  /** Same tank the old nearestEnemy(world, subject) returned. */
  nearest: Tank | null;
  /**
   * Centroid of every opponent's position, or null when there are none. Equal to
   * `nearest.pos` when there is exactly one opponent -- every consumer that reads this
   * in place of `nearest.pos` is UNCHANGED in the single-opponent case, and only
   * diverges once a second opponent presses at the same time, which is exactly the
   * case directive A asks the movement band to handle differently.
   */
  centroid: Vec2 | null;
}

function assessThreats(world: World, subject: Tank): ThreatSummary {
  let nearest: Tank | null = null;
  let nearestDist = Infinity;
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
  }
  return {
    nearest,
    centroid: count > 0 ? { x: sumX / count, y: sumY / count } : null,
  };
}

/** True if stepping one tick along `dir` at `speed` would put the tank's hull inside a
 *  wall. Mirrors targeting.ts's private wallBlocksStep (not exported there), so a seek
 *  direction that would net zero displacement falls back to wander here exactly as it
 *  does for the enemy AI. */
function wallBlocksStep(world: World, tank: Tank, dir: Vec2, speed: number): boolean {
  const probe = { x: tank.pos.x + dir.x * speed * DT, y: tank.pos.y + dir.y * speed * DT };
  for (const w of world.walls) {
    if (w.destroyed) continue;
    if (circleVsAABB(probe, TANK_RADIUS, w.aabb).hit) return true;
  }
  return false;
}

function blend(toward: Vec2, wander: Vec2): Vec2 {
  return vnorm({
    x: toward.x * SEEK_APPROACH_BIAS + wander.x * (1 - SEEK_APPROACH_BIAS),
    y: toward.y * SEEK_APPROACH_BIAS + wander.y * (1 - SEEK_APPROACH_BIAS),
  });
}

/**
 * The baseline move when nothing more urgent (a dodge) overrides it: approach the
 * nearest enemy beyond PLAYER_PREFERRED_DISTANCE, retreat-by-draw inside
 * PLAYER_MINIMUM_DISTANCE, wander in the band -- the same three-way shape as
 * targeting.ts's seekMove, reimplemented against the injected `rnd` stream instead of
 * seekMove's world.seed-keyed hash (see the module comment for why).
 *
 * Also redraws the wander heading and the window's mine inclination together, once every
 * WANDER_TICKS ticks -- one cadence for both, rather than a separate clock for each.
 *
 * Directive A, part 2: the RETREAT branch pulls away from `threats.centroid`, not
 * `threats.nearest.pos` -- retreating from only the closest opponent can walk the
 * player straight at a second one, and the centroid is the whole-map-aware answer to
 * "which way is actually away from the pressure". `centroid` equals `nearest.pos`
 * exactly when there is only one opponent (see ThreatSummary's doc comment), so this is
 * behaviour-identical to the old nearest-only retreat in the single-opponent case and
 * only diverges once a second opponent is in play -- the same reduction the mine/aim
 * gates below still use `threats.nearest` for directly, since a live shot or a mine
 * drop is about ONE specific opponent, not the mass.
 */
function seekLikeMove(world: World, player: Tank, rnd: () => number, state: PlayerAiState, threats: ThreatSummary): Vec2 {
  if (state.wanderTicksLeft <= 0) {
    state.wanderHeading = rnd() * Math.PI * 2;
    state.mineInclined = rnd() < PLAYER_MINE_CHANCE;
    state.wanderTicksLeft = WANDER_TICKS;
  }
  state.wanderTicksLeft -= 1;
  const wander = fromAngle(state.wanderHeading);

  const nearest = threats.nearest;
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
  return wallBlocksStep(world, player, dir, speed) ? wander : dir;
}

/**
 * A pure function of `world`, `playerId`, `rnd` and the caller's own `state`: same
 * inputs, same InputState, every time. `world` and `state` are read, never mutated --
 * `state`'s fields are reassigned by the caller-owned object passed in, not by reaching
 * into `world.tanks`, so this holds to the same "never mutate what you are given" rule
 * `step()` itself follows for `world`.
 *
 * Behaviour, in priority order (see the issue): dodge incoming shells / flee armed mines
 * (dangerAvoidMove, the same shared geometry the enemy AI uses and just as deterministic
 * given its arguments -- but directive B now feeds it a PERCEIVED radius/corridor drawn
 * fresh from `rnd` each tick, never `world.seed`, so the player can misjudge a hazard
 * exactly as an enemy can, through its own stream rather than the shared one); otherwise
 * keep a sensible distance from the nearest enemy rather than ramming --
 * retreating from the whole-map opponent CENTROID rather than just whichever one is
 * closest, once a second opponent is in play (see ThreatSummary); aim at the nearest
 * enemy actually in sight, jittered by the player's own resolved profile's aimAccuracy
 * (STATIC_BASIC, 0.55 -- worse than Grey's 0.6, better than Brown's... same 0.55, since
 * Brown IS StaticBasic); fire only once that solution has been HELD for the profile's
 * own reactionTime (0.8s) -- so the player does not snap to a frame-perfect shot the
 * instant an enemy peeks a corner; occasionally lay a mine when an enemy is close
 * enough for one to matter.
 *
 * With no tank in sight, this file does NOT aim at or fire on a destructible wall in
 * the way. An earlier version did (directive A part 1, as first written); it was
 * stripped on adjudicated review after a probe found the decision doubly inert against
 * this sim's actual mechanics -- a shell never destroys a destructible wall (only a
 * mine blast does, mines.ts's `applyBlast`), and destructible walls are never merged
 * (arena.ts: one `Wall` per cell), so a real multi-cell barrier would not even have
 * passed the removed code's own "exactly one wall in the way" gate. Spending a shell on
 * a wall it cannot open is strictly worse than holding fire (it burns a
 * `weapon.maxActiveProjectiles` slot for nothing). See the PR 2b plan doc
 * (docs/superpowers/plans/2026-08-16-bot-competence.md) for the full finding; mine-
 * breaching -- using the mechanic that actually opens a destructible wall -- is queued
 * there as the follow-up that replaces this.
 */
export function decidePlayerInput(
  world: World,
  playerId: number,
  rnd: () => number,
  state: PlayerAiState,
): InputState {
  const player = world.tanks.find((t) => t.id === playerId);
  if (!player || !player.alive) {
    return { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, mine: false };
  }

  const cfg = configFor(player.kind);

  // The one bounded per-tick pass (directive A, part 2) -- computed once and reused by
  // movement and the mine gate below, instead of each running its own separate
  // nearest-opponent scan.
  const threats = assessThreats(world, player);

  // Directive B: the player's own perceived hazard radii, drawn ONCE per tick from the
  // injected `rnd` stream (never `world.seed` -- see the module comment). A linear PRNG
  // stream has no bucket to re-derive a value from later, unlike the enemy AI's
  // world.seed-keyed hash, so a per-TICK draw is this file's equivalent of "hold a
  // misjudgement for a while": every mine/dodge gate below reads the SAME offset this
  // tick, exactly as grey.ts/teal.ts reuse one `estimationError` draw across their sites.
  const hazardOffset = (rnd() * 2 - 1) * profileHazardSpread(cfg);
  const fleeRadius = AI_MINE_FLEE_RADIUS + hazardOffset;
  const dangerCorridor = DANGER_CORRIDOR + hazardOffset;
  const tacticalRadius = AI_MINE_TACTICAL_RADIUS + hazardOffset;

  // ---- Movement: dodge overrides the band/wander baseline, never the reverse. ----
  const avoid = dangerAvoidMove(world, player, fleeRadius, dangerCorridor);
  const candidate = avoid ?? seekLikeMove(world, player, rnd, state, threats);
  // The commitment layer (issue #222), shared with the enemy AI via `commitHeading`. A bot
  // driving a player slot reaches the same `dangerAvoidMove` geometry and so exhibited the
  // same tick-to-tick reversal; holding it here keeps a VS bot from jittering while every
  // campaign enemy has stopped. The held state is this caller's `PlayerAiState`, never the
  // world (see that field's own comment).
  const avoidKind = avoid === null
    ? null
    : incomingThreats(world, player, dangerCorridor).length > 0 ? 'bullet' as const : 'mine' as const;
  const committed = commitHeading(
    world, player, state.intent, state.intentTicks,
    Math.round(cfg.ai.commitmentTime * TICK_HZ), candidate, avoid, avoidKind,
  );
  state.intent = committed.nextIntent;
  state.intentTicks = committed.nextIntentTicks;
  const move = committed.move;

  // ---- Targeting: the nearest enemy the player can actually SEE. ----
  let target: Tank | null = null;
  let bestDist = Infinity;
  for (const t of world.tanks) {
    if (!isOpponent(world, player, t)) continue;
    if (!lineOfSight(player.pos, t.pos, world.walls)) continue;
    const d = vdist(player.pos, t.pos);
    if (d < bestDist) { bestDist = d; target = t; }
  }

  // No tank in sight: hold the current turret heading rather than snapping to some
  // default or firing on a wall. An earlier version aimed at and fired on an intact
  // destructible wall here (directive A part 1) -- stripped on adjudicated review; see
  // this function's own doc comment and the PR 2b plan doc for why.
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
  state.aimTicks = hasSolution ? state.aimTicks + 1 : 0;
  const reactionTicks = Math.round(cfg.ai.reactionTime * TICK_HZ);
  const fire = hasSolution && state.aimTicks >= reactionTicks;

  // ---- Mines: only while not dodging, on cooldown, and actually near an enemy --
  // mirrors grey.ts/teal.ts's mineThreatensPlayer gate with the roles swapped (there is
  // no "mineThreatensNearestEnemy" in targeting.ts to reuse: that helper is hardcoded to
  // the player as the threatened party). This is oracle-knowledge site #5 (directive B):
  // an independently written parallel to targeting.ts's mine gates, not shared code, so
  // it draws its own perceived radii above (`fleeRadius`, `tacticalRadius`) rather than
  // calling estimationError (world.seed-keyed, enemy-only).
  //
  // Capped at ONE of the player's own active mines, not cfg.mineCapacity (2): at the
  // initial 0.3 chance, capping at one dropped arena-02's self-mine losses from 25 of 52
  // to 9 of 31 (see PLAYER_MINE_CHANCE's comment for the method caveat on attributing an
  // exact delta to one gate in a chaotic-deterministic sim). Also refuses to lay ANY
  // mine while already standing within the PERCEIVED flee radius of a live mine (own or
  // not) -- the same margin dangerAvoidMove now flees to, so a mine is never dropped
  // somewhere the player's own (possibly mistaken) read says it would have to dodge again.
  const nearest = threats.nearest;
  const nearLiveMine = world.mines.some(
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
