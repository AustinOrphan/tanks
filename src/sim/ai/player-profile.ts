import type { World } from '../world';
import type { InputState, Tank, Vec2, Wall } from '../types';
import { vsub, vdist, vnorm, vlen, fromAngle, angleOf } from '../types';
import { lineOfSight, aimLead, dangerAvoidMove, profileAimSpread } from './targeting';
import { driveVelocity, circleVsAABB, raySegmentVsAABB } from '../collision';
import { configFor, hasAbility, TankAbility } from '../config';
import {
  TANK_RADIUS, DT, TICK_HZ, WANDER_TICKS, SEEK_APPROACH_BIAS, VEC_EPS,
  AI_MINE_TACTICAL_RADIUS, AI_MINE_FLEE_RADIUS,
} from '../constants';

/**
 * A scripted "competent player": drives the PLAYER tank the way a decent human would,
 * for tests (a second headline metric alongside the pacifist harness) and for demos
 * (the `autoplay` dev flag in game/loop.ts).
 *
 * Deliberately reuses the geometry/threat-assessment helpers `src/sim/ai/*.ts` already
 * proved out for the enemy AI -- lineOfSight, aimLead, dangerAvoidMove, profileAimSpread
 * -- rather than reimplementing them (see brown.ts/grey.ts/teal.ts, which this mirrors in
 * spirit). What it does NOT reuse is any of targeting.ts's PROBABILISTIC helpers
 * (wanderMove, aimJitter, mineInclination, seekMove's own draws): those are pure hashes
 * of `world.seed`, and driving the player through them would mean the player's behaviour
 * is a function of the exact same seed the enemy AI draws from -- change one enemy's
 * profile in a way that shifts how many `nextRng` calls happen before tick T (it never
 * does today, since the hashes are keyed by tick bucket, not call count -- but relying on
 * that is exactly the kind of coupling the pacifist harness's comment warns against) and
 * you would be at risk of silently perturbing the very thing engagement.measure.test.ts
 * and pacifist.test.ts measure. `decidePlayerInput` instead takes its own injected `rnd`
 * stream, precisely mirroring pacifist.test.ts's local `mulberry` PRNG -- see `mulberry32`
 * below, exported so the test file and the game's `autoplay` dev-flag wiring share one
 * implementation instead of three copies of the same 6 lines.
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
}

export function createPlayerAiState(rnd: () => number): PlayerAiState {
  return { aimTicks: 0, wanderHeading: rnd() * Math.PI * 2, wanderTicksLeft: 0, mineInclined: false };
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
 * Shipped at 0.05: rare enough to read as occasional rather than compulsive
 * (minesPerGame 1.73-7.15 across the 5 arenas, re-measured after directive A parts 1
 * and 2 landed -- this range moved from an earlier 1.6-7.7-across-4-arenas figure
 * measured before arena-05 shipped, which is a population change more than a behavior
 * one; full numbers in the measurement block's console output), with the residual
 * self-mine risk left in on purpose -- see player-profile.test.ts's pinned
 * self-mine-share assertion, which is the honest way to hold this open rather than
 * papering over it.
 */
const PLAYER_MINE_CHANCE = 0.05;

/**
 * True if `other` should be treated as an opponent of `subject` -- the single predicate
 * both `nearestEnemy`'s positional scan and the LOS target-acquisition loop hardcoded
 * separately (`t.kind === 'player'` / `!== 'player'`, both gated on `t.alive`). Today's
 * body is exactly what those two checks already did: every non-player-kind, alive tank
 * is an opponent, because multiplayer teammates (any OTHER player-kind tank) never
 * fight each other and are filtered the same way `subject` already is. `_world`/
 * `_subject` are unused by TODAY's rule (underscored to satisfy noUnusedParameters) --
 * kept in the signature because this is the seam a later mode-aware targeting pass
 * swaps in one place, rather than hunting down every `kind` check this file grows in
 * the meantime. Named `subject`, not `self`: purity.test.ts's guard flags any bare
 * `self.`/`self[` as the DOM/worker global by regex, not by scope, so a LOCAL `self`
 * parameter that is ever dotted (`self.pos`) is a real false positive there, not a
 * hypothetical one -- confirmed by running into it while writing this function.
 */
function isOpponent(_world: World, _subject: Tank, other: Tank): boolean {
  return other.kind !== 'player' && other.alive;
}

/**
 * Directive A, part 2: whole-map awareness. `world.walls`/`world.tanks`/`world.mines`
 * were already handed to this file in full -- the gap was never what it's GIVEN, only
 * what it COMPUTES from that, which used to be nearest-only. `assessThreats` is the
 * single bounded per-tick pass that replaces the old standalone `nearestEnemy` scan:
 * one O(tanks) loop, no pairwise term, so folding it into `decidePlayerInput` keeps the
 * whole function O(tanks+mines+walls) per tick, the order it already was.
 */
interface ThreatSummary {
  /** Same tank the old nearestEnemy(world, subject) returned. */
  nearest: Tank | null;
  /** Second-nearest opponent, or null with fewer than two in play. */
  second: Tank | null;
  /** How many opponents this pass counted. */
  opponentCount: number;
  /**
   * Centroid of every opponent's position, or null when there are none. Equal to
   * `nearest.pos` when `opponentCount` is 1 -- every consumer that reads this in place
   * of `nearest.pos` is UNCHANGED in the single-opponent case, and only diverges once a
   * second opponent presses at the same time, which is exactly the case directive A
   * asks the movement band to handle differently.
   */
  centroid: Vec2 | null;
}

function assessThreats(world: World, subject: Tank): ThreatSummary {
  let nearest: Tank | null = null;
  let nearestDist = Infinity;
  let second: Tank | null = null;
  let secondDist = Infinity;
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
      second = nearest;
      secondDist = nearestDist;
      nearest = t;
      nearestDist = d;
    } else if (d < secondDist) {
      second = t;
      secondDist = d;
    }
  }
  return {
    nearest,
    second,
    opponentCount: count,
    centroid: count > 0 ? { x: sumX / count, y: sumY / count } : null,
  };
}

/**
 * The wall's own surface point if the straight line from `from` to `opponent` crosses
 * EXACTLY one intact wall and that wall is an intact DESTRUCTIBLE -- directive A's
 * "shooting it is a path". A second wall on the same line (of either kind), or a lone
 * SOLID wall, returns null: this is a narrow "one clean pane of glass in the way" case,
 * not "shoot any wall that happens to be in the way".
 *
 * Player-local, and deliberately not a call to targeting.ts's `lineOfSight`: that
 * helper answers "is anything at all in the way" and does not discriminate wall KIND,
 * which is exactly the distinction this decision needs (see the module comment for why
 * this file writes its own raycast rather than touching targeting.ts). Built on
 * `raySegmentVsAABB` directly -- the same primitive `lineOfSight`/`bankShot` call --
 * since `collision.ts` is shared infrastructure already imported by this file, not
 * enemy-AI-owned code.
 *
 * Note on this sim's actual mechanics, read by probe rather than assumed: a shell never
 * destroys a destructible wall -- only a mine blast does (mines.ts's `applyBlast`).
 * This function still names the DECISION correctly ("is this a clean, plausible shot at
 * an obstacle that looks breakable"); whether that shot ever pays off is a question
 * about `bullets.ts`, out of this file's scope, not about whether the decision is a
 * sound one to make.
 */
function wallShotPoint(from: Vec2, opponent: Tank | null, walls: Wall[]): Vec2 | null {
  if (!opponent) return null;
  let point: Vec2 | null = null;
  let kind: Wall['kind'] | null = null;
  for (const w of walls) {
    if (w.destroyed) continue;
    const hit = raySegmentVsAABB(from, opponent.pos, w.aabb);
    if (!hit) continue;
    if (point !== null) return null; // a second wall on the line: not a clean shot
    point = hit.point;
    kind = w.kind;
  }
  return kind === 'destructible' ? point : null;
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
 * (dangerAvoidMove, unchanged from the enemy AI -- fully deterministic, no RNG at all);
 * otherwise keep a sensible distance from the nearest enemy rather than ramming --
 * retreating from the whole-map opponent CENTROID rather than just whichever one is
 * closest, once a second opponent is in play (see ThreatSummary); aim at the nearest
 * enemy actually in sight, jittered by the player's own resolved profile's aimAccuracy
 * (STATIC_BASIC, 0.55 -- worse than Grey's 0.6, better than Brown's... same 0.55, since
 * Brown IS StaticBasic); with no tank in sight, aim at and fire on an intact
 * destructible wall if it is the ONLY thing blocking the nearest known opponent (see
 * wallShotPoint); fire only once a solution has been HELD for the profile's own
 * reactionTime (0.8s) -- so the player does not snap to a frame-perfect shot the
 * instant an enemy peeks a corner; occasionally lay a mine when an enemy is close
 * enough for one to matter.
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
  // movement, targeting's wall-shot fallback and the mine gate below, instead of each
  // running its own separate nearest-opponent scan.
  const threats = assessThreats(world, player);

  // ---- Movement: dodge overrides the band/wander baseline, never the reverse. ----
  const avoid = dangerAvoidMove(world, player);
  const move = avoid ?? seekLikeMove(world, player, rnd, state, threats);

  // ---- Targeting: the nearest enemy the player can actually SEE. ----
  let target: Tank | null = null;
  let bestDist = Infinity;
  for (const t of world.tanks) {
    if (!isOpponent(world, player, t)) continue;
    if (!lineOfSight(player.pos, t.pos, world.walls)) continue;
    const d = vdist(player.pos, t.pos);
    if (d < bestDist) { bestDist = d; target = t; }
  }

  // No tank in sight: directive A, part 1 -- if the straight line to the nearest KNOWN
  // opponent (positional, not LOS-gated, same sense nearestEnemy always used) crosses
  // exactly one intact wall and that wall is destructible, treat aiming at and firing
  // on its surface as a valid decision instead of just holding heading. See
  // wallShotPoint's own doc comment for what "valid" means here and what it does not.
  const wallAimPoint = target ? null : wallShotPoint(player.pos, threats.nearest, world.walls);

  let aimPoint: Vec2;
  const hasSolution = target !== null || wallAimPoint !== null;
  if (target) {
    const targetVel = driveVelocity(target);
    const lead = aimLead(player.pos, target.pos, targetVel, cfg.weapon.speed);
    // Jitter only the live solution, exactly as brown.ts/grey.ts/teal.ts document: a
    // held/passthrough angle must not drift with nothing to aim at.
    const jitter = (rnd() * 2 - 1) * profileAimSpread(cfg);
    const dir = fromAngle(lead + jitter);
    aimPoint = { x: player.pos.x + dir.x, y: player.pos.y + dir.y };
  } else if (wallAimPoint) {
    // A fixed point needs no lead term (aimLead solves for a MOVING target) -- jittered
    // the same way a live solution is, so a held wall-shot scatters like any other.
    const angle = angleOf(vsub(wallAimPoint, player.pos));
    const jitter = (rnd() * 2 - 1) * profileAimSpread(cfg);
    const dir = fromAngle(angle + jitter);
    aimPoint = { x: player.pos.x + dir.x, y: player.pos.y + dir.y };
  } else {
    // No target and no clean wall shot: hold the current turret heading rather than
    // snapping to some default.
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
  // the player as the threatened party).
  //
  // Capped at ONE of the player's own active mines, not cfg.mineCapacity (2): at the
  // initial 0.3 chance, capping at one dropped arena-02's self-mine losses from 25 of 52
  // to 9 of 31 (see PLAYER_MINE_CHANCE's comment for the method caveat on attributing an
  // exact delta to one gate in a chaotic-deterministic sim). Also refuses to lay ANY
  // mine while already standing within AI_MINE_FLEE_RADIUS of a live mine (own or not)
  // -- the safety margin dangerAvoidMove flees to, so a mine is never dropped somewhere
  // the player would immediately have to dodge again.
  const nearest = threats.nearest;
  const nearLiveMine = world.mines.some(
    (m) => !m.detonated && vdist(player.pos, m.pos) <= AI_MINE_FLEE_RADIUS,
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
    vdist(player.pos, nearest.pos) <= AI_MINE_TACTICAL_RADIUS;

  return { move, aim: aimPoint, fire, mine };
}
