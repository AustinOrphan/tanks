/**
 * The render-quality PRESET NAMES, and which one ships (issue #540).
 *
 * WHY THE NAMES LIVE HERE AND THE TABLE DOES NOT. `render/quality.ts` owns what a preset
 * MEANS -- antialias, pixel-ratio cap, shadow map size, shadow filter, and since issue
 * #546 whether the muzzle-smoke system is constructed at all -- and that table names
 * `THREE.ShadowMapType`, so nothing outside `render/` may read it. The three IDS are a
 * different kind of thing: since #540 they are a stored player preference
 * (`game/settings.ts`), a control in the Settings pane (`game/hud.ts`), and the accepted
 * domain of `?dev=1&quality=` (`game/devflags.ts`) -- three application modules, none of
 * which may import a renderer module.
 *
 * `src/dependency-direction.test.ts` wrote this move down before it happened: its
 * GAME_WIRING comment allowed `devflags.ts` to reach `render/quality` only as a
 * developer-flag vocabulary, "if either becomes a Setting, its NAMES move to
 * presentation/ and this entry goes". It became one, so they did.
 *
 * DATA ONLY, in both directions. Nothing here knows what a preset costs or draws;
 * `render/quality.ts` remains the only file that does, and it reads its own ids from here
 * so the two lists cannot drift apart.
 */

/**
 * The presets, CHEAPEST FIRST.
 *
 * The order is not decorative: `devflags.ts` prints this array as the accepted values of
 * `?dev=1&quality=`, and the Settings toggle steps DOWN through it (high -> medium -> low
 * -> high), because a player who opens the control is nearly always looking for something
 * cheaper than what they have.
 */
export const QUALITY_PRESET_IDS = ['low', 'medium', 'high'] as const;
export type QualityPreset = (typeof QUALITY_PRESET_IDS)[number];

/**
 * The shipped preset: what an absent `?dev=1&quality=` flag resolves to, and what a
 * player who never opens Settings gets.
 *
 * ONE constant for both, deliberately. `render/quality.ts`'s `qualityFor(null)` and
 * `DEFAULT_SETTINGS.presentation.quality` are the two places today's render is decided,
 * and issue #540's hard requirement is that adding the setting changes neither. Two
 * literals that happened to agree would leave that as a coincidence a later edit could
 * break silently on one side only; reading the same constant makes it structural.
 *
 * `high` is today's behaviour, byte-for-byte -- `QUALITY_PRESETS.high` is pinned against
 * scene.ts's own constructor literals in render/quality.test.ts.
 */
export const DEFAULT_QUALITY_PRESET: QualityPreset = 'high';
