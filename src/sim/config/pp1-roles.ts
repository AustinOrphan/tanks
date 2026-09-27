import type { TankKind } from '../types';

/**
 * The PP1 role-first ordnance budgets (issue #358), as an experiment arm. Not shipped
 * balance: these apply only behind `?dev=1&pp1Roles=1`; with the flag absent every tank
 * resolves `configFor(kind).weapon.maxActiveProjectiles` as before.
 *
 * Each value is the top of its band: the issue gives ranges, not values, and the top is the
 * smallest role-shaped step off the shipped 5, so the arm is the one least likely to need the
 * difficulty compensations the issue restricts.
 *
 * Yellow is absent deliberately: the issue places it outside PP1 because no shipped campaign
 * level contains it, and a kind with no entry keeps its authored cap even with the flag on.
 */
export const PP1_ROLE_SHELL_CAPS: Partial<Record<TankKind, number>> = {
  player: 4, // stable generalist kit
  brown: 2, // stationary direct-fire sentry
  grey: 3, // defensive kiter
  teal: 3, // mobile ricochet skirmisher
  olive: 1, // fast zero-bounce rocket threat -- the CONTROL, already shipped at 1
  green: 2, // stationary ricochet sniper
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
 * The PP1 mine directions, as capacities (issue #358's second axis).
 *
 * Grey is absent deliberately: its approved direction, "deliberate retreat-oriented
 * placement", is a mine-laying policy the AI does not have, and inventing one would put an
 * AI behaviour change inside an experiment meant to isolate ordnance budgets. Grey keeps its
 * authored capacity under this arm.
 *
 * Player and Olive match the shipped roster but are listed because the 2026-08-26 matrix
 * states a direction for them; pp1-roles.test.ts pins each against `configFor`, so a drift
 * in the shipped value fails loudly.
 */
export const PP1_ROLE_MINE_CAPS: Partial<Record<TankKind, number>> = {
  player: 2, // "retain the current two-mine capacity"
  brown: 0, // stationary direct-fire sentry: none
  teal: 0, // tested WITHOUT mines, to remove overlap with its ricochet role
  olive: 0, // none
  green: 0, // stationary ricochet sniper: none
};
