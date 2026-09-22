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
 *   - horizontal overflow of the page, and of any container inside it (see `overflow` below).
 *
 * And, as in `clearance.mjs`, a reading that measured nothing is a failure rather than a pass:
 * a state that never reached its surface, a surface with no controls at all, or a collector
 * that did not report the sideways reading.
 *
 * Input, one per screen state and viewport:
 *   { state, viewport, failed?: string,
 *     controls: [{ key, text, x, y, w, h, pressableW, clip?, reachable, pinned }],
 *     overflow: { page: boolean, sideways: [{ key, clientW, scrollW, overflowX }] } }
 * where x/y/w/h are CSS px from getBoundingClientRect; `clip` is the part of that box its
 * clipping ancestors leave visible, { x, y, w, h }, zero-sized when it is scrolled out of view;
 * `pressableW` is that clipped width further cut to the viewport's own edges, which is what a
 * player can actually press (see the floor below); `reachable` says the control's bottom edge is
 * within its scroll container's scrollHeight (measured from the container's padding box), or
 * within the viewport when it has none; and `pinned` names the sticky or fixed ancestor the
 * control is drawn in, or is null.
 *
 * THE FLOOR READS `pressableW` ACROSS AND THE FULL BOX DOWN, and the asymmetry is the point
 * (issue #932). Vertical clipping is not a defect: a control below the fold is still 44 px once
 * a player scrolls to it, which is why `reachable` exists as a separate question. Horizontal
 * clipping at the screen edge cannot be scrolled away -- core menus are required to work without
 * two-axis scrolling, and `.hud-customize` carries `touch-action: pan-y`, so a touch player
 * cannot pan across even where the browser would allow it. MEASURED on the tree before #913:
 * two hull swatches sat at x=-2 and right=322 in a 320 px viewport and reported w=44, clearing
 * the floor, while only 42 px of each was on screen to press.
 *
 * `overflow.page` IS KEPT AND CANNOT FIRE TODAY, which is worth stating plainly rather than
 * leaving for the next reader to rediscover. It reads `documentElement.scrollWidth >
 * innerWidth`, and everything this app draws sits inside a `position: fixed` app root under
 * `html, body { overflow: hidden }`; Chromium excludes fixed-position boxes from the document's
 * scrollable overflow, so the expression is false however badly a menu overflows. Measured
 * across all 128 readings with the #913 defect restored: 0. It is kept because it is the correct
 * question to ask should the app root ever stop being fixed, and `overflow.sideways` is the
 * reading that answers it for the layout as it actually is.
 *
 * OVERLAP IS JUDGED ON THE VISIBLE PART (issue #766). A control scrolled out of view inside a
 * scroll container keeps a box where it is not drawn, and a press there reaches whatever IS
 * drawn. Measured: the Controllers pane with two pads at 1280x800@200% scrolls its source rows
 * inside their own container, and the unsupported pad's button, scrolled below the fold, had a
 * box on top of the pane's Back button, which sits outside that container. The floor and
 * reachability still read the whole box: a clipped control is still that size once scrolled to.
 *
 * The on-screen driving controls (`.hud-touch`) are not menu targets and are left out by the
 * collector; they are sized by `--hud-control-touch`, 56 px.
 */

export const HIT_FLOOR = 44;

/** Below this, two boxes that merely share an edge are not treated as overlapping. */
const OVERLAP_EPSILON = 0.5;

const label = (c) => `${c.key} "${c.text}"`;

/** The part of a control a press can land on: its clipped box when measured, else its box. */
const visibleBox = (c) => c.clip ?? c;

/**
 * Whether one reported box is a menu scrolling sideways, rather than one of the two shapes that
 * report wider content and are not defects.
 *
 * `overflowX: visible` IS NOT A SCROLL, and is why this cannot be a bare
 * `scrollWidth > clientWidth`. A visible-overflow box reports content painting outside its
 * padding box: measured on a clean tree, 168 readings across 12 element classes, nearly all of
 * them buttons whose label is wider than the box its text is centred in. None is a sideways
 * scroll and none is a defect. Restricted to boxes that clip or scroll, the same tree reports 0.
 *
 * ONE PIXEL WIDE IS EXEMPT, by shape rather than by class name. `.ui-sr-only` (hud.css:4403) is
 * `width: 1px; overflow: hidden` holding a whole sentence, so it reports 1px over 55 -- 68 of
 * them across the sweep, every one a false positive. Keying on the box covers any
 * visually-hidden idiom rather than the one class in use today, and measured, no box wider than
 * a pixel is excluded by it: nothing 1px wide is a menu a player scrolls.
 */
export function scrollsSideways(box) {
  if (box.clientW <= 1) return false;
  if (box.overflowX === 'visible') return false;
  return box.scrollW > box.clientW;
}

/** Every way one reading breaks the contract, as readable lines; empty means it holds. */
export function hitTargetFailures(run) {
  const where = `${run.state} ${run.viewport}`;
  if (run.failed) return [`${where}: never reached its surface (${run.failed})`];
  if (run.controls.length === 0) return [`${where}: no controls measured, so nothing was checked`];

  const failures = [];
  for (const c of run.controls) {
    // Across, what a player can press; down, the whole box. See the header: a control clipped
    // by the screen edge is permanently that much narrower, where one below the fold is not.
    //
    // REQUIRED, not defaulted to `c.w`. Falling back would leave the floor reading the box again
    // -- passing, quietly, exactly the readings this issue exists to catch -- and no gate would
    // show it. Same reasoning as the missing `sideways` reading below.
    if (typeof c.pressableW !== 'number') {
      failures.push(`${where}: ${label(c)} was measured without a pressable width`);
      continue;
    }
    const across = c.pressableW;
    if (across < HIT_FLOOR || c.h < HIT_FLOOR) {
      const size = across < c.w ? `${c.w}x${c.h} with only ${across}px of it on screen` : `${c.w}x${c.h}`;
      failures.push(`${where}: ${label(c)} is ${size}, under the ${HIT_FLOOR}px floor`);
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
      const va = visibleBox(a);
      const vb = visibleBox(b);
      const ox = Math.min(va.x + va.w, vb.x + vb.w) - Math.max(va.x, vb.x);
      const oy = Math.min(va.y + va.h, vb.y + vb.h) - Math.max(va.y, vb.y);
      if (ox > OVERLAP_EPSILON && oy > OVERLAP_EPSILON) {
        failures.push(`${where}: ${label(a)} overlaps ${label(b)}`);
      }
    }
  }
  if (run.overflow.page) failures.push(`${where}: the page scrolls horizontally`);
  // A MISSING READING IS A FAILURE, not a pass. `overflow.page` spent its whole life unable to
  // fire; a collector that silently stopped reporting `sideways` would look exactly as clean,
  // which is the same hole one level up.
  if (!Array.isArray(run.overflow.sideways)) {
    failures.push(`${where}: no sideways overflow reading, so nothing was checked`);
  } else {
    for (const box of run.overflow.sideways.filter(scrollsSideways)) {
      failures.push(`${where}: ${box.key} scrolls sideways, ${box.clientW}px wide over ${box.scrollW}px of content`);
    }
  }
  return failures;
}
