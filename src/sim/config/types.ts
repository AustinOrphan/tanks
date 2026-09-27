import type { BulletType } from '../types';
import {
  AIBehavior,
  AIProfile,
  FireRate,
  MovementSpeed,
  ProjectileType,
  RotationSpeed,
  TankAbility,
  TankType,
} from './enums';

// ---------------------------------------------------------------------------
// Entity definition + balance schema.
//
// Adopted from the supplied tank-types.ts. The same interfaces describe the 9-type
// Wii reference taxonomy (config/reference/) and the game's shipped roster
// (config/roster.ts). The split (a definition names classes; a balance table
// assigns numbers to classes) is what lets a value be retuned in one place and
// lets a new entity be added as data.
//
// Departures from the supplied schema: ResolvedWeaponConfig.bulletType, the sim's
// own BulletType ('normal'|'fast'|'ricochet'), because the sim's bullet physics is
// keyed by BulletType and the resolver maps each ProjectileType onto one (see
// resolve.ts); AIProfileBalance's estimationAccuracy, awarenessDelay, safetyMargin,
// hazardRefreshTime and four timing spans, each documented below; and no
// TankDefinition.firstMission. The reference JSON therefore does not match
// these types exactly, and resolve.test.ts casts it.
//
// Provenance (issue #783): the supplied files are first-party. They were written for this
// project with ChatGPT, in a conversation that cites no other codebase. See CONTENT-LICENSE.md,
// "Where the supplied tank configuration came from".
// ---------------------------------------------------------------------------

export interface TankWeaponDefinition {
  projectileType: ProjectileType;
  fireRate: FireRate;
  maxActiveProjectiles: number;
  /** Wall bounces before the shell dies. The sim's per-BulletType bounce count. */
  ricochetCount: number;
}

export interface TankDefinition {
  displayName: string;
  /** Presentation only (render reads it; the pure sim never does). CSS hex. */
  color: string;
  singlePlayerOnly: boolean;
  movementSpeed: MovementSpeed;
  rotationSpeed: RotationSpeed;
  aiProfile: AIProfile;
  weapon: TankWeaponDefinition;
  mineCapacity: number;
  abilities: TankAbility[];
}

export type TankDefinitionMap = Record<TankType, TankDefinition>;

export interface ProjectileBalance {
  /** World units per second (the sim's native unit; not the Wii reference scale). */
  speed: number;
  damage: number;
  radius: number;
  /** Seconds. Carried for future/reference use; the shipped sim shells never expire on time. */
  lifetime: number;
  explosionRadius: number;
}

export interface AIProfileBalance {
  behavior: AIBehavior;
  aimAccuracy: number;
  /**
   * How well this profile judges a hazard's true radius (mine blast, bullet danger
   * corridor) -- directive B (2026-08-16 owner ruling): AIs must not have oracle knowledge
   * of exact mine blast radii or perfect dodge positions. Required, not optional, and
   * strictly positive like aimAccuracy (targeting.ts's profileHazardSpread divides by it).
   * Consumption is asymmetric by behavior, the same precedent already set for
   * preferredDistance/minimumDistance/retreatChance under STATIONARY -- see
   * targeting.ts's dangerAvoidMove/mineThreatensPlayer/friendlyInMineBlast call sites and
   * player-profile.ts's own mirrored gates.
   */
  estimationAccuracy: number;
  reactionTime: number;
  /**
   * Worst-case seconds of staleness in this profile's hazard picture (issue #223).
   *
   * The second of the six competence axes both #223 and #267 name, and the one that makes
   * the estimation error more than a radius offset: `perceiveHazards` (ai/hazard-perception.ts)
   * back-dates the shells and mines a tank reacts to by a delay drawn uniformly on
   * [0, awarenessDelay] each refresh window, so a stale read is wrong about a threat's
   * position, its time to impact, and whether a just-dropped mine exists at all -- not
   * merely about how wide a blast is.
   *
   * Authored strictly positive, and validation refuses zero (validate.ts). `hard` scales it
   * down (COMPETENCE, ai/bot-difficulty.ts), and a multiplier cannot improve on zero: an axis
   * whose neutral value is 0 admits an `easy` that is worse and a `hard` that is identical,
   * which fails #223's monotonicity criterion. `MIN_COMPETENCE_AWARENESS_DELAY` then keeps
   * the scaled value nonzero, which is the "never oracle-perfect" half of the same rule.
   *
   * 0.1s (6 ticks) across profiles, uniform for the reason targetCommitmentTime states.
   * 0.1s is chosen against the authored reaction times (0.25-0.8s) as the smallest delay
   * that is more than rounding at 60Hz while staying well inside the fastest profile's
   * reaction: a bot notices a shell a beat late, it does not stop noticing. It is a feel
   * constant, flagged for the owner's normal-speed read in PR #522.
   */
  awarenessDelay: number;
  /**
   * Extra world units of clearance this profile keeps beyond the hazard radius it believes
   * in (issue #223). Added to every perceived hazard radius by `perceiveHazards`.
   *
   * Authored at zero for every shipped profile, deliberately, and that is the opposite of
   * awarenessDelay's reasoning rather than an inconsistency: a margin is signed, so
   * difficulty composes over it additively (`COMPETENCE.safetyMargin`) and `easy` can cut
   * corners while `hard` keeps room, with `normal` at exactly the authored value. An axis
   * that can go both ways does not need a nonzero anchor to be monotone -- and authoring it
   * at zero is what keeps this axis a byte-for-byte no-op at `normal`.
   *
   * The field is per-profile rather than difficulty-only so a future cautious archetype can
   * author caution the way DEFENSIVE_ROCKET authors retreatChance, without difficulty having
   * to learn about tank kinds -- which is the per-kind override both issues forbid by name.
   */
  safetyMargin: number;
  /**
   * Seconds this profile holds one hazard read before drawing a new one (issue #223) -- the
   * sixth competence axis, "hazard-perception refresh cadence".
   *
   * Consumed by `hazardRefreshTicks` (ai/hazard-perception.ts) as
   * `Math.round(hazardRefreshTime * TICK_HZ)` -- the same conversion every other span in
   * this schema uses -- floored at 1 tick. It is the bucket width `estimationError` divides
   * the tick by, so it decides how long a misjudgement is lived with: #223 asks for "a
   * perceived hazard snapshot held for a decision window ... rather than frame-to-frame
   * noise", and this is that window's length made a profile field instead of a constant.
   *
   * Shorter is more competent, which is why `hard` scales it down: a shorter window corrects
   * a bad read sooner, so less of the encounter is spent acting on it. It is bounded below
   * (`MIN_COMPETENCE_HAZARD_REFRESH`) because the limit case is the defect, not the ideal --
   * re-drawing every tick averages the error away inside a single dodge and hands back the
   * oracle the error exists to deny.
   *
   * 0.5s across every profile: 30 ticks, the `WANDER_TICKS` cadence `estimationError` uses
   * when no profile cadence is passed.
   */
  hazardRefreshTime: number;
  /**
   * Seconds this profile commits to a movement decision before re-deciding (issue #222).
   * Consumed by `commitMove` (ai/commitment.ts) as `Math.round(commitmentTime * TICK_HZ)`.
   *
   * A personality axis, not a difficulty one: it deliberately does not track the other
   * fields' ordering. A jumpy defensive profile re-evaluates often and a berserker never
   * second-guesses itself, and neither is straightforwardly "harder" -- committing longer
   * makes a tank more decisive and more predictable at once. That is also why
   * `tankDifficultyBreakdown` does not score it: its magnitude does not map monotonically
   * onto threat.
   *
   * Inert for STATIONARY behaviours: brown's `desiredMove` is hardcoded zero on every
   * path, so it never acquires an intent to hold. The value is still required rather
   * than optional -- an omitted field on a profile that later becomes mobile would
   * silently default to "no commitment", which is the defect this closes.
   */
  commitmentTime: number;
  /**
   * Seconds this profile holds one committed opponent before the choice may turn over
   * (issue #359). Consumed by `commitTarget` (ai/target-selection.ts) as
   * `Math.round(targetCommitmentTime * TICK_HZ)`, the same conversion every other span uses.
   *
   * A fourth distinct timing, for the reason shotCommitmentTime is a third: who an AI is
   * fighting, where it is driving, where it is pointing and which shot it is planning are
   * independently tuned, and changing one must not silently change another.
   *
   * Uniform at 1.5s across every shipped profile today. Rule 4 of the issue's binding policy
   * permits that explicitly -- "initial values may be uniform if a deterministic sweep does
   * not justify profile differences" -- and no such sweep has been run, so a per-profile
   * table here would be invented rather than measured.
   */
  targetCommitmentTime: number;
  /**
   * Seconds this tank holds a solved aim angle before re-solving (issue #344). Consumed
   * by `holdAimFor` (ai/aim-hold.ts) as `Math.round(aimHoldTime * TICK_HZ)`. A hold also
   * breaks early when the fresh solution drifts past AI_AIM_BREAK, so this is the dwell
   * length, not a reaction delay: acquiring a genuinely new target stays immediate. Zero
   * disables the hold for that profile and re-solves every tick.
   *
   * 0.2s (12 ticks) everywhere, chosen from a joint sweep against AI_TURRET_RAMP_TICKS
   * (issue #347's turret acceleration) over 60 seeds x 2 arenas x 2 player policies; the
   * table is in PR #345. The joint sweep is the point: with acceleration underneath, a
   * release ramps instead of starting at the full rate cap, so a longer hold no longer
   * costs kill speed. At ramp 6, 0.2s beat 0.1s on smoothness, stillness and lethality;
   * past 0.2s the returns stop -- at most 2.3 more points of teal stillness, for a longer
   * window in which a barrel can sit stale.
   *
   * Per-profile so it can become a personality axis the way commitmentTime is, but authored
   * uniformly for the reason targetCommitmentTime states.
   */
  aimHoldTime: number;
  /**
   * Seconds this profile holds its bank-first/direct-first shot plan before the plan may
   * turn over (issue #332). Consumed by `tealDecision` (ai/teal.ts) as
   * `Math.round(shotCommitmentTime * TICK_HZ)`, the same conversion `commitMove` and
   * `holdAimFor` use for their own spans.
   *
   * Distinct from commitmentTime (movement) and aimHoldTime (aim smoothing) by decision,
   * not by oversight: movement, aim tracking, and tactical shot selection are independently
   * tuned behaviours, and changing one must not silently change another.
   *
   * The window is permissive, not absolute: it gates when the plan may turn over, and a
   * lapsed window re-arms on the same plan unless the held plan also has no solution that
   * tick. See tealDecision's own comment for what that does and does not buy.
   *
   * Inert for STATIONARY and DEFENSIVE behaviours: tealDecision, which TACTICAL, OFFENSIVE
   * and BERSERKER route to (ai/index.ts), is the only decision function that evaluates a
   * shot plan. The value is still required rather than optional, for the reason
   * commitmentTime states -- an omitted field on a profile that later gains a shot plan
   * would silently default to "no commitment", which is the defect this closes.
   *
   * Not scored by `tankDifficultyBreakdown`, for commitmentTime's reason: holding a shot
   * plan longer makes a tank more decisive and more predictable at once, so its magnitude
   * does not map monotonically onto threat.
   *
   * 2.0s across profiles, from a sweep over 60 seeds x 2 arenas x 2 player policies
   * (ai/commitment.measure.test.ts, VITE_RUN_MEASURE=1; the table is in PR #395). The span
   * controls commitment, which is what the issue is about: going from 0.5s to 2.0s cuts
   * plan turnovers from 175 and 97 to 38 and 25 (348 and 276 with no window), at a real,
   * bounded smoothness cost -- plan-clock-boundary P95 0.09 -> 1.80, still inside the
   * 0.03-2.26 every other kind spans in the same run, which is what the acceptance criterion
   * asks for. A shorter span is the right answer if smoothness is ever weighted above
   * commitment. Uniform for the reason targetCommitmentTime states.
   */
  shotCommitmentTime: number;
  aggression: number;
  preferredDistance: number;
  minimumDistance: number;
  retreatChance: number;
  directShotWeight: number;
  bankShotWeight: number;
  minePlacementChance?: number;
}

export interface MineBalance {
  deploymentCooldown: number;
  armingDelay: number;
  triggerRadius: number;
  explosionRadius: number;
  lifetime: number;
  damage: number;
}

export interface InvisibilityBalance {
  opacity: number;
  trackLifetime: number;
  trackSpawnInterval: number;
}

export interface BalanceConstants {
  movementSpeeds: Record<MovementSpeed, number>;
  rotationSpeeds: Record<RotationSpeed, number>;
  fireCooldowns: Record<FireRate, number>;
  projectiles: Record<ProjectileType, ProjectileBalance>;
  aiProfiles: Record<AIProfile, AIProfileBalance>;
  mines: MineBalance;
  invisibility: InvisibilityBalance;
}

// ---- Resolved runtime config (what gameplay code consumes) ----

export interface ResolvedWeaponConfig extends ProjectileBalance {
  /** The sim BulletType this weapon fires; how spawnBullet keys its physics. */
  bulletType: BulletType;
  /** Whole ticks between shots (native sim unit), from fireCooldowns[fireRate]. */
  fireCooldown: number;
  maxActiveProjectiles: number;
  ricochetCount: number;
}

export interface ResolvedTankConfig {
  displayName: string;
  color: string;
  singlePlayerOnly: boolean;
  /** World units per second. */
  movementSpeed: number;
  /** Radians per second (hull slew). */
  rotationSpeed: number;
  ai: AIProfileBalance;
  behavior: AIBehavior;
  weapon: ResolvedWeaponConfig;
  mineCapacity: number;
  abilities: TankAbility[];
}
