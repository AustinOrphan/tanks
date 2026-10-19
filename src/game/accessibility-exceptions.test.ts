// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { accessibilityException, type A11ySubject } from './accessibility-exceptions';
import type { HudLayerId, HudSurface } from './hud';
import { LAYER_REACH, mount, q, SURFACE_REACH, unmount } from './hud-reachability-fixtures';

/**
 * Issue #915: the accessibility exception register, asserted so an exception that stops being
 * true fails rather than rotting -- the shape `hit-sweep.test.ts` gives `hitSweepExclusion`.
 *
 * THE POPULATION the register is asked about: the 15 layers (`LAYER_REACH`), the 6 surfaces
 * (`SURFACE_REACH`), every tabbable control outside every pane in the mounted HUD (4, measured by
 * `outsidePanes` below: the DEV badge and the touch row's three driving controls), and the 1
 * transient state, the crossfade's leaving surface. 26 subjects; 5 are exceptions and 21 are not.
 *
 * WHAT EACH EXCEPTION'S TRUTH RESTS ON. Each entry is held to the HUD as well as to its reason,
 * so the register cannot keep an entry the HUD has stopped needing:
 *
 *  - the self-test's suppression: `layerReachCase` in `hud-reachability-fixtures.ts` asserts it
 *    for the layer `LAYER_REACH` marks `padSuppressed` (mutation
 *    `hud-selftest-stops-eating-pad-actions`), and the agreement case below holds that mark to
 *    the register;
 *  - launch and playing: the `leaves ... on purpose` cases in `hud.reachability.test.ts` assert
 *    the pad is refused for the surfaces `SURFACE_REACH` marks `noPanel`
 *    (`a11y-act-claims-a-pad-with-no-panel`), and the same agreement case holds those marks;
 *  - the DEV badge and the crossfade: the two cases at the foot of this file.
 */

afterEach(unmount);

/**
 * Every excepted subject, by the reason the register gives it. Literal, so a reason reworded in
 * the register is a reviewed change here too, and the launch and playing reasons are also the
 * tails of two `hud.reachability.test.ts` titles that mutation entries name.
 */
const EXPECTED: Record<string, string[]> = {
  'the controller self-test: a pad press has to reach its readout, so every pad action but Back and Pause is consumed': [
    'layer controller-selftest',
  ],
  'the splash: the panel, topbar and touch row are all hidden behind it': ['surface launch'],
  'a live match: the arrows and the stick drive the tank, not a menu': ['surface playing'],
  'the DEV badge floats over every surface and belongs to no panel; a pad opens Developer Tools from the Main Menu or Pause': [
    'control .hud-devbadge',
  ],
  "a crossfade's leaving surface stays tabbable until its fade settles; the arrows and the pad already walk the arriving one": [
    'transient crossfade-leaving-surface',
  ],
};

/**
 * The element shapes a browser puts in the Tab order on its own, plus anything with a `tabindex`;
 * a negative one takes an element out. Editable regions, media controls and frames are not
 * listed because nothing under `src/game` builds one.
 */
const TABBABLE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]';

/** The containers a pad walks: the menu panel, whose four states share it, then every layer's. */
const PANES = ['.hud-panel', ...Object.values(LAYER_REACH).map((reach) => reach.selector)];

/** A control's probe: the first `hud-` class it carries, which is the one that names it. */
const probeOf = (el: Element): string => `.${Array.from(el.classList).find((c) => c.startsWith('hud-'))}`;

/**
 * Every tabbable element in the mounted HUD that no pane contains, split by the one exclusion:
 * `.hud-touch`, the on-screen driving controls. They are not menu targets -- the rule
 * `hit-sweep.mjs`'s collector applies to them for the same reason -- and they show only in a
 * live match, which is the `playing` entry, so they are not an exception of their own. The rest
 * are `controls`. The register is asked about both halves.
 *
 * Read from the markup rather than from what this mount happens to show, so a control a session
 * hides (the badge is hidden outside developer mode) is still counted where it lives.
 */
function outsidePanes(root: HTMLElement): { controls: string[]; driving: string[] } {
  const outside = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => Number(el.getAttribute('tabindex') ?? 0) >= 0 && !PANES.some((sel) => el.closest(sel) !== null),
  );
  return {
    controls: outside.filter((el) => el.closest('.hud-touch') === null).map(probeOf),
    driving: outside.filter((el) => el.closest('.hud-touch') !== null).map(probeOf),
  };
}

/** The register's whole population, each subject labelled the way `EXPECTED` names it. */
function subjects(root: HTMLElement): (readonly [string, A11ySubject])[] {
  return [
    ...(Object.keys(LAYER_REACH) as HudLayerId[]).map(
      (id) => [`layer ${id}`, { kind: 'layer', id }] as const,
    ),
    ...(Object.keys(SURFACE_REACH) as HudSurface[]).map(
      (id) => [`surface ${id}`, { kind: 'surface', id }] as const,
    ),
    // Both halves of `outsidePanes`: the driving controls are asked too, and must come back
    // null, so a clause written for one of them changes the fold below.
    ...[...outsidePanes(root).controls, ...outsidePanes(root).driving].map(
      (selector) => [`control ${selector}`, { kind: 'control', selector }] as const,
    ),
    ['transient crossfade-leaving-surface', { kind: 'transient', id: 'crossfade-leaving-surface' }] as const,
  ];
}

describe('the accessibility exception register (issue #915)', () => {
  it('registers exactly five exceptions, each for its reason', () => {
    // Negative controls, one per clause: deleting any of the five in `accessibilityException`
    // drops that subject from the fold and this map no longer matches
    // (`a11y-register-drops-*`, one entry each). What the fold cannot see is a subject outside
    // the population that the register answers; the slider is the one such subject pinned, by
    // its own case below, because it is the one the issue proposed.
    const { root } = mount();
    const actual: Record<string, string[]> = {};
    for (const [label, subject] of subjects(root)) {
      const reason = accessibilityException(subject);
      if (reason !== null) (actual[reason] ??= []).push(label);
    }
    expect(actual).toEqual(EXPECTED);
  });

  it('excepts exactly the layers and surfaces the reachability records mark decided, both ways', () => {
    // The records (`hud-reachability-fixtures.ts`) mark WHICH members a pad is decided not to
    // walk; the register says WHY. Both directions, so neither can hold a member the other does
    // not: a clause dropped from the register fails the first comparison of its kind
    // (`a11y-register-drops-selftest-pad-suppression`, `-launch-no-panel`, `-playing-no-panel`),
    // and a mark dropped from the records fails it from the other side
    // (`a11y-records-stop-marking-the-selftest`).
    const layers = Object.keys(LAYER_REACH) as HudLayerId[];
    expect(
      layers.filter((id) => accessibilityException({ kind: 'layer', id }) !== null),
      'the register and LAYER_REACH disagree about which layer suppresses the pad',
    ).toEqual(layers.filter((id) => LAYER_REACH[id].padSuppressed === true));

    const surfaces = Object.keys(SURFACE_REACH) as HudSurface[];
    expect(
      surfaces.filter((id) => accessibilityException({ kind: 'surface', id }) !== null),
      'the register and SURFACE_REACH disagree about which surfaces have no panel',
    ).toEqual(surfaces.filter((id) => 'noPanel' in SURFACE_REACH[id]));
  });

  it('does not register the volume slider: the owner ruled its missing pad arrival a defect (2026-10-13)', () => {
    // The ruling on issue #915: the slider's missing spatial arrival is a criterion-2 defect,
    // fixed by issue #918's − and + steppers, so it is not an exception. Its behaviour -- the
    // steppers in the walk, the slider outside it -- is `hud.controls.test.ts`'s to assert.
    // Negative control: `a11y-register-adds-the-volume-slider`, which registers it.
    const { root } = mount();
    expect(root.querySelectorAll('.hud-settings-volume'), 'the probe names no single control').toHaveLength(1);
    expect(accessibilityException({ kind: 'control', selector: '.hud-settings-volume' })).toBeNull();
  });

  it('holds the DEV badge as the one control outside every pane', () => {
    // The badge's entry is true while no pane contains it. Moving it into one empties `controls`
    // (`a11y-dev-badge-moves-into-a-pane`, which puts it in the gallery workbench). The literal
    // list is also the other direction: a control added outside every pane with no register
    // entry joins `controls` and fails here.
    const { root } = mount();
    const { controls, driving } = outsidePanes(root);
    expect(controls, 'exception no longer true, or a new one: the DEV badge clause in accessibility-exceptions.ts').toEqual([
      '.hud-devbadge',
    ]);
    // The exclusion, stated by population, so a menu control dropped into the touch row is not
    // excused by it silently.
    expect(driving, 'the touch row holds something other than the three driving controls').toEqual([
      '.hud-pause-btn',
      '.hud-fire-btn',
      '.hud-mine-btn',
    ]);
    expect(root.querySelectorAll('.hud-devbadge'), 'the probe names no single control').toHaveLength(1);
  });

  it("leaves a crossfade's outgoing surface tabbable until the fade settles, while the pad walks the arriving one", () => {
    // Opened FROM the menu, so the leaving surface is `.hud-panel`: it is first in the order
    // `activePanelContainer` reads, so it is the case where a leaving surface could take the
    // pad if that function stopped skipping it.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      const panel = q(root, '.hud-panel');
      const records = q(root, '.hud-records-open');
      records.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      // No timer has run since the press, so the fade is in progress. Each of these failing
      // means the exception is no longer true: delete the crossfade clause. Negative controls:
      // `a11y-leaving-surface-goes-inert` fails the inert line and
      // `a11y-leaving-surface-hides-from-view` the visibility line, and no other HUD test reads
      // a leaving surface's visibility. The display line fails when the leaving surface is
      // hidden as its fade begins (`classList.add(LEAVING, surface.hidden)` in `transitionTo`),
      // measured with a scratch mutant rather than an entry, since ten existing transition
      // cases already fail on that one.
      const gone = "exception no longer true: delete the crossfade clause from accessibility-exceptions.ts";
      expect(panel.classList.contains('ui-surface--leaving'), `no crossfade any more; ${gone}`).toBe(true);
      expect(panel.closest('[inert]'), gone).toBeNull();
      expect(getComputedStyle(panel).display, gone).not.toBe('none');
      expect(getComputedStyle(panel).visibility, gone).not.toBe('hidden');

      // The half that IS held: the pad walks the arriving Records pane, never the menu.
      // Negative control: `leaving-surface-keeps-the-keyboard`, which stops
      // `activePanelContainer` skipping a leaving surface.
      expect(h.act('down')).toBe(true);
      expect(q(root, '.hud-stats').contains(document.activeElement), 'the pad walked the surface the player left').toBe(
        true,
      );

      // And it is transient: once the fade settles the menu is out of the layout, and so out
      // of the Tab order. Negative control, measured with a scratch mutant: a settle that only
      // drops `--leaving` and never adds `--hidden` (84 existing HUD cases fail on it too).
      vi.advanceTimersByTime(1000);
      expect(getComputedStyle(panel).display, 'the leaving surface outlived its fade').toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });
});
