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
   * 0.1s (6 ticks) everywhere, chosen from a sweep of {0, 0.1, 0.2, 0.3, 0.45} over 60
   * seeds x 2 arenas x 2 player policies. DWELL -- the fraction of live ticks the turret
   * is perfectly still, which is what "the gun is twitching" actually measures -- is
   * SATURATED by 0.1: brown on arena1/pacifist goes 72.93% -> 86.73% and then gains 1.5
   * points across the whole rest of the range; teal goes 42.53% -> 69.14% and then gains
   * 0.8. Lethality does not pay for it at that span (arena1 58/60 -> 60/60 losses,
   * medianTicks 1494 -> 1511; arena3 60/60 either way), where longer spans start to cost
   * kill speed without buying stillness. The shortest span that gets the benefit is also
   * the one that leaves a barrel stale for the least time, so 0.1 is the conservative end
   * of a flat region rather than a peak.
   *
   * Authored UNIFORMLY across profiles on purpose. The field is per-profile so it can
   * become a personality axis the way commitmentTime is, but nothing measured here
   * justifies differing values yet, and inventing a spread would be a difficulty change
   * dressed up as polish. One row does keep improving past 0.1 -- teal on arena1/shooter,
   * 63.16% at 0.1 rising to 71.88% at 0.45 -- so if teal specifically still reads as
   * twitchy in play, that row is the evidence for raising teal alone, and re-measuring.
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
