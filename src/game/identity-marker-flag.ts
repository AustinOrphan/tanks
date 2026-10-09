/**
 * The identity marker the game ships, the value that takes it back off, and which sessions
 * the default reaches (issue #922).
 *
 * THE RULING, recorded on #234: `shape` -- a circle, triangle, square or starburst per slot,
 * on the arena ring and beside the slot in the HUD stock strip -- ships as the FFA default,
 * decided on still evidence. The `identityMarker` flag STAYS as a KEPT ROLLBACK LEVER, the
 * exemption `.claude/rules/game.md` gives `topbar` and `menuTransition`: a later real-device
 * sitting may reverse the default, and a regression report about the marker has to be
 * checkable rather than remembered.
 *
 *  - THE RULED ARM IS THE `null` PATH IN AN FFA SESSION. No parameter, or `?dev=1` without
 *    one, draws `shape`. `DEV_FLAGS_OFF.identityMarker` stays `null`, as `topbar`'s does:
 *    `dev-config.test.ts` pins every valued flag to a null default, and `explainDevConfig`
 *    reads "present and equal to the default" as a rejected value, so a non-null default
 *    would report `?identityMarker=shape` as rejected.
 *  - THE REVERSAL VALUE IS `solid` (`IDENTITY_MARKER_REVERSAL`), named the way `topbar=full`
 *    names the pre-ruling bar. `?dev=1&identityMarker=solid` draws the solid hue-only ring
 *    and the unmarked strip, which is what every session drew before the ruling. No drawable
 *    style could do this: `roof` keeps the solid ring but adds crown blades and a strip glyph.
 *  - `arcs`, `shape` and `roof` still select themselves by name, in any session.
 *
 * FFA ONLY. The ruling's PP1 scope is the FFA ring and strip; team identity (#923) and shell
 * owner identity (#1024) are separate questions. Teams, co-op campaign and single-player
 * sessions draw exactly what they drew before. The default resolves in two places, because
 * the two consumers are built at different times:
 *
 *  - the RENDERER is built per session in `startGameWith`, from that session's flags, where
 *    `applyVersusToDeps` (the setup pane) or `parseDevFlags` (`?dev=1&mode=ffa`) has already
 *    put the mode. It resolves with `sessionIdentityMarker`. A mode-blind default would give
 *    teams tanks slot shapes in team colours, the confusion #923 describes, and change co-op
 *    rings, which the ruling did not cover.
 *  - the HUD is the page's, built once by `createBrowserDeps` with no session mode. It
 *    resolves with `stripIdentityMarker`, and stays FFA-only through its own per-entry gate:
 *    `renderVersusStocks` marks only an entry with no `team`, and a campaign status carries
 *    no stock strip at all.
 *
 * WHY `solid` IS NOT A STYLE. `IDENTITY_MARKER_STYLES` lists what the renderer and the HUD
 * can DRAW, and four tests pin that list. `solid` draws nothing: it resolves to `null` here,
 * before `createEntityViews` or `createHud` sees it, so those layers keep `null` as "no
 * marker" and never meet a value they would have to special-case. That matters at the HUD,
 * whose `identityMarkerIcon` draws the `shape` outline for any style that is neither `arcs`
 * nor `roof`.
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

/** The flag value that restores the pre-ruling solid ring and unmarked strip. */
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
 * The style an FFA session draws when the flag is absent.
 *
 * Annotated as `IdentityMarkerStyle` rather than left to infer `'shape'`, for the reason
 * `SHIPPED_TOPBAR_TREATMENT` is: a guard written against this constant stays a runtime
 * question rather than one TypeScript narrows away.
 */
export const SHIPPED_FFA_IDENTITY_MARKER: IdentityMarkerStyle = 'shape';

/**
 * The marker a session's renderer draws: a named style wherever it is named, nothing for the
 * reversal value, and the shipped style for an unflagged FFA session only.
 *
 * `mode` is the session's `devFlags.mode`, where `null` is a campaign-coop session (the same
 * fallback `startGameWith` gives `botAssignmentAllowed`).
 */
export function sessionIdentityMarker(
  flag: IdentityMarkerFlag | null,
  mode: GameMode | null,
): IdentityMarkerStyle | null {
  if (flag === IDENTITY_MARKER_REVERSAL) return null;
  if (flag !== null) return flag;
  return mode === 'ffa' ? SHIPPED_FFA_IDENTITY_MARKER : null;
}

/**
 * The marker the page's HUD draws beside each FFA stock-strip entry.
 *
 * Resolved as an FFA session would be, because FFA entries are the only ones it reaches:
 * the HUD's own `entry.team === undefined` test keeps a teams entry unmarked, so the HUD
 * needs no session mode, and has none when `createBrowserDeps` builds it.
 */
export function stripIdentityMarker(flag: IdentityMarkerFlag | null): IdentityMarkerStyle | null {
  return sessionIdentityMarker(flag, 'ffa');
}
