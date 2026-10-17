import { expect, it, vi } from 'vitest';

import { createHud, type Hud, type HudLayerId } from './hud';
import { focusableControls } from './focusable';

/**
 * The layer reachability sweep (issue #914), shared by the two files that run it:
 * `hud.reachability.test.ts` walks every layer but `developer-config`, and
 * `hud.reachability.devconfig.test.ts` walks that one alone.
 *
 * WHY TWO FILES. A mutation entry runs its scoped test files whole, and the harness kills a run
 * at 180s (`tools/mutate/run.mjs`, `SUBPROCESS_TIMEOUT_MS`). The developer-config walk is 163
 * pad steps, and since jsdom 30.1.2 empties its computed-style cache on every focus move, each
 * step re-runs the cascade: about 87s of the old file's 98s on a CI shard (#1080's run). 14
 * entries were scoped to that file and none was killed by that walk, yet every one paid for it
 * twice, once for the baseline and once for the mutant, and a pair reached 293s (#1090's run).
 *
 * ONE RECORD, so the type still does the work: `LAYER_REACH` is `Record<HudLayerId, ...>`, and a
 * layer added without saying how to reach it does not compile, whichever file walks it. And ONE
 * LIST of the layers walked apart, `WALKED_IN_OWN_FILE`, which `hud.reachability.test.ts` skips
 * and `hud.reachability.devconfig.test.ts` walks, so the two files cannot disagree about which
 * layers that is. What no check covers: deleting or skipping the devconfig file drops its walk,
 * as skipping the walk in one file always could.
 *
 * A test-only module: nothing in production imports it.
 */

/** The layers `hud.reachability.devconfig.test.ts` walks; `hud.reachability.test.ts` walks the rest. */
export const WALKED_IN_OWN_FILE: readonly HudLayerId[] = ['developer-config'];

let hud: Hud | null = null;

export function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  // Both flags on: `developer-tools`, `developer-config`, `controller-selftest` and
  // `developer-gallery` are layers whichever way the flags fall, and a pane that cannot be
  // opened here would be a hole in the sweep rather than a pane that does not exist.
  hud = createHud(root, { developerMode: true, galleryWorkbench: true });
  return { hud, root };
}

/** Each importing file registers this as its `afterEach`. */
export function unmount(): void {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
}

export const q = (root: HTMLElement, sel: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(sel);
  if (el === null) throw new Error(`no ${sel} in the mounted HUD`);
  return el;
};
const click = (root: HTMLElement, sel: string): void => {
  q(root, sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

interface LayerReach {
  /** The container `activePanelContainer` should hand the keyboard while this layer is open. */
  readonly selector: string;
  /**
   * The control the layer's arrival focuses, inside `selector` (issue #919), or `null` when the
   * layer declares no primary action and its container takes focus.
   */
  readonly primary: string | null;
  /** The path a player actually takes to it, by the same clicks and calls they would make. */
  readonly open: (h: Hud, root: HTMLElement) => void;
  /**
   * Set only for the controller self-test, whose pad suppression is a decided behaviour rather
   * than a gap. Its own assertions replace the walk.
   */
  readonly padSuppressed?: true;
}

export const LAYER_REACH: Record<HudLayerId, LayerReach> = {
  stats: { selector: '.hud-stats', primary: null, open: (_h, root) => click(root, '.hud-records-open') },
  achievements: {
    selector: '.hud-achievements',
    primary: null,
    // The two Records tabs are separate layer ids (hud.ts:32), so the tab press is the open.
    open: (_h, root) => {
      click(root, '.hud-records-open');
      click(root, '.hud-records-tab-achievements');
    },
  },
  customize: {
    selector: '.hud-customize',
    primary: null,
    open: (_h, root) => click(root, '.hud-customize-open'),
  },
  levelselect: {
    selector: '.hud-levelselect',
    primary: '.hud-level-btn[aria-label="Level 1"]',
    // 3 of 5 unlocked, so the pane holds both a reachable level and a locked one the walk must
    // skip rather than land on -- `focusableControls` drops a disabled button.
    open: (h, root) => {
      h.setLevelSelect(3, 5);
      click(root, '.hud-levelselect-open');
    },
  },
  controllers: {
    selector: '.hud-controllers',
    primary: null,
    open: (_h, root) => click(root, '.hud-controllers-open'),
  },
  'versus-setup': {
    selector: '.hud-versus-setup',
    primary: '.hud-versus-start',
    // The Versus button is a bare click passthrough: `loop.ts` decides, so the test wires the
    // same one-liner rather than reaching past the button.
    open: (h, root) => {
      h.onVersusOpen(() => h.showVersusSetup(true));
      click(root, '.hud-versus-open');
    },
  },
  settings: {
    selector: '.hud-settings',
    primary: null,
    open: (_h, root) => click(root, '.hud-settings-open'),
  },
  about: { selector: '.hud-about', primary: null, open: (_h, root) => click(root, '.hud-about-open') },
  'controller-layout': {
    selector: '.hud-layout',
    primary: null,
    open: (_h, root) => {
      click(root, '.hud-settings-open');
      click(root, '.hud-settings-layout');
    },
  },
  'developer-tools': {
    selector: '.hud-devtools',
    primary: null,
    open: (_h, root) => click(root, '.hud-devtools-open'),
  },
  'developer-config': {
    selector: '.hud-devcfg',
    primary: null,
    open: (_h, root) => {
      click(root, '.hud-devtools-open');
      click(root, '.hud-devcfg-open');
    },
  },
  'developer-gallery': {
    selector: '.hud-gallery',
    primary: null,
    open: (_h, root) => {
      click(root, '.hud-devtools-open');
      click(root, '.hud-gallery-open');
    },
  },
  'controller-selftest': {
    selector: '.hud-selftest',
    primary: null,
    open: (_h, root) => {
      click(root, '.hud-devtools-open');
      click(root, '.hud-selftest-open');
    },
    padSuppressed: true,
  },
  'confirm-new-campaign': {
    selector: '.hud-confirm',
    // The SAFE answer: a question that can delete a run arrives on Keep playing.
    primary: '.hud-confirm-cancel',
    // Only a run that would be LOST is worth asking about, so the dialog needs a run to lose.
    open: (h, root) => {
      h.setContinueAvailable(true);
      click(root, '.hud-new-game');
    },
  },
  'match-failed': {
    selector: '.hud-alert',
    primary: '.hud-alert-retry',
    // With a retry, because Retry is the control the overlay exists for and the one a pad
    // could not reach before #912. Without it the overlay has a single button and the walk
    // would not prove a pad can choose between them.
    open: (h) => h.showMatchFailure({ title: 'Match failed', detail: 'A transient failure.', action: 'Back to menu' }, () => {}),
  },
};

/**
 * Assert where `container`'s arrival put focus -- `primary`, a selector inside it, or the
 * container itself when `primary` is null (issue #919) -- then walk every control with the
 * PAD verb, which is the path a D-pad takes, from there round to there.
 */
export function walkWithPad(h: Hud, container: HTMLElement, primary: string | null, label: string): HTMLElement[] {
  const arrival = primary === null ? container : q(container, primary);
  expect(
    document.activeElement,
    primary === null
      ? `${label} declares no primary action, so its container should have taken focus`
      : `${label}'s arrival did not land on its primary action ${primary}`,
  ).toBe(arrival);
  const controls = focusableControls(container);
  expect(controls.length, `${label} exposed no reachable controls`).toBeGreaterThan(0);
  const start = controls.indexOf(arrival); // -1 for the container: the first Down enters at [0]
  expect(primary === null || start >= 0, `${label}'s primary is not a control the walk reaches`).toBe(true);
  for (let i = 0; i < controls.length; i++) {
    expect(h.act('down'), `${label}: the pad's Down was refused at step ${i}`).toBe(true);
    expect(document.activeElement, `${label}: step ${i} landed on the wrong control`).toBe(
      controls[(start + 1 + i) % controls.length],
    );
  }
  // One more proves the order is a closed CYCLE rather than a line that runs out.
  h.act('down');
  expect(document.activeElement, `${label}: the control order is not a cycle`).toBe(
    controls[(start + 1) % controls.length],
  );
  return controls;
}

/** Register the walk of one layer as a test, in whichever describe block calls it. */
export function layerReachCase(id: HudLayerId, budgetMs: number): void {
  const reach = LAYER_REACH[id];

  it(`gives the pad the keyboard inside ${id}`, () => {
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      vi.advanceTimersByTime(1000);
      // What each arrival had focused when it was announced (issue #919): the gamepad route
      // drops a Confirm first seen on the poll after an announced arrival, so an arrival that
      // focuses without announcing itself leaves that pane open to a carried press.
      const announced: (Element | null)[] = [];
      h.onArrival(() => announced.push(document.activeElement));
      reach.open(h, root);
      vi.advanceTimersByTime(1000); // let the crossfade finish; a LEAVING surface is not active

      const container = q(root, reach.selector);
      expect(getComputedStyle(container).display, `${id} did not open`).not.toBe('none');
      expect(announced.at(-1), `${id}'s own arrival was not the last one announced`).toBe(
        reach.primary === null ? container : q(container, reach.primary),
      );

      if (reach.padSuppressed === true) {
        // THE ONE DECIDED EXCEPTION (issue #599). The self-test's whole subject is which
        // physical control is which index, so a Confirm pressed in it has to show up in the
        // readout rather than activate whatever is focused, and a stick push has to move an
        // axis bar rather than the focus ring. Every action is consumed and dropped -- which
        // is why it is asserted here as a SUPPRESSION rather than skipped as a gap.
        expect(document.activeElement, `${id} did not take focus as a container`).toBe(container);
        expect(h.act('down'), `${id} let the pad's Down through to the focus ring`).toBe(true);
        expect(document.activeElement, `${id} moved focus on a pad Down`).toBe(container);
        expect(h.act('confirm'), `${id} let the pad's Confirm through`).toBe(true);
        // `back` stays live, so a tester holding nothing but a controller is never trapped.
        expect(h.act('back'), `${id} trapped a pad with no way out`).toBe(true);
        return;
      }

      const controls = walkWithPad(h, container, reach.primary, id);
      // And Confirm ACTS, which is the half the gallery and the alert both failed: with the
      // pane open, `act('confirm')` returned false and landed nowhere.
      expect(h.act('confirm'), `${id}: the pad's Confirm did nothing`).toBe(true);
      expect(controls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  }, budgetMs);
}
