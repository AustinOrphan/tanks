import type { BulletType } from '../sim/types';

/**
 * Non-colour cues for what an ENEMY does (issue #357).
 *
 * THE PROBLEM, measured rather than asserted. Every enemy kind shares one hull, one turret,
 * one barrel and one track set; #137's two-tone texture is the same pattern on all of them.
 * `npm run gallery -- --elements roster --view game` (the subject #671 added for this) poses
 * all six at the shipped camera in one pose, and the render is the problem statement: identical
 * geometry, separated by hue alone.
 *
 * THE CEILING, and it decides the shape of this whole vocabulary. Grouping the roster by what
 * a STILL FRAME could possibly encode does not separate into six:
 *
 *   weapon class + bounce count -> 3 groups (brown/grey/yellow collide, teal/green collide)
 *   + mine load                 -> 4 groups (yellow separates; the other two pairs do not)
 *   + anything else static      -> still 4
 *
 * Brown and grey carry the same projectile, the same bounce count, the same shell cap and the
 * same mine load. So do teal and green. They differ only in movement speed, rotation speed,
 * fire rate and AI behaviour -- every one of which is TEMPORAL. So no decal, badge, barrel
 * treatment or silhouette change can separate those two pairs, because there is nothing static
 * to separate. A markings grammar tops out at FOUR legible groups, and that is a ceiling rather
 * than a tuning problem. Closing the last two pairs needs a motion cue, which is a separate
 * experiment because it cannot be judged from a screenshot.
 *
 * WHICH CHANNELS ARE FREE, which is why these two arms and not others. The turret crown is the
 * best surface on the tank and nothing occludes it -- which is exactly why #630 wants it for
 * OWNER identity; in co-op a role cue there would read as "this enemy is player three". The
 * tracks are #286's, and `TREAD_IDENTITY_BLEND` already leans them toward identity. That
 * leaves the barrel and the hull side.
 *
 *  - `barrel` puts WEAPON CLASS on the barrel: standard shell, zero-bounce rocket, two-bounce
 *    ricochet. The one channel that is semantically the weapon, so it needs no legend, and the
 *    one the player is asking about when a shell is already in the air.
 *  - `band` puts MINE LOAD on the hull side: none, two, four. A quantity on a surface that
 *    suits quantities -- 1.0 long by 0.4 high, and 0.25 of that effective at the 51-degree
 *    camera, which is enough for a stripe count and not for a glyph.
 *  - `both` runs them together, which is the only way to see whether two cues on one small
 *    silhouette read as a grammar or as noise.
 *
 * Absent means the shipped board: hue alone.
 */
export const ENEMY_ROLE_CUES = ['barrel', 'band', 'both'] as const;

export type EnemyRoleCue = (typeof ENEMY_ROLE_CUES)[number];

export function isEnemyRoleCue(value: unknown): value is EnemyRoleCue {
  return typeof value === 'string' && (ENEMY_ROLE_CUES as readonly string[]).includes(value);
}

/** Does this cue draw the barrel treatment? `both` draws everything. */
export function cuesWeapon(cue: EnemyRoleCue | null): boolean {
  return cue === 'barrel' || cue === 'both';
}

/** Does this cue draw the hull-side mine band? */
export function cuesMines(cue: EnemyRoleCue | null): boolean {
  return cue === 'band' || cue === 'both';
}

/**
 * How thick the barrel is, as a multiple of the shipped tube.
 *
 * THE COLLAR COUNT DID NOT SURVIVE MEASUREMENT and this replaces it. At the shipped camera a
 * hull is 89px wide near the viewer and about 40px far, so the visible barrel is 20-44px and
 * a collar is 2-4px: not countable at any boldness that keeps the toy-tank silhouette. Girth
 * changes the whole length of the barrel at once, so the difference is the full 20-44px run
 * rather than a feature inside it.
 *
 * Still keyed to the bounce budget, and still ordered by it -- a fatter gun throws a shell
 * that comes back more often. The mapping is coarser than a count and that is the point: three
 * thicknesses is what this many pixels can carry.
 */
export function barrelGirthFor(bulletType: BulletType): number {
  switch (bulletType) {
    case 'fast': return 0.78;
    case 'ricochet': return 1.4;
    default: return 1;
  }
}

/**
 * How much of the hull top a mine-load block covers, as a fraction of its length.
 *
 * AREA, NOT A COUNT, for the same measurement that killed the collars: one stripe against two
 * is a few pixels at play distance, but a filled block covering a third of the hull against
 * two thirds is tens of pixels of value. The hull top is the one large surface nothing has
 * claimed -- 1.0 by 1.0, foreshortening to about 89 by 69 px near the camera -- and unlike the
 * hull SIDE (0.25 units effective, 10px far) it does not vanish when the tank turns.
 *
 * Zero for a kind that lays no mines, so olive carries a clean deck and reads as the outlier
 * it is.
 */
export function mineBlockFor(mineCapacity: number): number {
  if (mineCapacity <= 0) return 0;
  return mineCapacity <= 2 ? 0.3 : 0.62;
}
