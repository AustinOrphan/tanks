/**
 * The menu hit-target verdict (issue #686), kept apart from the browser that measures it so
 * the verdict itself has unit tests and mutation entries.
 *
 * THE FLOOR IS 44 CSS PX IN BOTH DIMENSIONS, the absolute touch minimum in the UI/UX direction
 * (docs/superpowers/specs/2026-08-23-ui-ux-direction.md, "Control height"), which also says a
 * pointer does not reduce controller or touch target size -- so there is no desktop exemption.
 *
 * Measured in Chromium before the floor existed, across 24 player-facing surfaces (the 22
 * screen states in `tools/screens/states.mjs` a player can reach, plus the Controllers pane and
 * Settings with a reset armed) at four viewports: 764 of 1016 control readings, in 44 of 54
 * control classes, were under it. `--sm` buttons rendered 27 px tall and `--slab` 31-33 px,
 * at every viewport alike, because nothing about their size depended on the viewport.
 *
 * A bigger target is only a fix if it does not create a new failure, so the same verdict also
 * fails:
 *   - two controls whose boxes overlap, where a press has no single owner;
 *   - a control a player cannot scroll to (see `reachable` below);
 *   - horizontal overflow of the page.
 *
 * And, as in `clearance.mjs`, a reading that measured nothing is a failure rather than a pass:
 * a state that never reached its surface, or a surface with no controls at all.
 *
 * Input, one per screen state and viewport:
 *   { state, viewport, failed?: string,
 *     controls: [{ key, text, x, y, w, h, reachable, pinned }],
 *     overflow: { page: boolean } }
 * where x/y/w/h are CSS px from getBoundingClientRect; `reachable` says the control's
 * bottom edge is within its scroll container's scrollHeight (measured from the container's
 * padding box), or within the viewport when it has none; and `pinned` names the sticky or
 * fixed ancestor the control is drawn in, or is null.
 *
 * The on-screen driving controls (`.hud-touch`) are not menu targets and are left out by the
 * collector; they are sized by `--hud-control-touch`, 56 px.
 */

export const HIT_FLOOR = 44;

/** Below this, two boxes that merely share an edge are not treated as overlapping. */
const OVERLAP_EPSILON = 0.5;

const label = (c) => `${c.key} "${c.text}"`;

/** Every way one reading breaks the contract, as readable lines; empty means it holds. */
export function hitTargetFailures(run) {
  const where = `${run.state} ${run.viewport}`;
  if (run.failed) return [`${where}: never reached its surface (${run.failed})`];
  if (run.controls.length === 0) return [`${where}: no controls measured, so nothing was checked`];

  const failures = [];
  for (const c of run.controls) {
    if (c.w < HIT_FLOOR || c.h < HIT_FLOOR) {
      failures.push(`${where}: ${label(c)} is ${c.w}x${c.h}, under the ${HIT_FLOOR}px floor`);
    }
    if (!c.reachable) failures.push(`${where}: ${label(c)} cannot be scrolled to`);
  }
  for (let i = 0; i < run.controls.length; i++) {
    for (let j = i + 1; j < run.controls.length; j++) {
      const a = run.controls[i];
      const b = run.controls[j];
      // A control in a sticky or fixed bar is DRAWN over the content scrolling beneath it --
      // Versus Setup's Start and Back (issue #668) sit over the map cards by design -- and the
      // bar owns every press where it paints. Only two controls on the same layer compete.
      if (Boolean(a.pinned) !== Boolean(b.pinned)) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > OVERLAP_EPSILON && oy > OVERLAP_EPSILON) {
        failures.push(`${where}: ${label(a)} overlaps ${label(b)}`);
      }
    }
  }
  if (run.overflow.page) failures.push(`${where}: the page scrolls horizontally`);
  return failures;
}
