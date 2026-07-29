/**
 * Opt-in switches for work that is finished but not shipped.
 *
 * Nothing here is on unless `dev` is present in the query string, so a stray
 * `?roundPhaseHud=1` in a shared link does nothing on its own. Flipping a flag
 * needs both: `?dev=1&roundPhaseHud=1`.
 *
 * Parsing a string rather than reading `location` directly keeps this a pure
 * function, so the whole table is assertable without a browser.
 */
export interface DevFlags {
  /**
   * Draw the player's computed aim: a ray along the turret and a marker where
   * screenToGround says the cursor lands.
   *
   * NOT a missing feature made optional. The BARREL is the aim indicator, by
   * design; this exists to debug the mapping behind it, which is otherwise
   * invisible -- a wrong screenToGround and a correctly-drawn barrel look
   * identical on screen.
   */
  aimRay: boolean;
  /**
   * Show shells in flight against SHELL_CAP.
   *
   * Also deliberate: the cap is meant to be felt, not read. This is for
   * telling "the cap is working" apart from "the cannon is broken" while
   * developing -- the two are indistinguishable from the player's seat, which
   * is the point in the game and a nuisance in a debugger.
   */
  shellCount: boolean;
}

export const DEV_FLAGS_OFF: DevFlags = { aimRay: false, shellCount: false };

/** Values that read as "off" when a flag is present but negative. */
const FALSY = new Set(['0', 'false', 'off', 'no']);

function isOn(params: URLSearchParams, name: string): boolean {
  if (!params.has(name)) return false;
  const raw = params.get(name);
  // `?dev` with no value is on; `?dev=0` is not.
  if (raw === null || raw === '') return true;
  return !FALSY.has(raw.toLowerCase());
}

/**
 * @param search a `location.search`, with or without the leading `?`.
 */
export function parseDevFlags(search: string): DevFlags {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!isOn(params, 'dev')) return DEV_FLAGS_OFF;
  return { aimRay: isOn(params, 'aimRay'), shellCount: isOn(params, 'shellCount') };
}
