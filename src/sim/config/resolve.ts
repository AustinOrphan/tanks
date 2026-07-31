import type { BulletType } from '../types';
import { ProjectileType, TankAbility } from './enums';
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

  // EVERY class lookup is guarded, not just the two above: reference data enters
  // through `as` casts (JSON), where the Record<> types check nothing, and an
  // unguarded miss resolves to a silent `undefined` stat -- the partial config
  // this function's contract (and resolve.test.ts) promises can never exist.
  const movementSpeed = constants.movementSpeeds[definition.movementSpeed];
  const rotationSpeed = constants.rotationSpeeds[definition.rotationSpeed];
  const fireCooldown = constants.fireCooldowns[definition.weapon.fireRate];
  if (movementSpeed === undefined) {
    throw new Error(`Unknown movement speed class: ${definition.movementSpeed}`);
  }
  if (rotationSpeed === undefined) {
    throw new Error(`Unknown rotation speed class: ${definition.rotationSpeed}`);
  }
  if (fireCooldown === undefined) {
    throw new Error(`Unknown fire rate class: ${definition.weapon.fireRate}`);
  }

  // Cross-field authoring lint: a profile inclined to lay mines on a tank without
  // the MINE_LAYER ability would propose mines every tick that the dispatcher
  // silently discards -- a config mistake with no loud failure anywhere else.
  if ((ai.minePlacementChance ?? 0) > 0 && !definition.abilities.includes(TankAbility.MINE_LAYER)) {
    throw new Error(
      `Profile ${definition.aiProfile} is mine-inclined (minePlacementChance > 0) ` +
      `but the definition lacks the MINE_LAYER ability`,
    );
  }

  return {
    displayName: definition.displayName,
    color: definition.color,
    firstMission: definition.firstMission,
    singlePlayerOnly: definition.singlePlayerOnly,
    movementSpeed,
    rotationSpeed,
    // A COPY, like weapon and abilities below: without it the resolved config
    // holds a live reference into the balance table, so two kinds sharing a
    // profile share one object and a stray mutation rewrites global balance.
    // Pinned by the isolation test in resolve.test.ts.
    ai: { ...ai },
    behavior: ai.behavior,
    weapon: {
      ...projectile,
      bulletType: PROJECTILE_BULLET_TYPE[definition.weapon.projectileType],
      fireCooldown,
      maxActiveProjectiles: definition.weapon.maxActiveProjectiles,
      ricochetCount: definition.weapon.ricochetCount,
    },
    mineCapacity: definition.mineCapacity,
    abilities: [...definition.abilities],
  };
}
