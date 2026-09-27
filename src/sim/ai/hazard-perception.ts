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
 * One seeded awareness delay rather than an independent error per fact. Back-dating the
 * hazards makes the perceived position, time to impact and fuse state wrong together and
 * consistently, as a late look is; independent draws would let a bot be right about a
 * shell's position and wrong about its arrival, which reads as noise.
 *
 * The radius error and the delay are drawn once per `hazardRefreshTime` window, so a bad
 * read lasts one encounter instead of averaging away across the frames of a dodge.
 *
 * A pure function of `(world, tank, cfg)`, so `stepAi`'s mine gate can recompute it
 * independently of the decision function and land on the same belief.
 */
export interface PerceivedHazards {
  readonly delayTicks: number;
  /** Signed, world units. */
  readonly radiusError: number;
  /** World units kept beyond the radius the tank believes in. */
  readonly safetyMargin: number;
  readonly fleeRadius: number;
  readonly dangerCorridor: number;
  readonly tacticalRadius: number;
  /**
   * Shells back-dated, unnoticed mines absent. `world` itself when `delayTicks` is 0, so a
   * zero delay costs nothing and cannot drift. Tanks, walls and spawns are never
   * back-dated: awareness delay is a hazard axis, and mislaying the opponent too would be
   * a targeting change. Shares objects with the real world, so never write through it.
   */
  readonly world: World;
}

/**
 * Floored at 1 tick because it is a divisor (`hazardBucket`): a span rounding to zero would
 * bucket every tick to the same Infinity and freeze one read for the whole round. The
 * floor is defence in depth -- `validateAiProfiles` refuses a non-positive authored span
 * and `MIN_COMPETENCE_HAZARD_REFRESH` keeps the scaled value above it -- but a divisor
 * reached from two independent places earns a guard at the division itself.
 */
export function hazardRefreshTicks(cfg: ResolvedTankConfig): number {
  return Math.max(1, Math.round(cfg.ai.hazardRefreshTime * TICK_HZ));
}

export function hazardBucket(world: World, cfg: ResolvedTankConfig): number {
  return Math.floor(world.tick / hazardRefreshTicks(cfg));
}

/**
 * Drawn uniformly on [0, awarenessDelay] rather than fixed: a constant lag is a bias a bot
 * could be tuned around, and not what being slow to notice looks like. The profile value
 * is the worst case and the mean is half of it, so the authored 0.1s reads as
 * "occasionally a beat behind" rather than a flat six-tick handicap.
 *
 * Rounded to whole ticks because the thing it back-dates is a fixed-timestep integration:
 * a fractional tick would invent shell positions the sim never produced.
 *
 * `* 8093` is a prime distinct from every other per-tank stream's multiplier -- wander
 * (1000), retreat (4243), mine inclination (6101), aim jitter (7919), estimation error
 * (5303), idle search (6091) -- so for the same (tank.id, bucket) the keys never
 * coincide. The key is also above `world.seed` for `tank.id >= 1`, clear of the bot
 * streams game/loop.ts's BOT_SEED_SPACING keys below it.
 */
export function awarenessDelayTicks(world: World, tank: Tank, cfg: ResolvedTankConfig): number {
  const maxTicks = cfg.ai.awarenessDelay * TICK_HZ;
  if (!(maxTicks > 0)) return 0;
  const rng = nextRng(world.seed + tank.id * 8093 + hazardBucket(world, cfg));
  return Math.round(rng.value * maxTicks);
}

/**
 * `world` rewound by `delayTicks` for shells and mines only.
 *
 * Shells move back along their own velocity: exact in free flight (`stepBullets`
 * integrates `pos += vel * DT`), deliberately wrong across a bounce. A tank that
 * mis-extrapolates a ricochet backwards makes the mistake a human watching one makes, and
 * correcting it would need shell history the sim does not keep.
 *
 * Mines younger than the delay are absent. Mines do not move, so whether one has been
 * noticed yet is the only thing about it that can be stale.
 *
 * Mutates nothing, but is not a deep clone: dead shells, every surviving mine, and each
 * rewritten shell's `vel` are shared with the real world, so a caller that ever writes
 * must copy first. Deep-copying on this every-tick, every-mobile-AI-tank path would cost
 * more than the stronger guarantee buys. `hazard-perception.test.ts` pins both halves.
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
 * One error term shared by all three radii, so a bad read this window is bad for every
 * hazard type at once rather than an independent coin flip per site.
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
 * Nothing in `step` calls it; it lets a harness or a failing test print why a bot did
 * something (ai/hazard-perception.measure.test.ts).
 *
 * Missed and phantom threats are counted directly because they are the two ways a stale
 * picture changes a decision: a dodge that will not happen, and one that did not need to.
 */
export interface HazardPerceptionSample {
  readonly tick: number;
  readonly tankId: number;
  readonly delayTicks: number;
  readonly radiusError: number;
  readonly safetyMargin: number;
  readonly actualFleeRadius: number;
  readonly perceivedFleeRadius: number;
  readonly actualDangerCorridor: number;
  readonly perceivedDangerCorridor: number;
  /** Live mines within the true flee radius, then within the perceived one. */
  readonly actualMinesInRange: number;
  readonly perceivedMinesInRange: number;
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
