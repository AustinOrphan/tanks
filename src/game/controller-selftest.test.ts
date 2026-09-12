// @vitest-environment jsdom
//
// The Developer Tools controller self-test view (issue #599). Each case names the
// production change it would catch, because a renderer test that asserts "it produced some
// elements" advertises coverage it does not have.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderControllerSelfTest } from './controller-selftest';
import type { PadDiagnostic } from '../input/gamepad-diagnostics';

function pad(overrides: Partial<PadDiagnostic> = {}): PadDiagnostic {
  return {
    padIndex: overrides.padIndex ?? 0,
    id: overrides.id ?? 'Test Pad',
    mapping: overrides.mapping ?? 'standard',
    axes: overrides.axes ?? [0, 0],
    buttons: overrides.buttons ?? [
      { pressed: false, value: 0 },
      { pressed: false, value: 0 },
    ],
  };
}

const CONTEXT = { userAgent: 'Fixture/1.0', url: 'https://example.test/?dev=1' };

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const channels = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.hud-selftest-channel'));
const values = (): (string | null)[] =>
  Array.from(container.querySelectorAll('.hud-selftest-channel-value')).map((n) => n.textContent);

describe('renderControllerSelfTest: structure', () => {
  it('builds one channel row per axis and per button, and names each by its index', () => {
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad({ axes: [0, 0, 0], buttons: [{ pressed: false, value: 0 }] })]);
    expect(
      Array.from(container.querySelectorAll('.hud-selftest-channel-name')).map((n) => n.textContent),
    ).toEqual(['Axis 0', 'Axis 1', 'Axis 2', 'Button 0']);
  });

  it('states the mapping and both counts on the row, not only in the copied report', () => {
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad({ padIndex: 2, id: '', mapping: '', axes: [0], buttons: [] })]);
    expect(container.querySelector('.hud-selftest-pad-name')?.textContent).toBe(
      'Index 2 — Controller 2',
    );
    expect(container.querySelector('.hud-selftest-pad-meta')?.textContent).toBe(
      'mapping: (none reported) · axes: 1 · buttons: 0',
    );
  });

  it('keeps the SAME nodes across a frame whose pad set has not changed', () => {
    // The load-bearing one. `update` runs every animation frame, so a render that rebuilt
    // unconditionally would replace every node sixty times a second -- which is how the
    // assignment panel loses a focused control on a hotplug (hud.navigation.test.ts). If
    // the pad-set identity check is removed or weakened to "always rebuild", this fails and
    // nothing else here does: every value assertion below passes on a fresh tree too.
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad()]);
    const before = channels();
    view.update([pad({ axes: [0.5, -0.5] })]);
    const after = channels();
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
  });

  it('REBUILDS when the pad set changes, so a pad with a different channel count is not drawn on the old rows', () => {
    // The negative control for the case above: an identity check that never rebuilt would
    // leave the first pad's two channels on screen for a pad that has four.
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad()]);
    const before = channels();
    view.update([pad({ id: 'Other Pad', axes: [0, 0, 0, 0], buttons: [] })]);
    expect(channels().length).toBe(4);
    expect(channels()[0]).not.toBe(before[0]);
  });

  it('marks AXIS rows and not button rows, which is what scopes the bar’s centre tick', () => {
    // The stylesheet draws a centre mark on `--axis` only. A button fills 0 to 1 from the
    // left and has no centre to mark; drawn there the tick reads as a partial fill on an
    // untouched button, which is what the first capture of this pane showed on all 17
    // button rows of a standard pad. jsdom cannot see the gradient, so the CLASS is what is
    // assertable here -- and it is the whole of the selector the rule turns on.
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad({ axes: [0, 0], buttons: [{ pressed: false, value: 0 }] })]);
    expect(
      channels().map((c) => c.classList.contains('hud-selftest-channel--axis')),
    ).toEqual([true, true, false]);
  });

  it('renders each connected pad as its own row, keyed by the index the browser gave it', () => {
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad({ padIndex: 1, id: 'A' }), pad({ padIndex: 3, id: 'B' })]);
    expect(
      Array.from(container.querySelectorAll('.hud-selftest-pad-name')).map((n) => n.textContent),
    ).toEqual(['Index 1 — A', 'Index 3 — B']);
  });
});

describe('renderControllerSelfTest: live values', () => {
  it('writes each axis and button value on every frame, without rebuilding', () => {
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad()]);
    expect(values()).toEqual(['0.00', '0.00', '0.00', '0.00']);
    view.update([
      pad({ axes: [-0.75, 0.25], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.4 }] }),
    ]);
    expect(values()).toEqual(['-0.75', '0.25', '1.00', '0.40']);
  });

  it('fills an axis from the CENTRE and a button from the left', () => {
    // Two different rest positions on one bar shape. An axis rests at the MIDDLE of its
    // range, so drawing it left-filled maps a centred stick to a half-full bar -- measured
    // in the first capture of this pane, where a resting Axis 2 drew a longer fill than a
    // trigger genuinely held at 0.35. Direction is carried by which side of centre the fill
    // grows on, which a left-filled bar cannot express at all.
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([
      pad({
        axes: [-1, 0, 1, -0.5],
        buttons: [{ pressed: false, value: 0.5 }],
      }),
    ]);
    const fills = Array.from(container.querySelectorAll<HTMLElement>('.hud-selftest-channel-fill')).map(
      (n) => [n.style.marginInlineStart, n.style.width],
    );
    // jsdom normalises the CSS lengths, so these are the strings the browser stores rather
    // than the ones the code writes.
    expect(fills).toEqual([
      ['0%', '50%'], // axis -1: hard left, filling from centre back to the start
      ['50%', '0%'], // axis 0: at rest, EMPTY -- the case a left-filled bar got wrong
      ['50%', '50%'], // axis +1: hard right
      ['25%', '25%'], // axis -0.5: half left
      ['0%', '50%'], // button 0.5: from the left edge, half travelled
    ]);
  });

  it('marks a pressed button down and takes the mark off again when it is released', () => {
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad({ buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0 }] })]);
    const down = () => channels().map((c) => c.classList.contains('hud-selftest-channel--down'));
    expect(down()).toEqual([false, false, true, false]);
    view.update([pad({ buttons: [{ pressed: false, value: 0 }, { pressed: false, value: 0 }] })]);
    expect(down()).toEqual([false, false, false, false]);
  });
});

describe('renderControllerSelfTest: the empty state', () => {
  it('explains that a pad must be actuated once, and hides that once a pad appears', () => {
    // A connected-but-silent pad is the FIRST thing a tester sees, and a blank pane reads
    // as a broken feature. The text is the only thing that distinguishes the two.
    const view = renderControllerSelfTest(container, () => CONTEXT);
    const empty = container.querySelector('.hud-selftest-empty') as HTMLElement;
    expect(empty.textContent).toMatch(/moved or pressed once/);
    view.update([]);
    expect(empty.classList.contains('hud-selftest-empty--hidden')).toBe(false);
    view.update([pad()]);
    expect(empty.classList.contains('hud-selftest-empty--hidden')).toBe(true);
    view.update([]);
    expect(empty.classList.contains('hud-selftest-empty--hidden')).toBe(false);
  });
});

describe('renderControllerSelfTest: the copyable report', () => {
  it('reports the pads from the most recent frame, with the page context', () => {
    const view = renderControllerSelfTest(container, () => CONTEXT);
    view.update([pad({ padIndex: 4, id: 'Report Pad' })]);
    const text = view.report();
    expect(text).toContain('Fixture/1.0');
    expect(text).toContain('https://example.test/?dev=1');
    expect(text).toContain('### Index 4 -- Report Pad');
  });

  it('re-reads the context at copy time rather than freezing the one it was built with', () => {
    // The URL carries the developer parameters, and those change without a reload
    // (`developerExitSearch`). A context captured at construction would attribute a report
    // to the wrong flags.
    let url = 'https://example.test/?dev=1';
    const view = renderControllerSelfTest(container, () => ({ userAgent: 'Fixture/1.0', url }));
    view.update([]);
    url = 'https://example.test/?dev=1&gamepad=1';
    expect(view.report()).toContain('gamepad=1');
  });
});
