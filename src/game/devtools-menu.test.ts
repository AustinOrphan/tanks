// @vitest-environment jsdom
//
// The Developer Tools configuration menu's DOM (issue #246) -- the half
// `dev-config-menu.test.ts` does not cover: what the view model becomes on screen, and what
// it must never become (a text field).
import { describe, it, expect, beforeEach } from 'vitest';
import { renderDevConfigMenu, LITERALS, type DevConfigMenuHandlers } from './devtools-menu';
import { devMenuView } from './dev-config-menu';
import { devControls, explainDevConfig, devSearchFrom, DEV_PRESETS } from './dev-config';

let container: HTMLElement;
let calls: string[];
let handlers: DevConfigMenuHandlers;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  calls = [];
  handlers = {
    onSet: (f, v) => calls.push(`set:${f}=${v}`),
    onToggle: (f) => calls.push(`toggle:${f}`),
    onStep: (f, s) => calls.push(`step:${f}${s > 0 ? '+' : '-'}`),
    onPreset: (id) => calls.push(`preset:${id}`),
    onApply: () => calls.push('apply'),
    onReset: () => calls.push('reset'),
    onCopy: () => calls.push('copy'),
  };
});

const mount = (selection = {}, base = '') =>
  renderDevConfigMenu(container, handlers, devMenuView(selection, base));
const rowFor = (field: string) =>
  container.querySelector<HTMLElement>(`.hud-devcfg-control[data-field="${field}"]`) as HTMLElement;
/**
 * The CLASS, not the resolved display: this file imports the renderer alone, and `hud.css`
 * reaches the document through `hud.ts`'s own import. That the modifier actually hides is
 * `hud.css.test.ts`'s sweep over every `--hidden` in the stylesheet, which is the one place
 * that question belongs.
 */
const hidden = (el: HTMLElement, cls: string) => el.classList.contains(cls);

describe('the menu renders the registry, once each', () => {
  it('gives every registered control exactly one row, inside a group section', () => {
    // Acceptance criterion 1, swept from the registry rather than a fixture list.
    mount();
    const rows = Array.from(container.querySelectorAll('.hud-devcfg-control'));
    const fields = rows.map((r) => (r as HTMLElement).dataset.field);
    const expected = devControls().map((c) => c.field);
    expect(fields.length).toBe(expected.length);
    expect([...fields].sort()).toEqual([...expected].sort());
    expect(fields.length, 'the registry sweep found nothing').toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.closest('.hud-devcfg-group'), `${(r as HTMLElement).dataset.field} has no group`)
        .not.toBeNull();
    }
  });

  it('uses NO text entry anywhere, which is what makes it operable by controller', () => {
    // Acceptance criterion 2, and the issue's explicit instruction: button-driven controls
    // and steppers rather than a general-purpose text-entry primitive. This is the assertion
    // that fails the moment someone reaches for an `<input>`.
    mount();
    expect(container.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
    // ...and every valued control still has a way to move: a stepper pair.
    for (const c of devControls().filter((x) => x.control === 'input')) {
      const row = rowFor(c.field);
      expect(row.querySelectorAll('.hud-devcfg-step'), `${c.field} has no stepper`).toHaveLength(2);
    }
  });

  it('offers Unset on every control that can hold a value, so nothing is one-way', () => {
    mount();
    for (const c of devControls().filter((x) => x.control !== 'toggle')) {
      const labels = Array.from(rowFor(c.field).querySelectorAll('button')).map((b) => b.textContent);
      expect(labels, `${c.field} cannot be cleared`).toContain('Unset');
    }
  });

  it('gives a select one button per value, with the ring on the chosen one', () => {
    mount({ quality: 'low' });
    const row = rowFor('quality');
    const values = devControls().find((c) => c.field === 'quality')?.values ?? [];
    const buttons = Array.from(row.querySelectorAll('button'));
    expect(buttons).toHaveLength(values.length + 1); // + Unset
    const selected = buttons.filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(selected.map((b) => b.textContent)).toEqual(['low']);
  });

  it('rings Unset when nothing is chosen, rather than ringing nothing at all', () => {
    mount();
    const selected = Array.from(rowFor('quality').querySelectorAll('button'))
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent);
    expect(selected).toEqual(['Unset']);
  });

  it('shows a toggle as On or Off, and says so to a screen reader too', () => {
    const v = mount({ aimRay: true });
    const btn = rowFor('aimRay').querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toBe('On');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    v.update(devMenuView({}));
    expect(btn.textContent).toBe('Off');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('offers the literals a parser takes beside a number, and only where it takes them', () => {
    mount();
    expect(
      Array.from(rowFor('level').querySelectorAll('button')).map((b) => b.textContent),
    ).toContain('sandbox');
    // ...and not on a flag that has none.
    expect(
      Array.from(rowFor('players').querySelectorAll('button')).map((b) => b.textContent),
    ).not.toContain('sandbox');
  });

  it('every literal it offers is one the parser actually accepts', () => {
    // The renderer names these by hand because the registry states them only inside a prose
    // `type` string. This is what stops one going stale: the PARSER is still the authority,
    // so a literal that stopped being valid fails here rather than sitting in the menu doing
    // nothing.
    const fields = Object.keys(LITERALS);
    expect(fields.length, 'no literals to check').toBeGreaterThan(0);
    for (const field of fields) {
      for (const literal of LITERALS[field]) {
        const state = explainDevConfig(devSearchFrom({ [field]: literal }));
        expect(
          state.notes.filter((n) => n.field === field && n.reason === 'rejected'),
          `${field}=${literal} is offered but refused`,
        ).toEqual([]);
      }
    }
  });
});

describe('what the menu says before it acts', () => {
  it('names the persistence namespace, because that outlives the reload', () => {
    // Acceptance criterion 6. Invisible in the flags themselves: `selectStorageNamespace`
    // keys off the gate, so a developer page cannot see a production save.
    mount();
    const line = container.querySelector('.hud-devcfg-namespace') as HTMLElement;
    expect(line.textContent).toContain('developer');
    expect(line.textContent).toMatch(/cannot see a production/);
  });

  it('previews the URL it would apply', () => {
    const v = mount({ quality: 'low' });
    expect((container.querySelector('.hud-devcfg-url') as HTMLElement).textContent).toBe(v.search());
    expect(v.search()).toBe(devMenuView({ quality: 'low' }).search);
  });

  it('reports unknown parameters, and hides the line when there are none', () => {
    const v = mount();
    const line = container.querySelector('.hud-devcfg-unknown') as HTMLElement;
    const HID = 'hud-devcfg-unknown--hidden';
    expect(hidden(line, HID)).toBe(true);
    v.update(devMenuView({}, '?nosuchflag=1'));
    expect(hidden(line, HID)).toBe(false);
    expect(line.textContent).toContain('nosuchflag');
    v.update(devMenuView({}));
    expect(hidden(line, HID), 'the line must go away again').toBe(true);
  });

  it('writes each note beside the control it is about, in the model’s own words', () => {
    // Acceptance criterion 7. `detail` is written for exactly this, so the menu does not get
    // to paraphrase the model into a second vocabulary.
    const view = devMenuView({ players: '9' });
    const v = mount();
    v.update(view);
    const notes = Array.from(rowFor('players').querySelectorAll('.hud-devcfg-note'));
    expect(notes.length).toBeGreaterThan(0);
    const model = view.groups.flatMap((g) => g.controls).find((c) => c.control.field === 'players');
    expect(notes.map((n) => n.textContent)).toEqual(model?.notes.map((n) => n.detail));
    expect(notes[0].className).toContain('hud-devcfg-note--rejected');
  });
});

describe('structure is built once', () => {
  it('keeps the same nodes across an update, so a press cannot lose the focused control', () => {
    // Every press changes the selection and pushes a new view. A render that rebuilt would
    // throw away the button under the player's finger on every one of them.
    const v = mount();
    const before = Array.from(container.querySelectorAll('.hud-devcfg-control'));
    v.update(devMenuView({ aimRay: true, quality: 'high' }));
    const after = Array.from(container.querySelectorAll('.hud-devcfg-control'));
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
  });
});

describe('the buttons report, and do not act themselves', () => {
  it('reports a value, a toggle, a step, a preset and each action', () => {
    mount();
    (rowFor('quality').querySelectorAll('button')[1] as HTMLButtonElement).click();
    (rowFor('aimRay').querySelector('button') as HTMLButtonElement).click();
    (rowFor('players').querySelector('.hud-devcfg-step') as HTMLButtonElement).click();
    (container.querySelector('[data-preset="playtest"]') as HTMLButtonElement).click();
    (container.querySelector('.hud-devcfg-apply') as HTMLButtonElement).click();
    (container.querySelector('.hud-devcfg-reset') as HTMLButtonElement).click();
    (container.querySelector('.hud-devcfg-copy') as HTMLButtonElement).click();
    expect(calls).toEqual([
      'set:quality=low',
      'toggle:aimRay',
      'step:players-',
      'preset:playtest',
      'apply',
      'reset',
      'copy',
    ]);
  });

  it('offers all six presets, each naming what it does', () => {
    mount();
    const buttons = Array.from(container.querySelectorAll('.hud-devcfg-preset'));
    expect(buttons).toHaveLength(6);
    expect(buttons.map((b) => (b as HTMLElement).dataset.preset)).toEqual(
      DEV_PRESETS.map((p) => p.id),
    );
    for (const b of buttons) expect(b.getAttribute('aria-label')).toContain('.');
  });
});
