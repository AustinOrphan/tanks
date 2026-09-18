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
 * THAT SENTENCE WAS ABOUT DECAL SURFACES, AND IT MISSED THE BIGGEST MASS ON THE TANK (issue
 * #831). Reading "the barrel and the hull side" as the whole remaining budget skipped the
 * hull's own PLAN OUTLINE, which is not a surface to print on but a silhouette to reshape. It
 * was never rendered and therefore never rejected: the ceiling argument above says no
 * silhouette change can separate brown from grey, which is true and is a statement about those
 * two kinds being temporally distinguished, not a finding that reshaping the hull reads poorly.
 * The hull is also the one part that never turns away from a camera looking down at 51
 * degrees, which is what killed the flank `band`.
 *
 *  - `hull` puts WEAPON CLASS on the hull's nose taper and corner radius: a wedge, the shipped
 *    body, a lozenge. It spends neither width nor length -- both are pinned, `HULL_WIDTH` to
 *    `TANK_RADIUS * 2` exactly and the plan ratio to (0.8, 1.3), because a hull that misreports
 *    the collider is the bug `tank-model.ts` records -- so it spends the two plan parameters
 *    that are free of both.
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
export const ENEMY_ROLE_CUES = [
  // WEAPON CLASS, four ways of saying the same three states.
  'girth',   // barrel tube thickness
  'flare',   // muzzle size
  'dome',    // turret height
  'hull',    // hull nose taper and corner radius (issue #831)
  // MINE LOAD, three ways.
  'deck',    // a flat bar on the deck ahead of the turret, varying in width
  'riser',   // the same bar raised into a block, so it casts and reads in silhouette
  'crown',   // turret diameter
  // THE APPROVED ARM (issue #773): the two that measured best, together -- the only way to
  // see whether two cues on one 40px silhouette read as a grammar or as noise. `flare` and
  // `riser` are the pair #678's comparison found clearest and the owner approved on
  // 2026-09-15; this value pulled `girth` and `deck` until then, which is what the first
  // three-lever vocabulary meant by it, before the six-lever comparison had a verdict.
  'both',
] as const;

export type EnemyRoleCue = (typeof ENEMY_ROLE_CUES)[number];

export function isEnemyRoleCue(value: unknown): value is EnemyRoleCue {
  return typeof value === 'string' && (ENEMY_ROLE_CUES as readonly string[]).includes(value);
}

/** Which lever a cue pulls; `both` pulls the two that measured best. */
export function weaponLever(cue: EnemyRoleCue | null): 'girth' | 'flare' | 'dome' | 'hull' | null {
  if (cue === 'girth') return 'girth';
  if (cue === 'flare' || cue === 'both') return 'flare';
  if (cue === 'dome') return 'dome';
  if (cue === 'hull') return 'hull';
  return null;
}

export function mineLever(cue: EnemyRoleCue | null): 'deck' | 'riser' | 'crown' | null {
  if (cue === 'deck') return 'deck';
  if (cue === 'riser' || cue === 'both') return 'riser';
  if (cue === 'crown') return 'crown';
  return null;
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

/**
 * The shipped tank, scaled by whichever weapon lever a cue pulls -- all three carry the same
 * three states, ordered by the bounce budget, so they can be compared against each other
 * rather than against a different claim.
 *
 * Returned as multipliers of the shipped values, so an unpulled lever is exactly 1 and the
 * shipped tank does not move a vertex.
 */
export function weaponShapeFor(
  lever: 'girth' | 'flare' | 'dome' | 'hull' | null, bulletType: BulletType,
): { barrelGirth?: number; muzzleFlare?: number; turretTall?: number; hullNose?: number; hullCorner?: number } {
  if (lever === null) return {};
  const step = bulletType === 'fast' ? -1 : bulletType === 'ricochet' ? 1 : 0;
  if (lever === 'girth') return { barrelGirth: [0.78, 1, 1.4][step + 1] };
  if (lever === 'flare') return { muzzleFlare: [0.7, 1, 1.55][step + 1] };
  if (lever === 'hull') return hullShapeFor(step);
  return { turretTall: [0.72, 1, 1.4][step + 1] };
}

/**
 * The hull lever, as ABSOLUTE plan parameters rather than multipliers -- the only lever here
 * that is, and the clamps are why.
 *
 * `hullPlan` puts `nose` through `clamp01`, and the shipped value is already 1: "no taper at
 * all" is the ceiling, so a multiplier could only ever move the `fast` end and would read as
 * 1.0 for two of the three states. `round` is clamped to `min(round, halfW * 0.9, halfL *
 * 0.45)`, which is 0.45 on the 1.0-square hull, so the corner has a hard ceiling too. Absolute
 * values state where each end sits against those ceilings instead of hiding them behind a
 * ratio.
 *
 * CORNER CARRIES ALL THREE STATES; NOSE SHARPENS THE OUTLIER. Because nose cannot go above the
 * shipped 1, it separates `fast` from the other two and nothing else. Corner is the axis that
 * actually orders the three: 0.16 is a near-square wedge, 0.3 is shipped, 0.45 is the clamp
 * ceiling and reads as a lozenge.
 *
 * Ordered by the bounce budget like every other weapon lever, so the seven can be compared
 * against each other: sharper is straighter, blunter comes back more often. That is the one
 * property that made `girth` strongest of the first three -- a direction-of-travel meaning
 * needs no legend.
 */
function hullShapeFor(step: -1 | 0 | 1): { hullNose: number; hullCorner: number } {
  return {
    hullNose: [0.62, 1, 1][step + 1],
    hullCorner: [0.16, 0.3, 0.45][step + 1],
  };
}

/**
 * The same, for mine load. `crown` is the odd one: it spends the turret's DIAMETER, which is
 * the biggest uninterrupted shape on the tank -- and also the surface #630 wants for owner
 * identity, so it is here to be measured rather than because it is available.
 */
export function mineShapeFor(
  lever: 'deck' | 'riser' | 'crown' | null, mineCapacity: number,
): { deckBar?: number; raised?: boolean; turretWide?: number } {
  if (lever === null) return {};
  const step = mineCapacity <= 0 ? 0 : mineCapacity <= 2 ? 1 : 2;
  if (lever === 'crown') return { turretWide: [0.82, 1, 1.22][step] };
  return { deckBar: [0, 0.3, 0.62][step], raised: lever === 'riser' };
}
