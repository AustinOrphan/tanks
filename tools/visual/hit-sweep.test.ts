import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SCREEN_STATE_IDS, SCREEN_STATES, STEP_KINDS } from '../screens/states.mjs';
import { HIT_EXTRA_STATES, HIT_VIEWPORTS, hitSweepExclusion, hitSweepStates } from './hit-sweep.mjs';

/**
 * Issue #710: the `visual` gate sweeps menu hit targets, and WHICH surfaces it sweeps is
 * decided here rather than in `verify.mjs`, which runs on import. The population below is
 * the screen-state catalogue as it stands: 50 states, 17 excluded, 33 swept, plus 1 extra.
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
  'the no-script page: the collector runs as page script': ['screen.no-script'],
  'the match failure overlay, owned by its own capture': ['screen.startup.match-failed'],
  // Issue #776 added the versus pair. They are excluded by the same rule and NOT for the
  // same second reason: the campaign endings each have a pushed-outcome twin this sweep does
  // see, and the versus results panel has none, because `loop.ts` has no `vs-match-end` arm.
  'a played ending: too many seconds of software-GL play for a required check': [
    'screen.ending.mission-clear.played',
    'screen.ending.campaign-over.played',
    'screen.ending.versus.ffa.played',
    'screen.ending.versus.teams.played',
  ],
  // Issue #841's three menu-less states. MEASURED, not assumed: `screen.practice` was swept
  // on the first attempt and reported "no controls measured" in all four viewports, because
  // a live board's only controls are the driving ones the collector leaves out.
  'a state with no menu: nothing here is a hit target': [
    'screen.boot-loading',
    'screen.launch',
    'screen.practice',
    // Issue #957. The touchscreen twin of the practice board, and the only state that shows
    // the driving controls. Excluded for the SAME reason and a second one: this sweep's
    // collector skips `.hud-touch` deliberately, and its floor is 44 px, which is the wrong
    // number for a control sized by `--hud-control-touch` at 56. The 56 px floor is asserted
    // in `hud.css.test.ts` instead, and the boxes are pinned by this state's own baseline.
    'screen.practice.touch',
  ],
};

describe('hit-sweep.mjs: which surfaces the visual gate sweeps', () => {
  it('excludes exactly the developer, no-script, match-failure, played-ending and menu-less states, each for its rule', () => {
    // Negative controls, one per rule: deleting any of the five clauses in hitSweepExclusion
    // lets that rule's states through -- 7, 1, 1, 4 and 4 -- and this map no longer matches.
    // Recounted off the map below rather than edited down from the old line, which said
    // "five clauses ... 7, 2, 1, 1 and 4": six rules by then, with issue #841's menu-less
    // three missing from a list that still read as complete.
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
    //
    // 34 since the two branded startup-failure pages joined them, for that same reason and on
    // the same kind of evidence: each draws one control, a focused Reload button, measured at
    // 96.8x46.8 CSS px in all four viewports against the 44 px floor. They were excluded
    // before because this driver could not produce them, not because there was nothing there.
    //
    // STILL 34 after issue #957's `screen.practice.touch`, and the catalogue grew to 50: the
    // new state declares no menu, so it joins the exclusion above rather than this list. Its
    // controls are driving controls, which this collector skips on purpose and whose floor is
    // 56 px rather than the 44 this sweep enforces.
    // 35 since issue #917's `screen.main-menu.pad-only`. It is the Main Menu, so it carries a
    // menu and joins this list rather than the exclusion above -- and it is the one member
    // reached with no keyboard and no pointer, which is the session a controller player
    // actually has. Its five measured selectors are identical to `screen.main-menu`'s, so it
    // adds a second sweep of the same controls from a different input history rather than new
    // surface area.
    expect(hitSweepStates()).toHaveLength(35);
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

/**
 * Issue #877. This driver navigates for ITSELF, separately from `verify.mjs`, so a guard added to its caller does not reach it -- the shape of bug issues #781 and #844 both hit in this file.
 *
 * A source-text assertion, like `tools/screens/capture.test.ts`'s, because what it guards
 * happens only in a real browser. It lives HERE rather than in
 * `tools/shared/audio-context.test.ts`'s sweep because this file already imports the module:
 * the mutation harness measures an entry through Vitest's own dependency graph, and a test
 * that only reads a file as text relates to nothing.
 */
describe('hit-sweep.mjs: removing the AudioContext constructor before boot', () => {
  it('installs the override on the hit-target context, unconditionally, before it navigates', () => {
    const src = readFileSync(new URL('./hit-sweep.mjs', import.meta.url), 'utf8');
    // Exactly two spaces: the body's own indentation. `\s*` would accept the call nested
    // inside an `if`, which is the one shape this exists to reject -- an override only some
    // machines installed would let two machines photograph different pages, which is
    // precisely the divergence these gates exist to catch.
    const call = /^ {2}await context\.addInitScript\(audioContextOverrideSource\(\)\);$/m;
    expect(src, 'the override is gone, conditional, or no longer on its own line').toMatch(call);
    const at = src.search(call);
    const firstGoto = src.indexOf('.goto(');
    expect(at, 'the override call was not found').toBeGreaterThan(-1);
    expect(firstGoto, 'no navigation was found').toBeGreaterThan(-1);
    expect(at, 'the override is installed after the first navigation').toBeLessThan(firstGoto);
  });
});

/**
 * The catalogue's `webgl` field reaches this driver, which is the third field to have needed
 * saying: issue #781's `entry` and issue #844's `touch` were each added to the catalogue,
 * honoured by `captureState`, and forgotten here, because the two navigate separately.
 *
 * `webgl` was forgotten differently, and worse. The other two failed loudly -- a card that
 * never appeared, a pane missing its touch-only controls. This one was papered over by an
 * EXCLUSION whose stated reason was about the page ("a startup failure page, which has no
 * menu to press") rather than about the driver, so the two branded failure pages read as
 * deliberately out of scope for the sweep for as long as the rule stood. They are not: each
 * draws exactly one control, and `boot.ts` focuses it.
 *
 * Asserted against the source for the same reason the AudioContext case above is: nothing a
 * unit test can construct drives a Playwright context, and the alternative -- trusting the
 * `visual` gate to notice -- is what the exclusion prevented for the whole life of the rule.
 */
describe('hit-sweep.mjs: the catalogue WebGL mode this driver must honour', () => {
  it('installs the WebGL override for a non-ok state, before it navigates', () => {
    const src = readFileSync(new URL('./hit-sweep.mjs', import.meta.url), 'utf8');
    // CONDITIONAL, unlike the AudioContext override above, and the condition is pinned:
    // `webglOverrideSource('ok')` is not a no-op -- steps.mjs falls through to the branch
    // that returns null from `getContext('webgl2')` -- so installing it unconditionally
    // would break every other swept state rather than fixing these two.
    const call =
      /^ {2}if \(state\.webgl !== 'ok'\) await context\.addInitScript\(webglOverrideSource\(state\.webgl\)\);$/m;
    expect(src, 'the WebGL override is gone, unguarded, or no longer on its own line').toMatch(call);
    const at = src.search(call);
    const firstGoto = src.indexOf('.goto(');
    expect(at, 'the override call was not found').toBeGreaterThan(-1);
    expect(at, 'the override is installed after the first navigation').toBeLessThan(firstGoto);
  });

  it('has states that need it, so the line above is not guarding an empty set', () => {
    // The negative control the regex alone cannot be: a guard for a condition no swept state
    // meets would pass every assertion above while measuring nothing. Deleting either page
    // from the catalogue -- or restoring the exclusion -- empties this list.
    const needOverride = hitSweepStates().filter((s) => s.webgl !== undefined && s.webgl !== 'ok');
    expect(needOverride.map((s) => s.id)).toEqual([
      'screen.startup.unsupported-render',
      'screen.startup.probe-blocked',
    ]);
  });
});

/**
 * Issue #933. `HIT_VIEWPORTS` is the only place issue #327's fifth criterion -- core menus
 * operable "at 200% zoom and minimum supported phone widths without two-axis scrolling" -- is
 * written as something a machine runs. Nothing asserted it: the list was referenced by its own
 * definition and by `verify.mjs`, which reads `.length` to print a summary line. Dropping an
 * entry would have changed that number and nothing else, leaving every required check green
 * while the conditions the criterion names quietly stopped being swept.
 */
describe('hit-sweep.mjs: the viewports issue #327 criterion 5 names (issue #933)', () => {
  const byName = (name: string) => HIT_VIEWPORTS.find((v) => v.name === name);

  it('sweeps the minimum supported phone width, at the size that makes it one', () => {
    // 320 CSS px is the narrowest width the project supports, and the width every horizontal
    // finding in this criterion was measured at: the hull swatch row was 324px here, and the
    // seven-level campaign grid spans x=-24..344. A wider "minimum" would pass both.
    expect(byName('320x568'), 'the minimum phone width is no longer swept').toEqual({
      name: '320x568', width: 320, height: 568, dpr: 2,
    });
  });

  it('sweeps the 200% zoom reading, whose CSS width is half the screen it stands for', () => {
    // The entry is a ZOOM, not just another small viewport, and the two numbers are what say
    // so: a 1280x800 screen at 200% browser zoom gives the page 640x400 CSS px at dpr 2.
    // Setting `width: 1280` here would leave the name claiming a zoom reading that is not
    // being taken -- the one change this assertion exists to reject.
    const zoom = byName('1280x800@200%');
    expect(zoom, 'the 200% zoom viewport is no longer swept').toEqual({
      name: '1280x800@200%', width: 640, height: 400, dpr: 2,
    });
    // Derived rather than restated, so the pair cannot drift apart: the label names the screen,
    // the width is what the page actually gets at 200%.
    const [nominalW, nominalH] = '1280x800@200%'.split('@')[0].split('x').map(Number);
    expect(zoom?.width, 'the zoom width is no longer half its screen').toBe(nominalW / 2);
    expect(zoom?.height, 'the zoom height is no longer half its screen').toBe(nominalH / 2);
  });

  it('keeps every entry frozen and uniquely named, since the sweep keys its readings by name', () => {
    // A reading is reported as `${state} ${viewport.name}`, so two entries sharing a name would
    // report two different measurements under one label and the second would read as a repeat.
    const names = HIT_VIEWPORTS.map((v) => v.name);
    expect(new Set(names).size, 'two viewports share a name').toBe(names.length);
    expect(Object.isFrozen(HIT_VIEWPORTS), 'the viewport list can be mutated at runtime').toBe(true);
    for (const v of HIT_VIEWPORTS) {
      expect(Object.isFrozen(v), `${v.name} can be mutated at runtime`).toBe(true);
      expect(v.width, `${v.name} has no width`).toBeGreaterThan(0);
      expect(v.height, `${v.name} has no height`).toBeGreaterThan(0);
    }
    // The two above are the criterion's; the other two are #686's phone and laptop readings.
    // Pinned as a COUNT rather than a list so adding a viewport is free and losing one is not.
    expect(HIT_VIEWPORTS.length, 'a viewport was dropped from the sweep').toBe(4);
  });
});

/**
 * Issue #932. The two collectors run only inside `page.evaluate`, where no Vitest run reaches
 * them -- jsdom reports 0 for every layout property they read, so there is nothing to execute
 * here even in principle. What the verdict CAN be held to lives in `hit-targets.mjs` and is
 * tested there; what is left is the wiring, and the wiring is exactly what went wrong before:
 * a reading that is collected but never handed over is indistinguishable from a clean one.
 */
describe('hit-sweep.mjs: handing the sideways reading to the verdict', () => {
  const src = () => readFileSync(new URL('./hit-sweep.mjs', import.meta.url), 'utf8');

  it('collects the sideways reading and puts it on the overflow object it returns', () => {
    expect(src(), 'the sideways collector is no longer run in the page')
      .toMatch(/overflow\.sideways = await page\.evaluate\(COLLECT_SIDEWAYS\);/);
    // Before the controls are returned, not after: `measureHitTargets` returns `overflow`
    // itself, so a collection that happened later would never reach the verdict.
    const assigned = src().search(/overflow\.sideways = await page\.evaluate/);
    const returned = src().indexOf('return { state: state.id, viewport: viewport.name, controls, overflow');
    expect(assigned, 'the sideways reading is never collected').toBeGreaterThan(-1);
    expect(returned, 'the reading is no longer returned').toBeGreaterThan(-1);
    expect(assigned, 'the reading is collected after it is returned').toBeLessThan(returned);
  });

  it('reports every wider-than-its-box element, leaving both exemptions to the verdict', () => {
    // The split this module is built on. Filtering in the page would put the two exemptions --
    // visible overflow, and the one-pixel visually-hidden box -- somewhere no test and no
    // mutation entry can reach, which is how `overflow.page` stayed dead for so long.
    const collector = /export const COLLECT_SIDEWAYS = \(\) => \{[\s\S]*?\n\};/.exec(src())?.[0] ?? '';
    expect(collector, 'the sideways collector is gone').not.toBe('');
    expect(collector, 'the collector now judges overflowX, which belongs in the verdict')
      .not.toMatch(/overflowX\s*===/);
    expect(collector, 'the collector now judges the box width, which belongs in the verdict')
      .not.toMatch(/clientWidth\s*<=/);
    // It must still REPORT both, or the verdict has nothing to judge on.
    expect(collector, 'overflowX is no longer reported').toMatch(/overflowX: getComputedStyle\(el\)\.overflowX/);
    expect(collector, 'the client width is no longer reported').toMatch(/clientW: el\.clientWidth/);
  });

  it('cuts the pressable width to the viewport across, and leaves the height alone', () => {
    const controls = /export const COLLECT_CONTROLS = \(\) => \{[\s\S]*?\n\};/.exec(src())?.[0] ?? '';
    expect(controls, 'the control collector is gone').not.toBe('');
    expect(controls, 'the pressable width no longer clips to the viewport')
      .toMatch(/Math\.min\(right, window\.innerWidth\) - Math\.max\(left, 0\)/);
    expect(controls, 'the pressable width is no longer reported').toMatch(/^ {6}pressableW,$/m);
    // ACROSS ONLY. A pressable HEIGHT cut to the viewport would fail every control below the
    // fold on a long pane, which scrolling answers and `reachable` already asks about.
    expect(controls, 'a viewport-clipped height appeared, which scrolling already answers')
      .not.toMatch(/window\.innerHeight\) - Math\.max\(top/);
  });
});
