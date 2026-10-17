// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GameplayOutcome, HudLayerId, HudSurface } from './hud';
import {
  LAYER_REACH,
  layerReachCase,
  mount,
  q,
  unmount,
  WALKED_IN_OWN_FILE,
  walkWithPad,
} from './hud-reachability-fixtures';
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
 * The two records are `Record<HudLayerId, ...>` (`LAYER_REACH`, in `hud-reachability-fixtures.ts`)
 * and `Record<HudSurface, ...>` (below), so adding a member to either union without saying how to
 * reach it does not compile. That is the whole mechanism: the omission becomes a build error at
 * the moment it is introduced, rather than a silence nobody is looking for.
 * `activePanelContainer` in `hud.ts` reads the same `LAYERS` record for the same reason.
 *
 * ONE LAYER IS WALKED ELSEWHERE: `developer-config`, in `hud.reachability.devconfig.test.ts`,
 * for the mutation harness's sake (the fixtures module says why). Both files read the one list
 * of layers walked apart, `WALKED_IN_OWN_FILE`: this one skips them and that one walks them.
 *
 * WHERE EACH ARRIVAL LANDS (issue #919) is pinned in the same two records: every row names the
 * control its surface's arrival must focus, or `null` for a surface with no primary action,
 * whose container takes focus instead. Spelled out literally rather than read from `hud.ts`'s
 * `LAYERS`/`PANEL_PRIMARY`, so a primary that moves in production fails here instead of
 * moving the expectation with it. 19 surfaces: 15 layers, 4 of them with a primary action
 * (levelselect, versus-setup, confirm-new-campaign, match-failed) and 11 without; and the
 * panel's 4 states, all with one (main-menu, paused, outcome-win, outcome-lose).
 */

afterEach(unmount);

/**
 * A surface with no active panel is a decided design, not an omission; it says which and why.
 * A surface with one names the control its arrival focuses (issue #919).
 */
type SurfaceReach = { readonly selector: string; readonly primary: string } | { readonly noPanel: string };

const SURFACE_REACH: Record<HudSurface, SurfaceReach> = {
  launch: { noPanel: 'the splash: the panel, topbar and touch row are all hidden behind it' },
  playing: { noPanel: 'a live match: the arrows and the stick drive the tank, not a menu' },
  // No run in this fixture, so Start Campaign; with one it is Continue Campaign, pinned in
  // the arrival cases below.
  'main-menu': { selector: '.hud-panel', primary: '.hud-new-game' },
  paused: { selector: '.hud-panel', primary: '.hud-action' }, // Resume
  'outcome-win': { selector: '.hud-panel', primary: '.hud-action' }, // Next Level
  'outcome-lose': { selector: '.hud-panel', primary: '.hud-action' }, // the campaign-over action
};

/** A campaign-shaped ending, in the shape `pushOutcome` really hands the HUD. */
const outcome = (kind: 'mission-clear' | 'campaign-over'): GameplayOutcome => ({
  tally: 'solo',
  attempt: ZERO_STATS,
  action: 'campaign-levels',
  typedOutcome: { kind },
});

describe('every HUD layer is reachable by arrows and by a D-pad (issue #914)', () => {
  const ids = Object.keys(LAYER_REACH) as HudLayerId[];
  const walkedHere = ids.filter((id) => !WALKED_IN_OWN_FILE.includes(id));

  it('covers every layer id, with no entry for a layer that does not exist', () => {
    // The record is exhaustive by its type; this is the other direction -- an entry left behind
    // for a layer that was removed would sweep a pane nobody can open and read as coverage.
    expect(ids.length, 'a layer was added or removed; the record above is the place to say so').toBe(15);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('walks every layer here except the ones hud.reachability.devconfig.test.ts walks', () => {
    // The split is for the mutation harness, and it must not cost a layer its walk: a layer is
    // skipped here only if it is on the list that file walks. Compared against every layer id
    // rather than the filter above, so a filter that drops one more layer fails here. It cannot
    // see that file itself: deleting or skipping it drops its walk with nothing failing.
    expect([...walkedHere, ...WALKED_IN_OWN_FILE].sort(), 'a layer is walked in neither file').toEqual(
      [...ids].sort(),
    );
  });

  // 30s each, as before the split: the jsdom 30.1.2 slowdown that made developer-config's walk
  // take 87s on a CI shard leaves every other layer under 4s there.
  for (const id of walkedHere) layerReachCase(id, 30_000);
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
        const announced: (Element | null)[] = [];
        h.onArrival(() => announced.push(document.activeElement));
        h.setState(surface);
        vi.advanceTimersByTime(1000);
        const panel = q(root, '.hud-panel');
        expect(announced, `${surface}'s arrival was not announced exactly once`).toEqual([
          q(panel, reach.primary),
        ]);
        walkWithPad(h, panel, reach.primary, `.hud-panel at ${surface}`);
      } finally {
        vi.useRealTimers();
      }
    });
  }
});
