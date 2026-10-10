import { FLAG_REGISTRY, PLAYTEST_BUNDLE, type DevFlags } from './devflags';

/**
 * THE DEVELOPER PARAMETERS' NAMES, AND LEAVING THEM (issue #1012).
 *
 * Split out of `dev-config.ts` because the Exit Developer Mode action needs this much and
 * nothing more, and the page binds that action on every load (`createBrowserDeps`). Importing it
 * from `dev-config.ts` put the whole configuration model in the chunk an ordinary page
 * downloads, for one function called at a press.
 *
 * A LEAF. It must not import `dev-config.ts`, nor re-export from it: either would carry the
 * developer module back into the ordinary chunk under another name (#977 recorded that trap).
 * `dev-config.ts` imports from here instead.
 */

/** Every query parameter the developer configuration knows how to read. */
export function knownDevParams(): readonly string[] {
  const fields = Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[];
  return ['dev', PLAYTEST_BUNDLE.param, ...fields.map((f) => FLAG_REGISTRY[f].param ?? f)];
}

/** A query string as parameters, with or without its leading `?`. */
export function toParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/**
 * Developer parameters that were once accepted and no longer are.
 *
 * EMPTY, and deliberately so rather than omitted: no developer parameter has been removed
 * yet, so a populated list would be invented history. The mechanism is real and injectable
 * (`canonicalDevSearch`'s `deprecated` option) and `dev-config.test.ts` proves it with an
 * injected list, so the first real removal is a one-line edit here rather than a new feature.
 *
 * Without such a list the configuration model CANNOT tell a deprecated developer parameter
 * from an unrelated application one -- both are simply "not known" -- and `unknownParams`
 * reports them together. That is a stated limit, not an oversight.
 */
export const DEPRECATED_DEV_PARAMS: readonly string[] = [];

/**
 * The query string to leave developer mode with (issue #243).
 *
 * The COMPLEMENT of `canonicalDevSearch` in `dev-config.ts`, and deliberately not a mode of
 * it. That function KEEPS every developer parameter and only chooses whether to carry the
 * gate, because its job is to produce a shareable canonical developer URL; `keepGate: false`
 * therefore still returns `?aimRay=1&topbar=...`, which is a developer URL missing its
 * gate rather than an ordinary one. Exiting is the opposite operation: every known
 * developer parameter goes, the master gate included.
 *
 * Unrelated parameters survive with their order and their duplicates intact, because they
 * belong to something else -- a deep link, a campaign tag, a router -- and leaving
 * developer mode has no standing to normalise them.
 *
 * Retired parameters are dropped as well. They were developer parameters, so leaving one
 * behind would mean an Exit that produces a URL still carrying developer state.
 *
 * @param search a `location.search`, with or without the leading `?`.
 * @returns a search string with a leading `?`, or `''` when nothing is left.
 */
export function developerExitSearch(
  search: string,
  deprecated: readonly string[] = DEPRECATED_DEV_PARAMS,
): string {
  const drop = new Set([...knownDevParams(), ...deprecated]);
  const out = new URLSearchParams();
  for (const [k, v] of toParams(search).entries()) {
    if (drop.has(k)) continue;
    out.append(k, v);
  }
  const s = out.toString();
  return s === '' ? '' : `?${s}`;
}
