/**
 * The identity marker the game ships, the value that takes it back off, and which sessions
 * the default reaches (issue #922).
 *
 * THE RULING, recorded on #234: `shape` -- a circle, triangle, square or starburst per slot,
 * on the arena ring and beside the slot in the HUD stock strip -- ships as the FFA default,
 * decided on still evidence. (Since issue #1022 the strip draws it as the stocks themselves,
 * the `marks` row, rather than beside them; since issue #1128 Teams draws it too, below.) The
 * `identityMarker` flag STAYS as a KEPT ROLLBACK LEVER, the exemption `.claude/rules/game.md`
 * gives `topbar` and `menuTransition`: a later real-device sitting may reverse the default, and
 * a regression report about the marker has to be checkable rather than remembered.
 *
 *  - THE RULED ARM IS THE `null` PATH IN A VERSUS SESSION. No parameter, or `?dev=1` without
 *    one, draws `shape` in FFA and Teams. `DEV_FLAGS_OFF.identityMarker` stays `null`, as
 *    `topbar`'s does: `dev-config.test.ts` pins every valued flag to a null default, and
 *    `explainDevConfig` reads "present and equal to the default" as a rejected value, so a
 *    non-null default would report `?identityMarker=shape` as rejected.
 *  - THE REVERSAL VALUE IS `solid` (`IDENTITY_MARKER_REVERSAL`), named the way `topbar=full`
 *    names the pre-ruling bar. `?dev=1&identityMarker=solid` draws the solid hue-only ring,
 *    which is what every session drew before the ruling, and a stock strip of pips with no
 *    mark, in FFA and Teams alike: the `marks` row is drawn only under `shape` (issue #1022,
 *    `stockRowFor`). `shape`, the one drawable style, cannot do this.
 *  - `shape` selects itself by name, in any session. `arcs` and `roof` were deleted (issue
 *    #1023) and are rejected like any unknown value.
 *
 * VERSUS ONLY: FFA AND TEAMS. The ruling on #234 scoped its PP1 default to the FFA ring and
 * strip, and #923 recorded the worry that slot shapes drawn in team colors would state slot
 * and team "as one confused signal", so until 2026-10-31 Teams drew the solid ring and a strip
 * of pips beside its A/B/C letter. Ruled 2026-10-31 (#1128, recorded on #923): the shapes
 * always say which player is which, so a Teams tank carries its own slot's shape too, drawn
 * in its team's color, and a Teams stock entry draws that slot's `marks` row after its letter.
 * The two channels each carry one meaning: the shape says which player, the ring colour and
 * the letter say which side. A team cue on the arena that does not lean on color is #923's,
 * after the cutover. Co-op campaign and single-player sessions draw exactly what they drew
 * before, and shell owner identity (#1024) is a separate question. The default resolves in
 * two places, because the two consumers are built at different times:
 *
 *  - the RENDERER is built per session in `startGameWith`, from that session's flags, where
 *    `applyVersusToDeps` (the setup pane) or `parseDevFlags` (`?dev=1&mode=`) has already
 *    put the mode. It resolves with `sessionIdentityMarker`. A mode-blind default would
 *    change co-op rings, which neither ruling covered.
 *  - the HUD is the page's, built once by `createBrowserDeps` with no session mode. It
 *    resolves with `stripIdentityMarker`, as a versus session would: only a versus status
 *    carries a stock strip, and FFA and Teams resolve alike, so it needs no mode. A campaign
 *    status carries no strip at all.
 *
 * WHY `solid` IS NOT A STYLE. `IDENTITY_MARKER_STYLES` lists what the renderer and the HUD
 * can DRAW, and tests pin that list. `solid` draws nothing: it resolves to `null` here,
 * before `createEntityViews` or `createHud` sees it, so those layers keep `null` as "no
 * marker" and never meet a value they would have to special-case. That matters at the
 * renderer, whose `identityMarkerGeometry` draws the `shape` outline for any non-null style
 * since issue #1023 left `shape` the one style: a leaked `solid` would draw `shape` on the
 * ring.
 *
 * In `src/game/` rather than `src/presentation/` because both readers are the flag layer and
 * its wiring (`devflags.ts`, `loop.ts`); `presentation/identity-marker.ts` keeps the drawable
 * vocabulary that the renderer reads too.
 */
import type { GameMode } from '../sim/types';
import {
  IDENTITY_MARKER_STYLES,
  isIdentityMarkerStyle,
  type IdentityMarkerStyle,
} from '../presentation/identity-marker';

/** The flag value that restores the pre-ruling solid ring, with a stock strip of pips and no mark. */
export const IDENTITY_MARKER_REVERSAL = 'solid';

/** What `?dev=1&identityMarker=` accepts: a drawable style, or the reversal value. */
export type IdentityMarkerFlag = IdentityMarkerStyle | typeof IDENTITY_MARKER_REVERSAL;

/** The flag's whole vocabulary, in the order the registry and the developer pane list it. */
export const IDENTITY_MARKER_FLAG_VALUES: readonly IdentityMarkerFlag[] = [
  ...IDENTITY_MARKER_STYLES,
  IDENTITY_MARKER_REVERSAL,
];

/** The parse-side guard (`asIdentityMarker` in devflags.ts). */
export function isIdentityMarkerFlag(raw: string): raw is IdentityMarkerFlag {
  return raw === IDENTITY_MARKER_REVERSAL || isIdentityMarkerStyle(raw);
}

/**
 * The style a versus session, FFA or Teams, draws when the flag is absent.
 *
 * Annotated as `IdentityMarkerStyle` rather than left to infer `'shape'`, for the reason
 * `SHIPPED_TOPBAR_TREATMENT` is: a guard written against this constant stays a runtime
 * question rather than one TypeScript narrows away.
 */
export const SHIPPED_VERSUS_IDENTITY_MARKER: IdentityMarkerStyle = 'shape';

/**
 * The marker a session's renderer draws: a named style wherever it is named, nothing for the
 * reversal value, and the shipped style for an unflagged versus session, FFA or Teams, only.
 *
 * `mode` is the session's `devFlags.mode`, where `null` is a campaign-coop session (the same
 * fallback `startGameWith` gives `botAssignmentAllowed`). Each mode is named rather than
 * tested as "not co-op", so a mode added later starts on the solid ring until it is ruled on.
 */
export function sessionIdentityMarker(
  flag: IdentityMarkerFlag | null,
  mode: GameMode | null,
): IdentityMarkerStyle | null {
  if (flag === IDENTITY_MARKER_REVERSAL) return null;
  if (flag !== null) return flag;
  return mode === 'ffa' || mode === 'teams' ? SHIPPED_VERSUS_IDENTITY_MARKER : null;
}

/**
 * The marker the page's HUD draws every stock-strip entry by: `shape` draws the `marks` row,
 * after the A/B/C letter in Teams, and anything else pips (issues #1022, #1128,
 * `stockRowFor`).
 *
 * Resolved as an FFA session would be. The strip exists only in versus, and FFA and Teams
 * resolve alike, so the HUD needs no session mode, and has none when `createBrowserDeps`
 * builds it.
 */
export function stripIdentityMarker(flag: IdentityMarkerFlag | null): IdentityMarkerStyle | null {
  return sessionIdentityMarker(flag, 'ffa');
}
