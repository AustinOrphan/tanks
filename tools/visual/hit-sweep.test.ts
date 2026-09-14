import { describe, expect, it } from 'vitest';

import { SCREEN_STATE_IDS, SCREEN_STATES, STEP_KINDS } from '../screens/states.mjs';
import { HIT_EXTRA_STATES, hitSweepExclusion, hitSweepStates } from './hit-sweep.mjs';

/**
 * Issue #710: the `visual` gate sweeps menu hit targets, and WHICH surfaces it sweeps is
 * decided here rather than in `verify.mjs`, which runs on import. The population below is
 * the screen-state catalogue as it stands: 33 states, 11 excluded, 22 swept, plus 2 extras.
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
};

describe('hit-sweep.mjs: which surfaces the visual gate sweeps', () => {
  it('excludes exactly the developer, startup-failure, no-script and match-failure states, each for its rule', () => {
    // Negative controls, one per rule: deleting any of the four clauses in hitSweepExclusion
    // lets that rule's states through -- 7, 2, 1 and 1 -- and this map no longer matches.
    const actual: Record<string, string[]> = {};
    for (const state of SCREEN_STATES) {
      const reason = hitSweepExclusion(state);
      if (reason !== null) (actual[reason] ??= []).push(state.id);
    }
    expect(actual).toEqual(EXCLUDED);
  });

  it('sweeps every other catalogue state, the endings included, then the two extra surfaces', () => {
    // Negative control: dropping HIT_EXTRA_STATES from the result loses the last two ids.
    const excluded = new Set(Object.values(EXCLUDED).flat());
    expect(hitSweepStates().map((s) => s.id)).toEqual([
      ...SCREEN_STATE_IDS.filter((id) => !excluded.has(id)),
      'extra.controllers',
      'extra.settings.reset-armed',
    ]);
    expect(hitSweepStates()).toHaveLength(24);
  });

  it('sweeps a state added to the catalogue without being told to', () => {
    // An allowlist would pass the two cases above against today's catalogue and silently skip
    // tomorrow's screen. Negative control: filtering by a fixed id list fails this.
    const added = { ...SCREEN_STATES[0], id: 'screen.a-future-screen' };
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
