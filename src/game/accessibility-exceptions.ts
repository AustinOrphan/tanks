import type { HudLayerId, HudSurface } from './hud';

/**
 * The accessibility exception register (issue #915): every place the HUD is decided NOT to give
 * a keyboard or a pad what the reachability sweep gives everything else, each with its reason.
 *
 * Issue #327's first criterion asks for automated semantic and keyboard checks "with documented
 * manual exceptions", and until this module that third clause had no artifact. The decided
 * exceptions existed, as code comments and as a reason string in a test file, where nothing
 * failed when one stopped being true. Here each is a clause, and
 * `accessibility-exceptions.test.ts` asserts the register two ways: the reasons it returns,
 * folded over every subject, must equal a literal map, and each exception must still be TRUE of
 * the mounted HUD. An exception that stops being true fails, and the fix is to delete its clause,
 * not to reword it.
 *
 * THE SHAPE IS `hitSweepExclusion`'s (`tools/visual/hit-sweep.mjs`): a reason or null, as a
 * chain of independent clauses, so deleting one changes exactly one subject's answer.
 *
 * FIVE ENTRIES, by the owner's ruling on issue #915 (2026-10-13): the four known exceptions --
 * the self-test's pad suppression, launch and playing with no active panel (two surfaces, so two
 * clauses), and the DEV badge -- plus the crossfade's leaving surface. The volume slider is NOT
 * here. The issue listed it as a fourth known exception, Tab-reachable but outside the spatial
 * walk; the ruling made its missing pad arrival a defect, fixed by issue #918's − and + steppers,
 * which are buttons in the walk. A negative control pins its absence.
 *
 * A test-only module: nothing in production imports it, as with `hud-reachability-fixtures.ts`.
 * It lives in `src/game` rather than `tools/` because its subjects are `hud.ts`'s own types, so a
 * layer or surface renamed there is a compile error here.
 */

/** What the register can be asked about. */
export type A11ySubject =
  | { readonly kind: 'layer'; readonly id: HudLayerId }
  | { readonly kind: 'surface'; readonly id: HudSurface }
  /** A control, by the one `hud-` class that names it in the mounted HUD. */
  | { readonly kind: 'control'; readonly selector: string }
  /** A state that exists only while something is moving, and so has no element to name. */
  | { readonly kind: 'transient'; readonly id: 'crossfade-leaving-surface' };

/** Why `subject` is an accepted exception, or null when it is held to the full sweep. */
export function accessibilityException(subject: A11ySubject): string | null {
  // Issue #599. The self-test's whole subject is which physical control is which index, so a
  // Confirm pressed in it has to show up in the readout rather than activate whatever is
  // focused, and a stick push has to move an axis bar rather than the focus ring. `act` consumes
  // and drops every pad action while it is open, except Back, so a tester holding nothing but a
  // controller is never trapped. The keyboard is untouched.
  if (subject.kind === 'layer' && subject.id === 'controller-selftest') {
    return 'the controller self-test: a pad press has to reach its readout, so every pad action but Back is consumed';
  }
  // Nothing on the splash is a menu: any key or press dismisses it, and `act` refuses a pad
  // direction there so the press falls through to the page.
  if (subject.kind === 'surface' && subject.id === 'launch') {
    return 'the splash: the panel, topbar and touch row are all hidden behind it';
  }
  // The arrows and the stick are the tank's while a match runs, which `input.ts` must keep. Pause
  // is the mid-session surface a pad navigates, and it has a panel.
  if (subject.kind === 'surface' && subject.id === 'playing') {
    return 'a live match: the arrows and the stick drive the tank, not a menu';
  }
  // Issue #243. The badge is on the HUD root rather than in the topbar, so it shows over every
  // surface, which puts it inside no panel's walk. It is a button, so pointer and Tab reach it;
  // a pad reaches the same shell through the Developer Tools entry, which is in the Main Menu
  // and Pause walks for that reason.
  if (subject.kind === 'control' && subject.selector === '.hud-devbadge') {
    return 'the DEV badge floats over every surface and belongs to no panel; a pad opens Developer Tools from the Main Menu or Pause';
  }
  // Issue #364's crossfade paints two surfaces at once. The outgoing one keeps its `--hidden`
  // class off until the fade settles, so it can be seen fading, and `.ui-surface--leaving` takes
  // it out of hit testing only: it is not inert, so Tab can still land on it. The arrows and the
  // pad already walk the arriving one (`activePanelContainer` skips a leaving surface). Ruled an
  // exception rather than a defect because it lasts one fade.
  if (subject.kind === 'transient' && subject.id === 'crossfade-leaving-surface') {
    return "a crossfade's leaving surface stays tabbable until its fade settles; the arrows and the pad already walk the arriving one";
  }
  return null;
}
