import { describe, expect, it } from 'vitest';

import { SCREEN_STATE_IDS, SCREEN_STATES, STEP_KINDS } from '../screens/states.mjs';
import { HIT_EXTRA_STATES, hitSweepExclusion, hitSweepStates } from './hit-sweep.mjs';

/**
 * Issue #710: the `visual` gate sweeps menu hit targets, and WHICH surfaces it sweeps is
 * decided here rather than in `verify.mjs`, which runs on import. The population below is
 * the screen-state catalogue as it stands: 41 states, 16 excluded, 25 swept, plus 1 extra.
 */

/** Every excluded catalogue state, by the rule that removes it. */
const EXCLUDED = {
  'a developer pane, reached only behind ?dev=1': [
    'screen.devtools',
    'screen.devtools.config',
    'screen.devtools.config.sandbox',
    'screen.devtools.production-save',
    'screen.devtools.actions',
    'screen.devtools.diagnostics',
    'screen.devtools.controller-selftest',
  ],
  'a startup failure page, which has no menu to press': [
    'screen.startup.unsupported-render',
    'screen.startup.probe-blocked',
  ],
  'the no-script page: the collector runs as page script': ['screen.no-script'],
  'the match failure overlay, owned by its own capture': ['screen.startup.match-failed'],
  'a played ending, whose panel its pushed-outcome state already sweeps': [
    'screen.ending.mission-clear.played',
    'screen.ending.campaign-over.played',
  ],
  // Issue #841's three menu-less states. MEASURED, not assumed: `screen.practice` was swept
  // on the first attempt and reported "no controls measured" in all four viewports, because
  // a live board's only controls are the driving ones the collector leaves out.
  'a state with no menu: nothing here is a hit target': [
    'screen.boot-loading',
    'screen.launch',
    'screen.practice',
  ],
};

describe('hit-sweep.mjs: which surfaces the visual gate sweeps', () => {
  it('excludes exactly the developer, startup-failure, no-script, match-failure and played-ending states, each for its rule', () => {
    // Negative controls, one per rule: deleting any of the five clauses in hitSweepExclusion
    // lets that rule's states through -- 7, 2, 1, 1 and 2 -- and this map no longer matches.
    const actual: Record<string, string[]> = {};
    for (const state of SCREEN_STATES) {
      const reason = hitSweepExclusion(state);
      if (reason !== null) (actual[reason] ??= []).push(state.id);
    }
    expect(actual).toEqual(EXCLUDED);
  });

  it('sweeps every other catalogue state, the endings included, then the extra surface', () => {
    // Negative control: dropping HIT_EXTRA_STATES from the result loses the last id.
    const excluded = new Set(Object.values(EXCLUDED).flat());
    expect(hitSweepStates().map((s) => s.id)).toEqual([
      ...SCREEN_STATE_IDS.filter((id) => !excluded.has(id)),
      'extra.settings.reset-armed',
    ]);
    // 25 since issue #754's Controller Layout state: a Settings pane, so it is swept. 26 since
    // issue #766: the Controllers extra became `screen.controllers`, and `screen.controllers.pads`
    // joined it, so the pane is swept once without pads and once with two. Still 26 after issue
    // #841, because all three states that issue added declare no menu: its first attempt swept
    // the practice board and failed, since a live board offers only the driving controls the
    // collector excludes, so there was nothing to press. 29 since issue #842, which added three
    // interactive Settings states -- focused, pressed and rumble-refused -- and a Settings pane
    // IS swept whatever put it on screen. 30 since issue #844's `screen.settings.touch`, by that
    // same rule, and it is the one addition that changes what the sweep MEASURES rather than
    // only how the pane was reached: `measureHitTargets` honours the catalogue's touch flag, so
    // this state contributes `.hud-scheme-toggle` and `.hud-firemode-toggle`, two hit targets
    // no other swept state has because `control-relevance.ts` omits them without a touchscreen.
    // 32 since issue #781 added the two entry-bundle failure cards. They are SWEPT rather than
    // excluded, on evidence: the card offers a Reload button, and a real capture measured it at
    // 95x47 CSS px, clearing the 44px floor this sweep exists to enforce. Excluding them would
    // have left the only control on a page a player can actually land on unmeasured.
    expect(hitSweepStates()).toHaveLength(32);
    expect(hitSweepStates().map((s) => s.id)).toEqual(expect.arrayContaining(['screen.controllers', 'screen.controllers.pads']));
  });

  it('sweeps a state added to the catalogue without being told to', () => {
    // An allowlist would pass the two cases above against today's catalogue and silently skip
    // tomorrow's screen. Negative control: filtering by a fixed id list fails this.
    // The first state the sweep ACCEPTS, not `SCREEN_STATES[0]`: the catalogue's first entry
    // is whatever was added most recently at the top, and issue #841 made it an excluded
    // pre-UI state -- which turned this case into an assertion about insertion order.
    const sweepable = SCREEN_STATES.find((s) => hitSweepExclusion(s) === null);
    const added = { ...sweepable, id: 'screen.a-future-screen' };
    expect(hitSweepStates([added]).map((s) => s.id)[0]).toBe('screen.a-future-screen');
  });

  it('gives each extra surface steps the shared runner accepts, and ids the catalogue does not use', () => {
    for (const extra of HIT_EXTRA_STATES) {
      expect(SCREEN_STATE_IDS).not.toContain(extra.id);
      for (const step of extra.steps) {
        expect(Object.keys(step).filter((k) => STEP_KINDS.includes(k))).toHaveLength(1);
      }
    }
  });

  it('seeds recorded stats for the armed reset, without which Reset stats is disabled', () => {
    const armed = HIT_EXTRA_STATES.find((s) => s.id === 'extra.settings.reset-armed');
    expect(Object.keys(armed?.storage ?? {})).toContain('tanks.stats.v1');
  });
});
