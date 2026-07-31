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
  reactionTime: number;
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
