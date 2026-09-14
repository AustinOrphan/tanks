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
 * `segments` -- a short row of dashes behind the shell, ONE MORE than its remaining bounces.
 * Counting, in a neutral tone, and three constraints shape it:
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
 * WHY +1. A shell with no bounces left is the one the issue calls out -- it dies at the next
 * wall -- and it must still carry a mark distinct from "no trail drawn". One dash means "this
 * is its last flight"; two, one bounce to come; three, two. The shipped starting budgets
 * (`balance.json`'s `shells`: normal 1, fast 0, ricochet 2) therefore start at 2, 1 and 3.
 */
export const SHELL_TRAIL_STYLES = ['segments'] as const;
export type ShellTrailStyle = (typeof SHELL_TRAIL_STYLES)[number];

/** Is this a trail style this module describes? The parse-side guard (`asShellTrail`). */
export function isShellTrailStyle(value: unknown): value is ShellTrailStyle {
  return typeof value === 'string' && (SHELL_TRAIL_STYLES as readonly string[]).includes(value);
}

/**
 * The most dashes one shell draws. Three is the largest shipped starting budget (ricochet's 2
 * bounces) plus one. A shell configured with more bounces clamps here rather than growing a
 * longer row: the per-shell budget is what bounds the renderer's instance count, and a row too
 * long to count at a glance would stop being a count.
 */
export const MAX_TRAIL_SEGMENTS = 3;

/** Dashes for a shell with `bouncesLeft` ricochets to come: one more than that, clamped to 1..MAX. */
export function trailSegmentsFor(bouncesLeft: number): number {
  const n = Math.floor(bouncesLeft) + 1;
  return Math.min(MAX_TRAIL_SEGMENTS, Math.max(1, n));
}
