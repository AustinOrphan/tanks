/**
 * Which typeface the HUD is drawn in, behind `?dev=1&hudFont=` (issue #865).
 *
 * A TEMPORARY OPEN-QUESTION FLAG, not a theming feature: issue #864 bundled IBM Plex and the
 * two faces it beat were kept available to try later rather than discarded. Once one is ruled
 * on, the winner becomes unconditional and this module and its flag are deleted.
 *
 * THE SHIPPED FACE IS THE ABSENCE OF A VALUE, as with every other arm flag here: `null` leaves
 * `--hud-font` and `--hud-font-mono` exactly as `hud.css` declares them, which is Plex.
 *
 *  - `atkinson` -- Atkinson Hyperlegible, drawn by the Braille Institute to make characters
 *                  hard to CONFUSE with one another rather than merely legible. That is the
 *                  same argument the rest of this codebase makes for non-colour cues, which is
 *                  why it is worth a look at HUD sizes rather than only in prose.
 *  - `inter`    -- drawn as a `system-ui` substitute, and the closest of the three to what the
 *                  HUD looked like before #864 bundled anything.
 *
 * WEIGHTS DIFFER BETWEEN THE ARMS, and the difference is the thing to watch rather than a
 * defect to hide. The HUD asks for 100-700. Plex Sans and Inter are variable and cover it;
 * Atkinson Hyperlegible ships 400 and 700 only, so a browser SYNTHESISES the rest -- thin
 * weights are drawn at 400 and mid weights step to the nearer of the two. For a developer arm
 * that is acceptable, and it is stated here so that "the thin text looks wrong under
 * atkinson" is read as the arm's own coverage rather than as a bug in the HUD.
 *
 * NO MONO ARM. Both alternates are sans; neither ships a monospace companion this HUD could
 * pair with, so `--hud-font-mono` stays Plex Mono under every arm. Readouts that use it --
 * timers, stock counts, the diagnostics pane -- therefore do not change between arms, which
 * also makes them a fixed reference when comparing two captures.
 */
export const HUD_FONTS = ['atkinson', 'inter'] as const;

export type HudFont = (typeof HUD_FONTS)[number];

export function isHudFont(value: unknown): value is HudFont {
  return typeof value === 'string' && (HUD_FONTS as readonly string[]).includes(value);
}

/**
 * The class the HUD root wears for an arm, or `null` for the shipped face.
 *
 * A CLASS ON THE HUD ROOT rather than a `:root` custom-property override, following
 * `menuTransitionClass`. The HUD owns its own type vocabulary: a `:root` override would also
 * repaint anything outside `.hud` that ever inherits these properties, and this flag is meant
 * to answer "how does the HUD read in this face", not "what does the page look like".
 */
export function hudFontClass(font: HudFont | null): string | null {
  return font === null ? null : `hud-font--${font}`;
}
