// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHud, type GameplayOutcome, type Hud, type HudLayerId, type HudSurface } from './hud';
import { focusableControls } from './focusable';
import { ZERO_STATS } from './stats';

/**
 * Every pane and every surface, reachable by arrows and by a D-pad (issue #914).
 *
 * WHY THIS IS DRIVEN FROM THE TYPES. Issue #327's first criterion says ALL menus and dialogs,
 * and until this file that was a maintained list: six panes were covered by the 87-control walk
 * in `hud.navigation.test.ts`, two had walks of their own, four worked and were pinned nowhere,
 * and one was broken. A pane joined the checked set only if someone remembered to add it, and
 * twice nobody did -- the gallery workbench (#730, missed by #741) and the match-failure overlay
 * (#325, fixed in #912). Both shipped with the same symptom: arrows moved nothing inside the
 * pane and Confirm landed nowhere, while every required check stayed green.
 *
 * The two records below are `Record<HudLayerId, ...>` and `Record<HudSurface, ...>`, so adding a
 * member to either union without saying how to reach it does not compile. That is the whole
 * mechanism: the omission becomes a build error at the moment it is introduced, rather than a
 * silence nobody is looking for. `activePanelContainer` in `hud.ts` reads the same `LAYERS`
 * record for the same reason.
 */

let hud: Hud | null = null;

function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  // Both flags on: `developer-tools`, `developer-config`, `controller-selftest` and
  // `developer-gallery` are layers whichever way the flags fall, and a pane that cannot be
  // opened here would be a hole in the sweep rather than a pane that does not exist.
  hud = createHud(root, { developerMode: true, galleryWorkbench: true });
  return { hud, root };
}

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

const q = (root: HTMLElement, sel: string): HTMLElement => {
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
  /** The path a player actually takes to it, by the same clicks and calls they would make. */
  readonly open: (h: Hud, root: HTMLElement) => void;
  /**
   * Set only for the controller self-test, whose pad suppression is a decided behaviour rather
   * than a gap. Its own assertions replace the walk.
   */
  readonly padSuppressed?: true;
}

const LAYER_REACH: Record<HudLayerId, LayerReach> = {
  stats: { selector: '.hud-stats', open: (_h, root) => click(root, '.hud-records-open') },
  achievements: {
    selector: '.hud-achievements',
    // The two Records tabs are separate layer ids (hud.ts:32), so the tab press is the open.
    open: (_h, root) => {
      click(root, '.hud-records-open');
      click(root, '.hud-records-tab-achievements');
    },
  },
  customize: { selector: '.hud-customize', open: (_h, root) => click(root, '.hud-customize-open') },
  levelselect: {
    selector: '.hud-levelselect',
    // 3 of 5 unlocked, so the pane holds both a reachable level and a locked one the walk must
    // skip rather than land on -- `focusableControls` drops a disabled button.
    open: (h, root) => {
      h.setLevelSelect(3, 5);
      click(root, '.hud-levelselect-open');
    },
  },
  controllers: { selector: '.hud-controllers', open: (_h, root) => click(root, '.hud-controllers-open') },
  'versus-setup': {
    selector: '.hud-versus-setup',
    // The Versus button is a bare click passthrough: `loop.ts` decides, so the test wires the
    // same one-liner rather than reaching past the button.
    open: (h, root) => {
      h.onVersusOpen(() => h.showVersusSetup(true));
      click(root, '.hud-versus-open');
    },
  },
  settings: { selector: '.hud-settings', open: (_h, root) => click(root, '.hud-settings-open') },
  about: { selector: '.hud-about', open: (_h, root) => click(root, '.hud-about-open') },
  'controller-layout': {
    selector: '.hud-layout',
    open: (_h, root) => {
      click(root, '.hud-settings-open');
      click(root, '.hud-settings-layout');
    },
  },
  'developer-tools': { selector: '.hud-devtools', open: (_h, root) => click(root, '.hud-devtools-open') },
  'developer-config': {
    selector: '.hud-devcfg',
    open: (_h, root) => {
      click(root, '.hud-devtools-open');
      click(root, '.hud-devcfg-open');
    },
  },
  'developer-gallery': {
    selector: '.hud-gallery',
    open: (_h, root) => {
      click(root, '.hud-devtools-open');
      click(root, '.hud-gallery-open');
    },
  },
  'controller-selftest': {
    selector: '.hud-selftest',
    open: (_h, root) => {
      click(root, '.hud-devtools-open');
      click(root, '.hud-selftest-open');
    },
    padSuppressed: true,
  },
  'confirm-new-campaign': {
    selector: '.hud-confirm',
    // Only a run that would be LOST is worth asking about, so the dialog needs a run to lose.
    open: (h, root) => {
      h.setContinueAvailable(true);
      click(root, '.hud-new-game');
    },
  },
  'match-failed': {
    selector: '.hud-alert',
    // With a retry, because Retry is the control the overlay exists for and the one a pad
    // could not reach before #912. Without it the overlay has a single button and the walk
    // would not prove a pad can choose between them.
    open: (h) => h.showMatchFailure({ title: 'Match failed', detail: 'A transient failure.', action: 'Back to menu' }, () => {}),
  },
};

/** A surface with no active panel is a decided design, not an omission; it says which and why. */
type SurfaceReach = { readonly selector: string } | { readonly noPanel: string };

const SURFACE_REACH: Record<HudSurface, SurfaceReach> = {
  launch: { noPanel: 'the splash: the panel, topbar and touch row are all hidden behind it' },
  playing: { noPanel: 'a live match: the arrows and the stick drive the tank, not a menu' },
  'main-menu': { selector: '.hud-panel' },
  paused: { selector: '.hud-panel' },
  'outcome-win': { selector: '.hud-panel' },
  'outcome-lose': { selector: '.hud-panel' },
};

/** A campaign-shaped ending, in the shape `pushOutcome` really hands the HUD. */
const outcome = (kind: 'mission-clear' | 'campaign-over'): GameplayOutcome => ({
  tally: 'solo',
  attempt: ZERO_STATS,
  action: 'campaign-levels',
  typedOutcome: { kind },
});

/** Walk `container`'s controls with the PAD verb, which is the path a D-pad takes. */
function walkWithPad(h: Hud, container: HTMLElement, label: string): HTMLElement[] {
  expect(document.activeElement, `${label} did not take focus as a container when it opened`).toBe(container);
  const controls = focusableControls(container);
  expect(controls.length, `${label} exposed no reachable controls`).toBeGreaterThan(0);
  for (let i = 0; i < controls.length; i++) {
    expect(h.act('down'), `${label}: the pad's Down was refused at step ${i}`).toBe(true);
    expect(document.activeElement, `${label}: step ${i} landed on the wrong control`).toBe(controls[i]);
  }
  // One more proves the order is a closed CYCLE rather than a line that runs out.
  h.act('down');
  expect(document.activeElement, `${label}: the control order is not a cycle`).toBe(controls[0]);
  return controls;
}

describe('every HUD layer is reachable by arrows and by a D-pad (issue #914)', () => {
  const ids = Object.keys(LAYER_REACH) as HudLayerId[];

  it('covers every layer id, with no entry for a layer that does not exist', () => {
    // The record is exhaustive by its type; this is the other direction -- an entry left behind
    // for a layer that was removed would sweep a pane nobody can open and read as coverage.
    expect(ids.length, 'a layer was added or removed; the record above is the place to say so').toBe(15);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const id of ids) {
    const reach = LAYER_REACH[id];

    it(`gives the pad the keyboard inside ${id}`, () => {
      vi.useFakeTimers();
      try {
        const { hud: h, root } = mount();
        h.setState('main-menu');
        vi.advanceTimersByTime(1000);
        reach.open(h, root);
        vi.advanceTimersByTime(1000); // let the crossfade finish; a LEAVING surface is not active

        const container = q(root, reach.selector);
        expect(getComputedStyle(container).display, `${id} did not open`).not.toBe('none');

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

        const controls = walkWithPad(h, container, id);
        // And Confirm ACTS, which is the half the gallery and the alert both failed: with the
        // pane open, `act('confirm')` returned false and landed nowhere.
        expect(h.act('confirm'), `${id}: the pad's Confirm did nothing`).toBe(true);
        expect(controls.length).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
      // A RAISED BUDGET, not a hung test. `developer-config` is the registry-driven pane and
      // holds 163 controls; every pad Down re-derives the container's control list, and each
      // control's visibility is a `getComputedStyle` walk up to the container, so the full walk
      // measures ~8s under jsdom against ~40ms for a 13-control pane. Truncating it to a sample
      // is the one thing this file exists to stop -- the panes that went unchecked were exactly
      // the ones nobody walked to the end.
    }, 30_000);
  }
});

describe('every HUD surface hands the pad a panel, or says why it does not (issue #914)', () => {
  const surfaces = Object.keys(SURFACE_REACH) as HudSurface[];

  it('covers every surface id', () => {
    expect(surfaces.length, 'a surface was added or removed; the record above is the place to say so').toBe(6);
  });

  for (const surface of surfaces) {
    const reach = SURFACE_REACH[surface];
    if ('noPanel' in reach) {
      it(`leaves ${surface} without an active panel on purpose -- ${reach.noPanel}`, () => {
        const { hud: h, root } = mount();
        h.setState(surface);
        // Nothing to walk, and the assertion is that the pad is refused rather than silently
        // moving something: `act` returns false when no panel is active.
        expect(h.act('down'), `${surface} claimed a pad Down with no panel open`).toBe(false);
        expect(root.querySelector('.hud-panel')).not.toBeNull();
      });
      continue;
    }

    it(`walks .hud-panel at ${surface}, whose control set is its own`, () => {
      vi.useFakeTimers();
      try {
        const { hud: h, root } = mount();
        // An outcome panel needs an outcome pushed into it, or the panel renders without the
        // tally its summary line reads and the controls under test are never built.
        if (surface === 'outcome-win') h.setOutcome(outcome('mission-clear'));
        if (surface === 'outcome-lose') h.setOutcome(outcome('campaign-over'));
        h.setState(surface);
        vi.advanceTimersByTime(1000);
        const panel = q(root, '.hud-panel');
        walkWithPad(h, panel, `.hud-panel at ${surface}`);
      } finally {
        vi.useRealTimers();
      }
    });
  }
});
