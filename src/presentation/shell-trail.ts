/**
 * The shell bounce-trail VOCABULARY (issue #688): which experimental trail treatments exist,
 * and how a shell's remaining ricochets map onto one. Renderer-independent, and here rather
 * than in `render/` for the reason `identity-marker.ts` gives: `game/devflags.ts` validates
 * the flag's values, and a game module must not import Three.js to learn a semantic. The
 * geometry is `render/shell-trail.ts`.
 *
 * THE PROBLEM. How many more walls a shell will bounce off is gameplay-essential -- it decides
 * whether a shot coming at you off a wall is live -- and today only the ricochet SOUND says
 * anything about it. #632 names a trail whose length or segmentation encodes the remaining
 * bounces as the strongest candidate that does not spend another hue.
 *
 * AN EXPERIMENT, NOT A DEFAULT. `?dev=1&shellTrail=segments` draws it; without the flag
 * nothing is built and the shipped render is untouched. The issue closes on adopt / revise /
 * reject evidence for #632, not on a shipped visual grammar.
 *
 * `segments` -- a short row of dashes behind the shell, ONE PER REMAINING BOUNCE. Counting, in a
 * neutral tone, and three constraints shape it:
 *
 *  - NO HUE. The shell's emissive already carries its owner's identity colour in a versus or
 *    co-op match (`SHELL_TINT_INTENSITY`, render/entities.ts), and tread marks lean toward the
 *    same colour. A tinted trail would be a third claim on that channel, so every dash is one
 *    fixed off-white whoever fired it.
 *  - STATE, NOT HISTORY. The count is read from the shell's `bouncesLeft` on the frame it is
 *    drawn, and the dashes are laid out behind its CURRENT heading. Nothing depends on where
 *    the shell has been, so a posed gallery still shows exactly what a live frame does.
 *  - STATIC BY CONSTRUCTION. The dashes have no animation of their own -- no fade, flicker or
 *    growth -- so the reduced-motion form is the same form, and the cue survives that policy
 *    intact rather than being traded for a weaker one.
 *
 * A DIRECT COUNT (issue #774, the owner's direction on #632 of 2026-09-14). Two dashes, two
 * ricochets to come; one, one; none, none -- and no placeholder for zero. The first experiment
 * (#688) drew one MORE than the bounces left, so a last-flight shell kept a single dash; that
 * mapping is superseded. A shell with no bounces left is still drawn, and still dangerous: the
 * cue describes remaining ricochets, not whether a shell can hit a tank or what type it is. The
 * shipped starting budgets (`balance.json`'s `shells`: normal 1, fast 0, ricochet 2) therefore
 * start at 1, 0 and 2.
 *
 * THE COST OF A ZERO. Under +1 no live shell ever drew nothing, so "no dashes" could not be
 * misread. Now it is a real answer, which makes any dash that is hidden or clipped a potential
 * false zero; `render/shell-trail.ts` lays the row around a wall rather than dropping dashes
 * into it for that reason.
 */
export const SHELL_TRAIL_STYLES = ['segments'] as const;
export type ShellTrailStyle = (typeof SHELL_TRAIL_STYLES)[number];

/** Is this a trail style this module describes? The parse-side guard (`asShellTrail`). */
export function isShellTrailStyle(value: unknown): value is ShellTrailStyle {
  return typeof value === 'string' && (SHELL_TRAIL_STYLES as readonly string[]).includes(value);
}

/**
 * The most dashes one shell draws: the largest shipped starting budget, ricochet's 2 bounces. A
 * shell configured with more bounces clamps here rather than growing a longer row: the per-shell
 * budget is what bounds the renderer's instance count, and a row too long to count at a glance
 * would stop being a count.
 */
export const MAX_TRAIL_SEGMENTS = 2;

/** Dashes for a shell with `bouncesLeft` ricochets to come: exactly that, clamped to 0..MAX. */
export function trailSegmentsFor(bouncesLeft: number): number {
  return Math.min(MAX_TRAIL_SEGMENTS, Math.max(0, Math.floor(bouncesLeft)));
}
