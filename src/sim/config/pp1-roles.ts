import type { TankKind } from '../types';

/**
 * The PP1 role-first ordnance budgets (issue #358), as an EXPERIMENT ARM.
 *
 * The owner decision of 2026-08-26 approved a role-first roster with lower, role-specific
 * active-ordnance budgets, and it was never implemented: five of the six PP1 kinds still
 * ship a flat, role-blind `maxActiveProjectiles: 5`. Brown is specified as a stationary
 * direct-fire sentry and carries five shells. So there has been nothing to validate -- the
 * roster is still the arrangement that decision replaced.
 *
 * NOT SHIPPED BALANCE. These apply only behind `?dev=1&pp1Roles=1`; with the flag absent
 * every tank resolves `configFor(kind).weapon.maxActiveProjectiles` exactly as before. That
 * is the whole point of the 2026-09-06 decision: the approved design becomes playable on
 * demand without a blind balance change to every campaign encounter.
 *
 * WHY THE UPPER BOUND OF EACH RANGE. The issue gives ranges, not values -- "experiment
 * inputs, not predetermined shipped values" -- so an arm has to choose. This one takes the
 * top of each band, which is the smallest step off the shipped 5 that is still role-shaped.
 * The issue also forbids compensating for a difficulty drop by restoring projectile
 * saturation or sharpening aim, and orders the compensations that ARE allowed; a gentler
 * first arm is the one least likely to need any of them, which keeps the experiment about
 * ordnance rather than about everything downstream of it.
 *
 * The lower bound of each band is the obvious second arm. Changing these numbers is a
 * one-line edit here and needs no other change, which is the property this table exists for.
 *
 * YELLOW IS ABSENT, deliberately and not by omission: the issue places it outside PP1
 * because no shipped campaign level contains it. A kind with no entry keeps its authored
 * cap even with the flag on, so adding Yellow to the campaign later does not silently opt it
 * into an experiment nobody ran for it.
 */
export const PP1_ROLE_SHELL_CAPS: Partial<Record<TankKind, number>> = {
  player: 4, // stable generalist kit, band 3-4
  brown: 2, // stationary direct-fire sentry, band 1-2
  grey: 3, // defensive kiter, band 2-3
  teal: 3, // mobile ricochet skirmisher, band 2-3
  olive: 1, // fast zero-bounce rocket threat -- the band's CONTROL, and already shipped at 1
  green: 2, // stationary ricochet sniper, band 1-2
};

/**
 * The bands the issue authorises, kept beside the arm so a value that drifts out of its
 * approved range fails a test rather than shipping as a quiet retune. Olive's band is a
 * single value because the issue names it as the control.
 */
export const PP1_ROLE_BANDS: Partial<Record<TankKind, readonly [number, number]>> = {
  player: [3, 4],
  brown: [1, 2],
  grey: [2, 3],
  teal: [2, 3],
  olive: [1, 1],
  green: [1, 2],
};

/**
 * The PP1 mine directions, as CAPACITIES (issue #358's second axis).
 *
 * The 2026-08-26 matrix gives each kind a mine direction, and three of them are plain
 * capacity statements: Brown and Green carry "none", and Teal is to be tested "without
 * mines to remove role overlap" with its ricochet-skirmisher role. Those are the entries
 * that can be an ordnance arm at all.
 *
 * GREY IS DELIBERATELY ABSENT. Its approved direction is "deliberate retreat-oriented
 * placement", which is a mine-laying POLICY and not a number -- the AI has no such policy
 * today, and inventing one would put an AI behaviour change inside an experiment whose
 * point is to isolate ordnance budgets. It also sits on the `behaviour` rung of the
 * difficulty-compensation ladder this issue orders, which is only to be reached after
 * evidence of a difficulty drop. Grey therefore keeps its authored capacity under this arm.
 *
 * Player and Olive are listed although they MATCH the shipped roster, because the matrix
 * states a direction for them ("retain the current two-mine capacity", "none") and a test
 * below pins each against `configFor`. That way the arm's "matches" claim fails loudly if
 * the shipped value ever moves, instead of the table quietly ceasing to be the matrix.
 */
export const PP1_ROLE_MINE_CAPS: Partial<Record<TankKind, number>> = {
  player: 2, // "retain the current two-mine capacity" -- matches the shipped roster
  brown: 0, // stationary direct-fire sentry: none
  teal: 0, // tested WITHOUT mines, to remove overlap with its ricochet role
  olive: 0, // none -- matches the shipped roster
  green: 0, // stationary ricochet sniper: none
};
