import type { BulletType } from '../types';
import { ProjectileType } from './enums';
import type {
  BalanceConstants,
  ResolvedTankConfig,
  TankDefinition,
} from './types';

/**
 * How each catalogued ProjectileType maps onto the sim's own BulletType, whose
 * physics table (constants.ts `bulletConfig`) the shell systems key off. This is
 * the one place the definition vocabulary meets the sim's bullet kinds.
 */
const PROJECTILE_BULLET_TYPE: Record<ProjectileType, BulletType> = {
  [ProjectileType.STANDARD_SHELL]: 'normal',
  [ProjectileType.ROCKET]: 'fast',
  [ProjectileType.RICOCHET_ROCKET]: 'ricochet',
};

/**
 * Resolve a TankDefinition + a BalanceConstants table into a flat runtime config.
 *
 * Adapted from the supplied resolved-tank-config.ts. Generalised over the key type
 * `K` so the SAME resolver serves both the game roster (keyed by the sim's TankKind)
 * and the Wii reference taxonomy (keyed by TankType) -- see config/reference/.
 *
 * Pure: definition + numbers in, plain object out. No sim/render/DOM dependency.
 */
export function resolveTankConfig<K extends string>(
  key: K,
  tankDefinitions: Record<K, TankDefinition>,
  constants: BalanceConstants,
): ResolvedTankConfig {
  const definition = tankDefinitions[key];
  if (!definition) {
    throw new Error(`Unknown tank key: ${key}`);
  }

  const projectile = constants.projectiles[definition.weapon.projectileType];
  const ai = constants.aiProfiles[definition.aiProfile];

  if (!projectile) {
    throw new Error(`Unknown projectile type: ${definition.weapon.projectileType}`);
  }
  if (!ai) {
    throw new Error(`Unknown AI profile: ${definition.aiProfile}`);
  }

  return {
    displayName: definition.displayName,
    color: definition.color,
    firstMission: definition.firstMission,
    singlePlayerOnly: definition.singlePlayerOnly,
    movementSpeed: constants.movementSpeeds[definition.movementSpeed],
    rotationSpeed: constants.rotationSpeeds[definition.rotationSpeed],
    ai,
    behavior: ai.behavior,
    weapon: {
      ...projectile,
      bulletType: PROJECTILE_BULLET_TYPE[definition.weapon.projectileType],
      fireCooldown: constants.fireCooldowns[definition.weapon.fireRate],
      maxActiveProjectiles: definition.weapon.maxActiveProjectiles,
      ricochetCount: definition.weapon.ricochetCount,
    },
    mineCapacity: definition.mineCapacity,
    abilities: [...definition.abilities],
  };
}
