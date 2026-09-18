// @vitest-environment jsdom
//
// The controller-layout pane's model, rebind, capture and body (issue #754). Reaching the
// pane and the page's wiring are `hud.controller-layout.test.ts`'s and `route-ui.test.ts`'s.
import { describe, it, expect } from 'vitest';
import {
  activeLayoutProfile,
  captureResultStatus,
  controlName,
  createBindingCapture,
  layoutModel,
  rebind,
  renderControllerLayout,
  NO_CONTROLLER_TEXT,
  type ControllerLayoutModel,
  type LayoutRequest,
} from './controller-layout';
import {
  RECOMMENDED_LAYOUT,
  STANDARD_PROFILE,
  resolveEffectiveProfile,
  type ControlLayout,
  type ControlProfile,
} from '../input/gamepad-profile';
import type { ConnectedPad, GamepadLike } from '../input/gamepad';

/** A standard-mapped pad with the listed buttons held. */
function standardPad(pressed: readonly number[] = []): GamepadLike {
  return {
    id: 'Test Pad',
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
  };
}

/** A pad the game refuses to read: no mapping, and no catalogue entry matches it. */
function unreadablePad(pressed: readonly number[] = []): GamepadLike {
  return { ...standardPad(pressed), mapping: '' };
}

const frame = (...pads: GamepadLike[]): ConnectedPad[] => pads.map((pad, padIndex) => ({ padIndex, pad }));

const layout = (bindings: ControlLayout['bindings'], preset: ControlLayout['preset'] = 'recommended'): ControlLayout => ({
  preset,
  bindings,
});

const buttonsOf = (l: ControlLayout) => resolveEffectiveProfile(STANDARD_PROFILE, l).profile.buttons;

describe('names (issue #754)', () => {
  it('names every standard bindable control distinctly, and never by its raw index', () => {
    const bindable = STANDARD_PROFILE.bindable ?? [];
    const names = bindable.map((control) => controlName('standard', control.id));
    expect(new Set(names).size).toBe(bindable.length);
    for (const [i, control] of bindable.entries()) {
      // "L1" and "R2" are the controller's own printed labels; a bare index or "Button 7" is not.
      expect(names[i]).not.toMatch(new RegExp(`^(Button )?${control.index}$`));
      expect(names[i]).not.toBe('Unnamed button');
    }
    expect(controlName('standard', 'trigger-right')).toBe('RT / R2');
  });

  it('reads an unnamed control id as words rather than showing nothing', () => {
    expect(controlName('gamecube', 'face-bottom')).toBe('Face bottom');
    expect(controlName('standard', null)).toBe('Unnamed button');
  });
});

describe('layoutModel (issue #754)', () => {
  it('shows the recommended standard layout by name, with nothing to reset', () => {
    const model = layoutModel(STANDARD_PROFILE, RECOMMENDED_LAYOUT, null, '');
    expect(model.profileName).toBe('Standard controller');
    expect(model.presets).toEqual(['recommended', 'southpaw']);
    expect(model.rows.map((r) => `${r.actionName}: ${r.controlName}`)).toEqual([
      'Fire: RT / R2',
      'Mine: LT / L2',
      'Confirm: A / Cross',
      'Back: B / Circle',
      'Pause: Menu / Options',
    ]);
    expect(model.customised).toBe(false);
  });

  it('shows where each action reads AFTER the layout, and that there is something to reset', () => {
    const model = layoutModel(STANDARD_PROFILE, layout({ fire: 'bumper-right' }), null, '');
    expect(model.rows[0].controlName).toBe('RB / R1');
    expect(model.customised).toBe(true);
  });

  it('counts a stale stored binding as something to reset, though the reader refuses it', () => {
    const stale = layout({ fire: 'no-such-button' });
    const model = layoutModel(STANDARD_PROFILE, stale, null, '');
    expect(model.rows[0].controlName).toBe('RT / R2');
    expect(model.customised).toBe(true);
  });

  it('has no profile, rows or presets when no controller the game reads is connected', () => {
    const model = layoutModel(null, RECOMMENDED_LAYOUT, null, '');
    expect(model.profileName).toBeNull();
    expect(model.rows).toEqual([]);
    expect(model.presets).toEqual([]);
  });

  it('offers Recommended alone to a profile without two stick pairs', () => {
    const oneStick: ControlProfile = { ...STANDARD_PROFILE, axes: { moveX: 0, moveY: 1, aimX: 0, aimY: 1 } };
    expect(layoutModel(oneStick, layout({}, 'southpaw'), null, '').presets).toEqual(['recommended']);
    expect(layoutModel(oneStick, layout({}, 'southpaw'), null, '').preset).toBe('recommended');
  });
});

describe('rebind (issue #754)', () => {
  it('the negative control: a ONE-SIDED binding onto an occupied button does not take effect', () => {
    // What `rebind` exists to avoid. Fire onto B alone collides with Back, and the resolver
    // returns Fire to its own button rather than picking a winner.
    const oneSided = layout({ fire: 'face-right' });
    const resolved = resolveEffectiveProfile(STANDARD_PROFILE, oneSided);
    expect(resolved.profile.buttons.fire).toBe(STANDARD_PROFILE.buttons.fire);
    expect(resolved.refused).toEqual([{ action: 'fire', control: 'face-right', reason: 'collision' }]);
  });

  it('moves the displaced action onto the button being left, in the same layout', () => {
    const result = rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, 'fire', 'face-right');
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') return;
    expect(result.displaced).toBe('back');
    expect(result.layout.bindings).toEqual({ fire: 'face-right', back: 'trigger-right' });
    const buttons = buttonsOf(result.layout);
    expect(buttons.fire).toBe(1);
    expect(buttons.back).toBe(7);
    expect(resolveEffectiveProfile(STANDARD_PROFILE, result.layout).refused).toEqual([]);
  });

  it('binds onto a free button without moving anything', () => {
    const result = rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, 'mine', 'bumper-left');
    expect(result).toEqual({ kind: 'bound', layout: layout({ mine: 'bumper-left' }), displaced: null });
  });

  it('keeps the preset it was given', () => {
    const result = rebind(STANDARD_PROFILE, layout({}, 'southpaw'), 'mine', 'bumper-left');
    expect(result.kind === 'bound' && result.layout.preset).toBe('southpaw');
  });

  it('reports unchanged when the action already reads that control', () => {
    expect(rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, 'fire', 'trigger-right')).toEqual({ kind: 'unchanged' });
  });

  it('refuses a control the profile does not list', () => {
    expect(rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, 'fire', 'dpad-up')).toEqual({ kind: 'refused' });
  });

  it('drops a binding that names the action\'s own button, so moving away and back leaves nothing to reset', () => {
    const away = rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, 'fire', 'bumper-right');
    if (away.kind !== 'bound') throw new Error('expected a binding');
    const back = rebind(STANDARD_PROFILE, away.layout, 'fire', 'trigger-right');
    expect(back).toEqual({ kind: 'bound', layout: layout({}), displaced: null });
  });

  it('a swapped pair swapped back is empty too', () => {
    const swapped = rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, 'confirm', 'face-right');
    if (swapped.kind !== 'bound') throw new Error('expected a binding');
    expect(swapped.layout.bindings).toEqual({ confirm: 'face-right', back: 'face-bottom' });
    const restored = rebind(STANDARD_PROFILE, swapped.layout, 'confirm', 'face-bottom');
    expect(restored).toEqual({ kind: 'bound', layout: layout({}), displaced: 'back' });
  });

  it('drops a stale stored binding instead of letting it refuse every later rebind', () => {
    const result = rebind(STANDARD_PROFILE, layout({ pause: 'no-such-button' }), 'mine', 'bumper-left');
    expect(result).toEqual({ kind: 'bound', layout: layout({ mine: 'bumper-left' }), displaced: null });
  });

  it('refuses, rather than half-writes, a swap whose vacated button the profile does not list', () => {
    // Fire on a button that is not bindable here: nothing can be moved onto it.
    const odd: ControlProfile = { ...STANDARD_PROFILE, buttons: { ...STANDARD_PROFILE.buttons, fire: 16 } };
    expect(rebind(odd, RECOMMENDED_LAYOUT, 'fire', 'face-right')).toEqual({ kind: 'refused' });
  });

  it('every single rebind on the standard profile stores a layout the resolver takes whole', () => {
    // Swept: 5 actions x 12 controls = 60 rebinds from Recommended. Each either reports
    // unchanged (the 5 where the action is already there) or stores a layout with nothing
    // refused and the action on the chosen button.
    let bound = 0;
    let unchanged = 0;
    for (const action of ['fire', 'mine', 'confirm', 'back', 'pause'] as const) {
      for (const control of STANDARD_PROFILE.bindable ?? []) {
        const result = rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, action, control.id);
        if (result.kind === 'unchanged') {
          unchanged += 1;
          continue;
        }
        expect(result.kind, `${action} -> ${control.id}`).toBe('bound');
        if (result.kind !== 'bound') continue;
        bound += 1;
        expect(resolveEffectiveProfile(STANDARD_PROFILE, result.layout).refused).toEqual([]);
        expect(buttonsOf(result.layout)[action]).toBe(control.index);
      }
    }
    expect([bound, unchanged]).toEqual([55, 5]);
  });
});

describe('createBindingCapture (issue #754)', () => {
  it('ignores the button already held when capture starts, and takes it once pressed again', () => {
    const capture = createBindingCapture('fire', STANDARD_PROFILE);
    expect(capture.step(frame(standardPad([0])))).toEqual({ kind: 'waiting' });
    expect(capture.step(frame(standardPad([0])))).toEqual({ kind: 'waiting' });
    expect(capture.step(frame(standardPad([])))).toEqual({ kind: 'waiting' });
    expect(capture.step(frame(standardPad([0])))).toEqual({ kind: 'pressed', controlId: 'face-bottom' });
  });

  it('takes a new press of any bindable button, named by control id', () => {
    const capture = createBindingCapture('fire', STANDARD_PROFILE);
    capture.step(frame(standardPad()));
    expect(capture.step(frame(standardPad([1])))).toEqual({ kind: 'pressed', controlId: 'face-right' });
  });

  it('cancels on a new D-pad press, even with a button pressed on the same frame', () => {
    for (const direction of [12, 13, 14, 15]) {
      const capture = createBindingCapture('back', STANDARD_PROFILE);
      capture.step(frame(standardPad()));
      expect(capture.step(frame(standardPad([direction, 1]))), `D-pad ${direction}`).toEqual({ kind: 'cancel' });
    }
  });

  it('does not cancel on a D-pad direction already held when capture started', () => {
    const capture = createBindingCapture('fire', STANDARD_PROFILE);
    capture.step(frame(standardPad([13])));
    expect(capture.step(frame(standardPad([13, 4])))).toEqual({ kind: 'pressed', controlId: 'bumper-left' });
  });

  it('ignores Home and every pad the game does not read', () => {
    const capture = createBindingCapture('fire', STANDARD_PROFILE);
    capture.step(frame(unreadablePad(), standardPad()));
    expect(capture.step(frame(unreadablePad([1]), standardPad([16])))).toEqual({ kind: 'waiting' });
  });

  it('reads every connected pad of the profile, each by its own index', () => {
    const capture = createBindingCapture('fire', STANDARD_PROFILE);
    // Pad 0 holds A throughout; pad 1 pressing A is a new press on another pad.
    capture.step(frame(standardPad([0]), standardPad()));
    expect(capture.step(frame(standardPad([0]), standardPad([0])))).toEqual({ kind: 'pressed', controlId: 'face-bottom' });
  });
});

describe('activeLayoutProfile (issue #754)', () => {
  it('is the first connected pad the game reads, skipping one it refuses', () => {
    expect(activeLayoutProfile(frame(unreadablePad(), standardPad()))).toBe(STANDARD_PROFILE);
    expect(activeLayoutProfile(frame(unreadablePad()))).toBeNull();
    expect(activeLayoutProfile([])).toBeNull();
  });
});

describe('captureResultStatus (issue #754)', () => {
  it('says what moved, by name', () => {
    const result = rebind(STANDARD_PROFILE, RECOMMENDED_LAYOUT, 'fire', 'face-right');
    expect(captureResultStatus(STANDARD_PROFILE, 'fire', 'face-right', result)).toBe(
      'Fire is now B / Circle. Back moved to RT / R2.',
    );
    expect(captureResultStatus(STANDARD_PROFILE, 'fire', 'trigger-right', { kind: 'unchanged' })).toBe(
      'Fire is already on RT / R2.',
    );
  });
});

describe('renderControllerLayout (issue #754)', () => {
  function mount(): { container: HTMLElement; view: ReturnType<typeof renderControllerLayout>; requests: LayoutRequest[] } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = renderControllerLayout(container);
    const requests: LayoutRequest[] = [];
    view.onRequest((r) => requests.push(r));
    return { container, view, requests };
  }
  const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T => root.querySelector<T>(sel) as T;
  const standardModel = (over: Partial<ControllerLayoutModel> = {}): ControllerLayoutModel => ({
    ...layoutModel(STANDARD_PROFILE, RECOMMENDED_LAYOUT, null, ''),
    ...over,
  });

  it('explains, and offers nothing, with no controller', () => {
    const { container } = mount();
    expect(q(container, '.hud-layout-empty').hidden).toBe(false);
    expect(q(container, '.hud-layout-empty').textContent).toBe(NO_CONTROLLER_TEXT);
    expect(q(container, '.hud-layout-controls').hidden).toBe(true);
  });

  it('draws the rows by name and asks to capture the row pressed', () => {
    const { container, view, requests } = mount();
    view.update(standardModel());
    expect(q(container, '.hud-layout-empty').hidden).toBe(true);
    expect(q(container, '.hud-layout-controls').hidden).toBe(false);
    expect(q(container, '.hud-layout-profile').textContent).toBe('Standard controller');
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.hud-layout-bind')];
    expect(rows.map((b) => b.textContent)).toEqual([
      'Fire: RT / R2',
      'Mine: LT / L2',
      'Confirm: A / Cross',
      'Back: B / Circle',
      'Pause: Menu / Options',
    ]);
    rows[3].click();
    expect(requests).toEqual([{ kind: 'capture', action: 'back' }]);
  });

  it('while waiting: marks the row, shows Cancel, and a second press of that row cancels', () => {
    const { container, view, requests } = mount();
    view.update(standardModel({ capturing: 'fire', status: 'Press the button for Fire.' }));
    const fire = q<HTMLButtonElement>(container, '.hud-layout-bind[data-action="fire"]');
    expect(fire.textContent).toBe('Fire: press a button…');
    expect(fire.getAttribute('aria-pressed')).toBe('true');
    expect(q(container, '.hud-layout-cancel').hidden).toBe(false);
    expect(q(container, '.hud-layout-status').textContent).toBe('Press the button for Fire.');
    fire.click();
    q<HTMLButtonElement>(container, '.hud-layout-bind[data-action="mine"]').click();
    q<HTMLButtonElement>(container, '.hud-layout-cancel').click();
    expect(requests).toEqual([{ kind: 'cancel' }, { kind: 'capture', action: 'mine' }, { kind: 'cancel' }]);
  });

  it('hides Cancel when nothing is waiting', () => {
    const { container, view } = mount();
    view.update(standardModel());
    expect(q(container, '.hud-layout-cancel').hidden).toBe(true);
  });

  it('cycles the preset, and enables Reset only when something is stored', () => {
    const { container, view, requests } = mount();
    view.update(standardModel());
    const preset = q<HTMLButtonElement>(container, '.hud-layout-preset');
    const reset = q<HTMLButtonElement>(container, '.hud-layout-reset');
    expect(preset.textContent).toBe('Sticks: Recommended');
    expect(reset.disabled).toBe(true);
    preset.click();
    view.update(standardModel({ preset: 'southpaw', customised: true }));
    expect(preset.textContent).toBe('Sticks: Southpaw');
    expect(reset.disabled).toBe(false);
    preset.click();
    reset.click();
    expect(requests).toEqual([
      { kind: 'preset', preset: 'southpaw' },
      { kind: 'preset', preset: 'recommended' },
      { kind: 'reset' },
    ]);
  });

  it('hides the preset control for a profile offering one preset', () => {
    const { container, view } = mount();
    view.update(standardModel({ presets: ['recommended'] }));
    expect(q(container, '.hud-layout-preset').hidden).toBe(true);
  });

  it('keeps the same row nodes across updates, so focus stays on the row pressed', () => {
    const { container, view } = mount();
    view.update(standardModel());
    const fire = q<HTMLButtonElement>(container, '.hud-layout-bind[data-action="fire"]');
    fire.focus();
    view.update(standardModel({ capturing: 'fire' }));
    view.update(standardModel());
    expect(q(container, '.hud-layout-bind[data-action="fire"]')).toBe(fire);
    expect(document.activeElement).toBe(fire);
  });

  it('dispose removes the listeners', () => {
    const { container, view, requests } = mount();
    view.update(standardModel());
    view.dispose();
    q<HTMLButtonElement>(container, '.hud-layout-bind').click();
    q<HTMLButtonElement>(container, '.hud-layout-reset').click();
    expect(requests).toEqual([]);
  });
});

/**
 * A catalogue profile, every index off the standard ones (issue #754). The shipped catalogue
 * is empty (#606 owns its first entry), so the pane's half of the mechanism is proved on a
 * fixture here, as `gamepad-profile.test.ts` proves the resolver's half.
 */
const CATALOGUE_PROFILE: ControlProfile = {
  id: 'fixture-six-axis',
  label: 'Test fixture: a six-axis pad',
  axes: { moveX: 0, moveY: 1, aimX: 4, aimY: 5 },
  buttons: { fire: 6, mine: 7, confirm: 0, back: 1, pause: 8, up: 2, down: 3, left: 4, right: 5 },
  bindable: [
    { id: 'a', index: 0 },
    { id: 'b', index: 1 },
    { id: 'l', index: 6 },
    { id: 'r', index: 7 },
    { id: 'start', index: 8 },
    { id: 'z', index: 9 },
  ],
};

describe('a catalogue profile goes through the same pane (issue #754)', () => {
  it('is modelled from its own buttons and names, with both presets', () => {
    const model = layoutModel(CATALOGUE_PROFILE, layout({ fire: 'z' }), null, '');
    expect(model.profileName).toBe('Controller');
    expect(model.presets).toEqual(['recommended', 'southpaw']);
    expect(model.rows.map((row) => row.controlName)).toEqual(['Z', 'R', 'A', 'B', 'Start']);
    expect(model.customised).toBe(true);
  });

  it('rebinds by swapping with the action on that button, both halves in one layout', () => {
    const r = rebind(CATALOGUE_PROFILE, RECOMMENDED_LAYOUT, 'fire', 'a');
    expect(r).toEqual({
      kind: 'bound',
      layout: { preset: 'recommended', bindings: { fire: 'a', confirm: 'l' } },
      displaced: 'confirm',
    });
    if (r.kind !== 'bound') throw new Error('unreachable');
    const buttons = resolveEffectiveProfile(CATALOGUE_PROFILE, r.layout).profile.buttons;
    expect([buttons.fire, buttons.confirm]).toEqual([0, 6]);
  });

  it('capture ignores a pad of another profile, even a press on an index it could bind', () => {
    // A standard pad's A is index 0, which this profile's list names too. The press must not
    // count: it would be named against the wrong list, on a pad the pane is not configuring.
    const capture = createBindingCapture('fire', CATALOGUE_PROFILE);
    expect(capture.step(frame(standardPad()))).toEqual({ kind: 'waiting' });
    expect(capture.step(frame(standardPad([0])))).toEqual({ kind: 'waiting' });
    expect(capture.step(frame(standardPad([9])))).toEqual({ kind: 'waiting' });
  });
});
