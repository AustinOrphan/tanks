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
import type { UnarmedTrigger } from '../sim/types';

export interface DevFlags {
  /**
   * Round-start phase feedback in the HUD: a banner on the first round of the
   * page load, a topbar chip on every round after it. The round opens with 3.0s
   * where nothing moves and 2.0s where nothing fires, applied to the AI too,
   * and the HUD says nothing about either.
   */
  roundPhaseHud: boolean;
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
  /**
   * Fix the world seed instead of deriving one from the clock.
   *
   * The seed is normally `deriveSeed(Date.now())`, so no two sessions are the
   * same fight -- which is right for playing and useless for comparing. Pinning
   * it makes a scripted playthrough reproducible, so a before/after recording
   * shows the change rather than a different game.
   *
   * `null` when absent or unusable. 0 is rejected: the PRNG treats it as
   * degenerate, which is why deriveSeed never returns it.
   */
  seed: number | null;
  /**
   * What may detonate an UNARMED mine, for playtesting the "instant bomb".
   *
   * `null` leaves the world's own default ('none', the shipped rule). This
   * chooses what world is CREATED; the sim reads the field off the world, never
   * a flag, so a replay stays an exact function of its inputs.
   */
  mineTrigger: UnarmedTrigger | null;

  /**
   * Ring a mine's proximity-trigger radius and its kill radius.
   *
   * A mine is a 0.28 puck that kills at 2.5, so it shows about one part in eighty of the
   * ground it covers. That is deliberate -- a mine you can read perfectly is a much
   * weaker weapon -- which is exactly why the numbers need playtesting rather than
   * shipping. The two rings are separate because triggering and dying are separate
   * radii, and the gap between them is the counter-intuitive part.
   */
  mineReach: boolean;

  /** Show each mine's remaining fuse, in seconds, beside it. */
  mineTimer: boolean;
}

export const DEV_FLAGS_OFF: DevFlags = {
  roundPhaseHud: false,
  aimRay: false,
  shellCount: false,
  seed: null,
  mineTrigger: null,
  mineReach: false,
  mineTimer: false,
};

/** Values that read as "off" when a flag is present but negative. */
const FALSY = new Set(['0', 'false', 'off', 'no']);

const MINE_TRIGGERS = new Set(['none', 'proximity', 'bullet', 'both']);

/** One of the four UnarmedTrigger values, or null when absent or unrecognised. */
function asMineTrigger(params: URLSearchParams): UnarmedTrigger | null {
  const raw = params.get('mineTrigger');
  if (raw === null) return null;
  return MINE_TRIGGERS.has(raw) ? (raw as UnarmedTrigger) : null;
}

/** A positive integer flag, or null when absent, empty, or not one. */
function asSeed(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

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
  return {
    roundPhaseHud: isOn(params, 'roundPhaseHud'),
    aimRay: isOn(params, 'aimRay'),
    shellCount: isOn(params, 'shellCount'),
    seed: asSeed(params, 'seed'),
    mineTrigger: asMineTrigger(params),
    mineReach: isOn(params, 'mineReach'),
    mineTimer: isOn(params, 'mineTimer'),
  };
}
