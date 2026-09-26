import type { World } from '../world';
import type { Tank, Bullet, Mine } from '../types';
import type { ResolvedTankConfig } from '../config/types';
import { nextRng, vdist } from '../types';
import {
  DT, TICK_HZ, MINE_TIMER,
  AI_MINE_FLEE_RADIUS, AI_MINE_TACTICAL_RADIUS, DANGER_CORRIDOR,
} from '../constants';
import { estimationError, profileHazardSpread } from './targeting';

/**
 * What a tank believes the hazards are, as opposed to what they are (issue #223).
 *
 * A radius error alone (`estimationError`) leaves every other fact a dodge is solved from
 * -- where the shell is, how fast it closes, whether that mine exists yet -- at full
 * precision, so a bot could be wrong about how wide a blast is and never wrong about
 * anything else: the "oracle-perfect escape solve" the issue opens against. #223 asks for
 * seeded error in "perceived position, velocity, time-to-impact, fuse state, or blast
 * reach -- not only a fresh radius offset".
 *
 * The shape, and why it is one delay rather than five independent errors. A tank does not
 * hold five separately-wrong beliefs about one shell; it holds one picture of the arena
 * that is a moment out of date. Back-dating the hazards by a seeded `awarenessDelay` is a
 * single knob that produces every error on the issue's list at once and keeps them
 * mutually consistent: the shell's perceived position is behind its real one, so its
 * perceived time to impact is longer, so the corridor test is answered about a different
 * point on its path -- and a mine dropped inside the delay window has not been noticed at
 * all, which is fuse-state error in the only form that changes a decision. Five
 * independent draws would let a bot be right about the position and wrong about the
 * arrival time of the same shell, which reads as noise rather than as a late look.
 *
 * The picture is held, not redrawn per tick. Both the radius error and the delay are drawn
 * once per `hazardRefreshTime` window, so a bad read is lived with for the span of one
 * encounter instead of averaging itself away across the frames of a single dodge -- the
 * issue's "believable mistaken judgment rather than frame-to-frame noise". That cadence is
 * itself one of the six competence axes, which is why it is a profile field.
 *
 * Pure, and a pure function of its inputs -- no threaded state, the same house recipe as
 * `wanderMove`/`aimJitter`/`estimationError`. Any call site, in any order, at any tick,
 * gets the identical snapshot for the same `(world, tank, cfg)`, which is what lets
 * `stepAi`'s mine gate recompute it independently of the decision function that already
 * drew it and land on the same belief.
 */
export interface PerceivedHazards {
  /** How stale this picture is, in whole ticks. Zero means "exactly the real world". */
  readonly delayTicks: number;
  /** The signed radius-estimation offset for this window (`estimationError`). */
  readonly radiusError: number;
  /** Extra clearance this tank keeps beyond the radius it believes in, world units. */
  readonly safetyMargin: number;
  /** Perceived `AI_MINE_FLEE_RADIUS`. */
  readonly fleeRadius: number;
  /** Perceived `DANGER_CORRIDOR`. */
  readonly dangerCorridor: number;
  /** Perceived `AI_MINE_TACTICAL_RADIUS`. */
  readonly tacticalRadius: number;
  /**
   * The world as this tank believes it to be: shells back-dated, unnoticed mines absent.
   *
   * The same object as `world` when `delayTicks` is 0 -- referential identity, not an equal
   * copy, so a zero delay is provably free of both cost and drift. Tanks, walls and spawns
   * are shared by reference in every case: awareness delay is a hazard axis, and a bot that
   * also mislaid its opponent would be a targeting change wearing this issue's label.
   *
   * Read-only. `backdateHazards` mutates nothing, but it is not a deep clone either -- see
   * its own doc comment for exactly which objects are shared with the real world.
   */
  readonly world: World;
}

/**
 * Whole ticks between hazard re-reads, from the profile's `hazardRefreshTime`.
 *
 * Floored at 1 tick because it is a divisor (`hazardBucket`): a span rounding to zero would
 * bucket every tick to the same Infinity and freeze one read for the whole round. The
 * floor is defence in depth -- `validateAiProfiles` refuses a non-positive authored span
 * and `MIN_COMPETENCE_HAZARD_REFRESH` keeps the scaled value above it -- but a divisor
 * reached from two independent places earns a guard at the division itself.
 */
export function hazardRefreshTicks(cfg: ResolvedTankConfig): number {
  return Math.max(1, Math.round(cfg.ai.hazardRefreshTime * TICK_HZ));
}

/** Which refresh window `world.tick` falls in for this profile. */
export function hazardBucket(world: World, cfg: ResolvedTankConfig): number {
  return Math.floor(world.tick / hazardRefreshTicks(cfg));
}

/**
 * This window's awareness delay for `tank`, in whole ticks.
 *
 * Drawn, not fixed at `awarenessDelay`. A constant lag is a systematic bias a bot could in
 * principle be tuned around and, more importantly, is not what being slow to notice looks
 * like: sometimes you see it at once and sometimes you see it late. The draw is uniform on
 * [0, awarenessDelay], so the profile's value is the worst case and the mean lag is half
 * of it -- which is why the authored 0.1s reads as "occasionally a beat behind" rather than
 * as a flat six-tick handicap.
 *
 * Rounded to whole ticks because the thing it back-dates is a fixed-timestep integration:
 * a fractional tick would invent shell positions the sim never produced.
 *
 * `* 8093` is a fresh prime, distinct from every other per-tank stream this codebase draws
 * -- wander (1000), retreat (4243), mine inclination (6101), aim jitter (7919), estimation
 * error (5303), idle search (6091) -- so for the same (tank.id, bucket) this draw is never
 * the identical key as any of them. It is also strictly greater than `world.seed` for
 * `tank.id >= 1`, which is the same argument `estimationError` gives for not colliding with
 * a bot's per-slot stream (game/loop.ts's BOT_SEED_SPACING keys every bot strictly below
 * `world.seed`).
 */
export function awarenessDelayTicks(world: World, tank: Tank, cfg: ResolvedTankConfig): number {
  const maxTicks = cfg.ai.awarenessDelay * TICK_HZ;
  if (!(maxTicks > 0)) return 0;
  const rng = nextRng(world.seed + tank.id * 8093 + hazardBucket(world, cfg));
  return Math.round(rng.value * maxTicks);
}

/**
 * `world` rewound by `delayTicks` for the two hazard populations only.
 *
 * Shells are moved back along their own velocity. That is exact for a shell in free
 * flight -- `stepBullets` integrates `pos += vel * DT` -- and deliberately wrong across a
 * bounce, where the true earlier position is on the other side of a wall. Wrong is the
 * point: a tank that mis-extrapolates a ricochet backwards is making the mistake a human
 * makes watching one, and correcting it would need the shell's history, which the sim does
 * not keep and a perceiving tank would not have either.
 *
 * Mines younger than the delay are simply absent: a mine dropped two ticks ago has not been
 * noticed yet by a tank whose picture is six ticks old. Age is read off the fuse
 * (`MINE_TIMER - timer`), which is why this is fuse-state error and not a second position
 * error -- mines do not move, so the only thing that can be stale about one is whether its
 * fuse has started as far as this tank knows.
 *
 * What it guarantees, and what it deliberately does not. It mutates nothing: not `world`,
 * not either of its arrays, not any object reachable from them. The two replaced arrays are
 * fresh, and each back-dated shell is a fresh object with a fresh `pos`.
 *
 * It is not a deep clone, and the returned collections must not be written through. A shell
 * that is not `alive` is passed straight through by reference; every surviving mine is the
 * original `Mine`; and even a rewritten shell still shares its `vel` with the real one, since
 * only `pos` is replaced. Nothing writes through a perceived world today -- every consumer
 * only reads -- and deep-copying two collections on a path that runs for every mobile AI tank
 * every tick would cost more than the stronger guarantee buys. A caller that ever needs to
 * write must copy first. `hazard-perception.test.ts` pins both halves of this paragraph.
 */
export function backdateHazards(world: World, delayTicks: number): World {
  if (delayTicks <= 0) return world;
  const lag = delayTicks * DT;
  const bullets: Bullet[] = world.bullets.map((b) =>
    b.alive ? { ...b, pos: { x: b.pos.x - b.vel.x * lag, y: b.pos.y - b.vel.y * lag } } : b);
  const mines: Mine[] = world.mines.filter((m) => MINE_TIMER - m.timer >= lag);
  return { ...world, bullets, mines };
}

/**
 * The whole perceived hazard state for one tank this tick.
 *
 * The three radii are the true constants plus one shared error term plus the margin, which
 * is the property `estimationError`'s own doc comment already argued for and this preserves:
 * "having a bad read this window" is coherent across every hazard type at once, not an
 * independent coin flip per site.
 */
export function perceiveHazards(world: World, tank: Tank, cfg: ResolvedTankConfig): PerceivedHazards {
  const radiusError = estimationError(world, tank, profileHazardSpread(cfg), hazardRefreshTicks(cfg));
  const safetyMargin = cfg.ai.safetyMargin;
  const offset = radiusError + safetyMargin;
  const delayTicks = awarenessDelayTicks(world, tank, cfg);
  return {
    delayTicks,
    radiusError,
    safetyMargin,
    fleeRadius: AI_MINE_FLEE_RADIUS + offset,
    dangerCorridor: DANGER_CORRIDOR + offset,
    tacticalRadius: AI_MINE_TACTICAL_RADIUS + offset,
    world: backdateHazards(world, delayTicks),
  };
}

/**
 * The developer trace #223 asks for: actual against perceived, for one tank at one tick.
 *
 * Pure, allocation-only, and called by nothing in `step` -- it exists so a harness or a
 * failing test can print why a bot did something rather than inferring it from where the
 * bot ended up. `ai/hazard-perception.measure.test.ts` is its first consumer.
 *
 * `missedThreats`/`phantomThreats` are the two ways a stale picture changes a decision, and
 * they are counted rather than derived from the radii because that is the question a reader
 * actually has: a shell inside the true corridor that the tank's own picture does not flag
 * is a dodge that will not happen, and one flagged that is not really there is a dodge that
 * did not need to.
 */
export interface HazardPerceptionSample {
  readonly tick: number;
  readonly tankId: number;
  readonly delayTicks: number;
  readonly radiusError: number;
  readonly safetyMargin: number;
  /** True radius, then the radius this tank is deciding against. */
  readonly actualFleeRadius: number;
  readonly perceivedFleeRadius: number;
  readonly actualDangerCorridor: number;
  readonly perceivedDangerCorridor: number;
  /** Live mines within the true flee radius, then within the perceived one. */
  readonly actualMinesInRange: number;
  readonly perceivedMinesInRange: number;
  /** Real threats the tank's picture misses, and unreal ones it invents. */
  readonly missedThreats: number;
  readonly phantomThreats: number;
  /**
   * Worst-case metres between where a shell is and where this tank believes it is, over the
   * shells it perceives at all. Zero when there are none.
   */
  readonly maxShellPositionError: number;
}

export function hazardPerceptionSample(
  world: World,
  tank: Tank,
  cfg: ResolvedTankConfig,
  /** Injected so the trace cannot drift from the decision: pass the same predicate the
   *  decision used (`incomingThreats`), rather than reimplementing the corridor test. */
  threatIds: (w: World, corridor: number) => readonly number[],
): HazardPerceptionSample {
  const p = perceiveHazards(world, tank, cfg);
  const actual = new Set(threatIds(world, DANGER_CORRIDOR));
  const perceived = new Set(threatIds(p.world, p.dangerCorridor));
  let missed = 0;
  for (const id of actual) if (!perceived.has(id)) missed++;
  let phantom = 0;
  for (const id of perceived) if (!actual.has(id)) phantom++;
  let maxShellError = 0;
  for (const b of p.world.bullets) {
    if (!b.alive) continue;
    const real = world.bullets.find((r) => r.id === b.id);
    if (!real) continue;
    const d = vdist(real.pos, b.pos);
    if (d > maxShellError) maxShellError = d;
  }
  const near = (radius: number) => world.mines.filter(
    (m) => !m.detonated && vdist(m.pos, tank.pos) <= radius).length;
  const perceivedNear = p.world.mines.filter(
    (m) => !m.detonated && vdist(m.pos, tank.pos) <= p.fleeRadius).length;
  return {
    tick: world.tick,
    tankId: tank.id,
    delayTicks: p.delayTicks,
    radiusError: p.radiusError,
    safetyMargin: p.safetyMargin,
    actualFleeRadius: AI_MINE_FLEE_RADIUS,
    perceivedFleeRadius: p.fleeRadius,
    actualDangerCorridor: DANGER_CORRIDOR,
    perceivedDangerCorridor: p.dangerCorridor,
    actualMinesInRange: near(AI_MINE_FLEE_RADIUS),
    perceivedMinesInRange: perceivedNear,
    missedThreats: missed,
    phantomThreats: phantom,
    maxShellPositionError: maxShellError,
  };
}
