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
// Adopted from the supplied tank-types.ts. The interfaces are the SAME whether
// they describe the 9-type Wii reference taxonomy (config/reference/) or the
// game's shipped roster (config/roster.ts) -- only the NUMBERS in the paired
// BalanceConstants differ. That split (a definition names classes; a balance
// table assigns numbers to classes) is what lets a value be retuned in one place
// and lets a new entity be added as data.
//
// One field is added beyond the supplied schema: ResolvedWeaponConfig.bulletType,
// the sim's own BulletType ('normal'|'fast'|'ricochet'). The sim's bullet physics
// is keyed by BulletType, so the resolver maps each ProjectileType onto one (see
// resolve.ts). Everything else is as supplied.
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
  /** 1-based mission this tank first appears in. Reference/expansion metadata. */
  firstMission: number;
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
  /** World units per second (the sim's native unit; NOT the Wii reference scale). */
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
   * Consumption is ASYMMETRIC by behavior, the same precedent already set for
   * preferredDistance/minimumDistance/retreatChance under STATIONARY -- see
   * targeting.ts's dangerAvoidMove/mineThreatensPlayer/friendlyInMineBlast call sites and
   * player-profile.ts's own mirrored gates.
   */
  estimationAccuracy: number;
  reactionTime: number;
  /**
   * Seconds this profile COMMITS to a movement decision before re-deciding (issue #222).
   * Consumed by `commitMove` (ai/commitment.ts) as `Math.round(commitmentTime * TICK_HZ)`.
   *
   * A PERSONALITY axis, not a difficulty one: it deliberately does not track the other
   * fields' ordering. A jumpy defensive profile re-evaluates often and a berserker never
   * second-guesses itself, and neither is straightforwardly "harder" -- committing longer
   * makes a tank more decisive AND more predictable at once. That is also why
   * `tankDifficultyBreakdown` does not score it; see its own doc comment on scoring only
   * fields whose magnitude maps monotonically onto threat.
   *
   * Inert for STATIONARY behaviours: brown's `desiredMove` is hardcoded zero on every
   * path, so it never acquires an intent to hold. The value is still required rather
   * than optional -- an omitted field on a profile that later becomes mobile would
   * silently default to "no commitment", which is the defect this closes.
   */
  commitmentTime: number;
  /**
   * Seconds this tank holds a solved aim angle before re-solving (issue #344). Consumed
   * by `holdAimFor` (ai/aim-hold.ts) as `Math.round(aimHoldTime * TICK_HZ)`. A hold also
   * breaks early when the fresh solution drifts past AI_AIM_BREAK, so this is the DWELL
   * length, not a reaction delay: acquiring a genuinely new target stays immediate.
   *
   * Zero disables the hold for that profile and re-solves every tick, which is the
   * pre-#344 behaviour -- demonstrated, not assumed: setting every profile to zero
   * reproduces the previous BASELINE_HASH byte for byte (tools/baseline/trace.ts).
   *
   * 0.2s (12 ticks) everywhere, chosen from a JOINT sweep against AI_TURRET_RAMP_TICKS on
   * the tree that already carries issue #347's turret acceleration. The joint sweep is the
   * point: an earlier standalone sweep, taken against the old bang-bang slew, picked 0.1s
   * because longer holds cost kill speed there -- every release started at the full rate
   * cap. With acceleration underneath, the release RAMPS, so a longer hold no longer hurts,
   * and 0.1s is no longer the right answer. Re-measured rather than carried over.
   *
   * arena1, 60 seeds x 2 arenas x 2 player policies. abrupt% is the fraction of ticks whose
   * per-tick step size moves by more than half the cap (lower is smoother); still% is the
   * fraction of live ticks the turret is perfectly still:
   *
   *   span  ramp | brown abrupt / teal abrupt | brown still / teal still | a1 losses, median
   *   0     6    | 0.06 / 0.44               | 75.6 / 41.0              | 59/60, 1508
   *   0     10   | 0.03 / 0.36               | 78.6 / 42.1              | 60/60, 1528
   *   0.1   6    | 0.04 / 0.44               | 82.9 / 57.0              | 58/60, 1524
   *   0.1   10   | 0.04 / 0.36               | 81.2 / 53.6              | 59/60, 1420
   *   0.2   6    | 0.03 / 0.36               | 84.0 / 62.3              | 60/60, 1510   <- chosen
   *   0.2   10   | 0.03 / 0.33               | 83.9 / 57.5              | 60/60, 1449
   *
   * 0.2/6 dominates the previously shipped 0.1/6 on every column, lethality included. Past
   * 0.2 the returns stop: extending to 0.3 and 0.45 at ramp 6 gives teal abrupt 0.40 then
   * 0.35 against 0.36 -- non-monotonic, i.e. noise -- for at most 2.3 more points of teal
   * stillness and a longer window in which a barrel can sit stale. reaction.test.ts and
   * pacifist.test.ts pass 10/10 at every point above.
   *
   * Authored UNIFORMLY across profiles on purpose. The field is per-profile so it can become
   * a personality axis the way commitmentTime is, but nothing measured justifies differing
   * values yet, and inventing a spread would be a difficulty change dressed up as polish.
   */
  aimHoldTime: number;
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
  firstMission: number;
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
