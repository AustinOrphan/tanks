import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  subsetStates, baselineFileName, readBaseline, serialiseBaseline,
  diffMeasurements, formatFailure, brief, judgePageErrors, formatPageErrorRefusal } from './baseline.mjs';
import { judgeState, checkExitCode, formatVerdict, recipeFor } from './check.mjs';
import { statesToAccept } from './accept.mjs';
import { SCREEN_STATES } from './states.mjs';

const m = (over: Record<string, unknown> = {}) => ({
  selector: '.a', present: true, visible: true, text: 'x',
  box: { x: 0, y: 0, w: 10, h: 4 }, style: { color: 'red', 'font-size': '16px' }, ...over,
});
const recipe = {
  id: 'screen.a', viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
  profile: { visual: 'software-gl', capability: 'headless-desktop', motion: 'reduced' },
};

describe('the screen baseline: which states it covers (issues #840, #846)', () => {
  it('covers every state except the played endings, as a RULE rather than a list', () => {
    // #840's decision is "every state except the two played endings", and the prose beside it
    // quoted a count the catalogue outgrew within a day. A rule survives a new state; a
    // hard-coded list silently stops covering one.
    const ids = subsetStates(SCREEN_STATES).map((s) => s.id);
    expect(ids).not.toContain('screen.ending.mission-clear.played');
    expect(ids).not.toContain('screen.ending.campaign-over.played');
    expect(ids.length, 'the subset is the catalogue minus exactly the played pair')
      .toBe(SCREEN_STATES.length - 2);
    // Negative control: a state added tomorrow is covered without anyone editing this file.
    const grown = [...SCREEN_STATES, { ...SCREEN_STATES[0], id: 'screen.a-future-screen' }];
    expect(subsetStates(grown).map((s) => s.id)).toContain('screen.a-future-screen');
  });

  it('refuses a state id that could escape the baseline directory', () => {
    // The id becomes a file name, so a traversal in one would write outside the store.
    for (const bad of ['../escape', 'a/b', 'a\\b', 'CAPS', '']) {
      expect(() => baselineFileName(bad), bad).toThrow(/unsafe state id/);
    }
    expect(baselineFileName('screen.main-menu')).toBe('screen.main-menu.json');
  });

  it('serialises a baseline the way every other committed JSON here is written', () => {
    const text = serialiseBaseline('screen.a', [m()]);
    expect(text.endsWith('\n'), 'no trailing newline').toBe(true);
    expect(text).toContain('\n  "state": "screen.a"');
    expect(JSON.parse(text)).toEqual({ state: 'screen.a', measurements: [m()] });
  });

  it('reads a missing baseline as null rather than throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baseline-'));
    try {
      expect(readBaseline(dir, 'screen.absent')).toBeNull();
      await writeFile(join(dir, 'screen.a.json'), serialiseBaseline('screen.a', [m()]));
      expect(readBaseline(dir, 'screen.a')?.measurements).toEqual([m()]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('the screen baseline: what a diff says (issue #846)', () => {
  it('finds nothing when nothing moved', () => {
    expect(diffMeasurements([m()], [m()])).toEqual([]);
  });

  it('names the field that moved, not the whole entry', () => {
    const changes = diffMeasurements([m()], [m({ box: { x: 0, y: 0, w: 12, h: 4 } })]);
    expect(changes).toEqual([{ selector: '.a', field: 'box.w', expected: 10, actual: 12 }]);
  });

  it('reports a watched style property, which is what makes pixels unnecessary', () => {
    // #840 chose measurements over pixels partly because these are already watched. If a
    // colour change did not surface here, that argument would be false.
    const changes = diffMeasurements([m()], [m({ style: { color: 'blue', 'font-size': '16px' } })]);
    expect(changes).toEqual([{ selector: '.a', field: 'style.color', expected: 'red', actual: 'blue' }]);
  });

  it('keys on the SELECTOR, so adding one does not report every later entry as changed', () => {
    // A positional walk reports the added entry and everything after it. The names are what
    // a reader needs, and they are what makes a diff readable exactly when it is long.
    const before = [m({ selector: '.a' }), m({ selector: '.c' })];
    const after = [m({ selector: '.a' }), m({ selector: '.b' }), m({ selector: '.c' })];
    expect(diffMeasurements(before, after)).toEqual([
      { selector: '.b', field: '(whole entry)', expected: 'not measured', actual: 'newly measured' },
    ]);
  });

  it('reports a selector that stopped being measured', () => {
    expect(diffMeasurements([m({ selector: '.gone' })], [])).toEqual([
      { selector: '.gone', field: '(whole entry)', expected: 'measured', actual: 'no longer measured' },
    ]);
  });

  it('names the recipe, the state, the viewport AND the profile, every time', () => {
    // #326's requirement verbatim: "Failure output names the recipe, route/state,
    // viewport/profile". The subset runs ONE viewport today, which is exactly the condition
    // under which a report quietly stops naming it.
    const text = formatFailure({
      recipeId: 'screen.a', stateId: 'screen.a',
      viewport: recipe.viewport, profile: recipe.profile,
      changes: diffMeasurements([m()], [m({ visible: false })]),
    });
    expect(text).toContain('FAIL screen.a');
    expect(text).toContain('1280x800@2');
    expect(text).toContain('software-gl/headless-desktop/motion=reduced');
    expect(text).toContain('.a visible: expected true, got false');
  });

  it('shortens a long value in the terminal, and says how long it really was', () => {
    // A panel's text runs to hundreds of characters of markup whitespace. Printed whole, the
    // one line that says what changed becomes a screenful that hides it.
    // Long AFTER whitespace collapsing, which is the case that matters: the collapse is what
    // makes a panel's text readable at all, and only what survives it can overflow a line.
    const long = `TANKS!${'\n      '.repeat(6)}${'Continue Campaign Start New Campaign Choose Level '.repeat(3)}`;
    const out = brief(long);
    expect(out).toMatch(/…" \(\d+ chars\)$/);
    expect(out.length).toBeLessThan(120);
    expect(out, 'whitespace runs are collapsed').not.toContain('\n');
    expect(brief('short')).toBe('"short"');
  });
});

describe('the screen gate: the verdict for one state (issue #846)', () => {
  const report = (over: Record<string, unknown> = {}) => ({ measurements: [m()], pageErrors: [], ...over });

  it('passes when the capture matches the baseline', () => {
    const v = judgeState({ stateId: 'screen.a', recipe, baseline: { measurements: [m()] }, report: report() });
    expect(v.status).toBe('match');
    expect(checkExitCode([v])).toBe(0);
  });

  it('fails on a PAGE ERROR even when the measurements are unchanged', () => {
    // `sweep.mjs` hashes the measurements alone, so a state that started throwing would keep
    // its hash and pass. An uncaught error on a screen is a defect whatever the layout did.
    const v = judgeState({
      stateId: 'screen.a', recipe, baseline: { measurements: [m()] },
      report: report({ pageErrors: ['TypeError: boom'] }),
    });
    expect(v.status).toBe('page-error');
    expect(formatVerdict(v)).toContain('TypeError: boom');
    expect(checkExitCode([v])).toBe(1);
  });

  it('fails a state with no baseline, and says exactly how to make one', () => {
    const v = judgeState({ stateId: 'screen.a', recipe, baseline: null, report: report() });
    expect(v.status).toBe('no-baseline');
    expect(formatVerdict(v)).toContain('npm run screens:accept -- --state screen.a');
    expect(checkExitCode([v])).toBe(1);
  });

  it('reports a capture that never happened, rather than a diff it cannot have', () => {
    // The failure mode with the LEAST for a reader to go on, so it says what went wrong
    // rather than printing an empty change list. Measured: an earlier draft returned before
    // writing anything, and a degraded run left 37 failures and an empty evidence directory.
    const v = { stateId: 'screen.a', status: 'capture-failed', pageErrors: ['page.goto: Timeout 30000ms exceeded.'], changes: [] };
    expect(formatVerdict(v)).toContain('the capture itself failed');
    expect(formatVerdict(v)).toContain('Timeout 30000ms');
    expect(checkExitCode([v])).toBe(1);
  });

  it('refuses to pass a run that checked nothing', () => {
    // An empty run is the failure mode a filter typo produces, and "0 failing" reads as
    // success. `compareExitCode` guards the same thing for the sweep.
    expect(checkExitCode([])).toBe(1);
  });

  it('finds the recipe that owns a state, and answers null for one with none', () => {
    const recipes = [{ id: 'screen.a', producer: { scenarioId: 'screen.a' } }];
    expect(recipeFor('screen.a', recipes)?.id).toBe('screen.a');
    expect(recipeFor('screen.absent', recipes)).toBeNull();
  });

  it('gives every checked state a recipe, so no failure can go unnamed', () => {
    for (const state of subsetStates(SCREEN_STATES)) {
      expect(recipeFor(state.id), `${state.id} has no recipe`).not.toBeNull();
    }
  });
});

describe('the screen gate: accepting is a deliberate act (issue #326)', () => {
  it('will not rewrite anything unless asked for a state or for all of them', () => {
    // "A successful test run is not automatic approval of a changed design." Accepting
    // everything is the move that turns a review into a rubber stamp, so it is spelled out.
    expect(() => statesToAccept({ only: null, all: false })).toThrow(/--state <id>, or pass --all/);
    expect(statesToAccept({ only: null, all: true }).length).toBe(subsetStates(SCREEN_STATES).length);
    expect(statesToAccept({ only: 'screen.main-menu', all: false }).map((s) => s.id)).toEqual(['screen.main-menu']);
  });

  it('refuses a state outside the checked subset, rather than writing a baseline nothing reads', () => {
    expect(() => statesToAccept({ only: 'screen.ending.mission-clear.played', all: false }))
      .toThrow(/not in the checked subset/);
    expect(() => statesToAccept({ only: 'screen.not-a-state', all: false })).toThrow(/not in the checked subset/);
  });
});

describe('the screen gate: a state whose subject IS a page error (issue #861)', () => {
  const plain = { id: 'screen.main-menu' };
  const declared = { id: 'screen.startup.entry-unparseable', pageError: 'SyntaxError' };

  it('still refuses an undeclared error, which is every other state', () => {
    expect(judgePageErrors(plain, []).ok).toBe(true);
    const v = judgePageErrors(plain, ['TypeError: x is not a function']);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unexpected');
  });

  it('accepts the declared error as the design rather than refusing to look', () => {
    const v = judgePageErrors(declared, ["SyntaxError: Unexpected token ';'"]);
    expect(v.ok, 'the state that exists to photograph a parse failure was refused').toBe(true);
  });

  it('fails when the declared error does NOT appear, because the card is no longer reached', () => {
    // The direction that is easy to leave out. Every measured selector can still match while
    // the state has quietly stopped demonstrating the failure it was written for.
    const v = judgePageErrors(declared, []);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('missing');
  });

  it('fails on a DIFFERENT error, so the declaration cannot launder an unrelated regression', () => {
    const v = judgePageErrors(declared, ['TypeError: boot is not a function']);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('mismatch');
    expect(v.errors, 'the refusal should name the stray error, not the expected one')
      .toEqual(['TypeError: boot is not a function']);
  });

  it('fails when a stray error rides ALONGSIDE the declared one', () => {
    // A declaration is per-error, not a blanket amnesty for the capture.
    const v = judgePageErrors(declared, ["SyntaxError: Unexpected token ';'", 'TypeError: later boom']);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(['TypeError: later boom']);
  });

  it('words the three refusals differently, because they need different fixes', () => {
    const missing = formatPageErrorRefusal(judgePageErrors(declared, []), declared.id);
    const mismatch = formatPageErrorRefusal(judgePageErrors(declared, ['TypeError: nope']), declared.id);
    const unexpected = formatPageErrorRefusal(judgePageErrors(plain, ['TypeError: nope']), plain.id);
    expect(missing).toMatch(/raised none/);
    expect(mismatch).toMatch(/does not match the declared/);
    expect(unexpected).toMatch(/no design to approve/);
    expect(new Set([missing, mismatch, unexpected]).size, 'two refusals read the same').toBe(3);
  });
});
