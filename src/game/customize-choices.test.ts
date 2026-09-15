// @vitest-environment jsdom
//
// Customize's three choice rows (issue #556), driven directly. What `hud.ts` hands the module is
// three empty containers, so that is the whole fixture. The pane around them -- opening, closing,
// focus, the live preview -- is `hud.controls.test.ts`'s, through `createHud`.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderCustomizeChoices,
  type CustomizeChoices,
  type CustomizeRows,
} from './customize-choices';
import { ACCENTS, PALETTE, SKINS } from '../presentation/customization';

let rows: CustomizeRows;
let choices: CustomizeChoices;

beforeEach(() => {
  document.body.innerHTML = '';
  const row = (): HTMLElement => document.body.appendChild(document.createElement('div'));
  rows = { hull: row(), skin: row(), accent: row() };
  choices = renderCustomizeChoices(rows);
});

type RowKey = keyof CustomizeRows;
const buttons = (key: RowKey): HTMLButtonElement[] =>
  Array.from(rows[key].children) as HTMLButtonElement[];
const marked = (key: RowKey): string[] =>
  buttons(key)
    .filter((b) => b.classList.contains('ui-selectable--on'))
    .map((b) => b.dataset[key] as string);
/** `style.background` as jsdom normalises it, so two spellings of one colour compare equal. */
const normalised = (hex: string): string => {
  const probe = document.createElement('span');
  probe.style.background = hex;
  return probe.style.background;
};

describe('renderCustomizeChoices (issue #556)', () => {
  it('builds one button per catalogue entry, in catalogue order, each named for its row', () => {
    expect(buttons('hull').map((b) => b.dataset.hull)).toEqual(PALETTE.map((s) => s.id));
    expect(buttons('hull').map((b) => b.getAttribute('aria-label'))).toEqual(
      PALETTE.map((s) => `Hull: ${s.label}`),
    );
    expect(buttons('skin').map((b) => b.dataset.skin)).toEqual(SKINS.map((s) => s.id));
    expect(buttons('skin').map((b) => b.textContent)).toEqual(SKINS.map((s) => s.label));
    expect(buttons('accent').map((b) => b.dataset.accent)).toEqual(ACCENTS.map((a) => a.id));
    expect(buttons('accent').map((b) => b.getAttribute('aria-label'))).toEqual(
      ACCENTS.map((a) => `Accent: ${a.label}`),
    );
  });

  it('gives `auto` a neutral fill of its own, not any hull or accent colour', () => {
    const auto = buttons('accent').find((b) => b.dataset.accent === 'auto')!;
    const taken = [...PALETTE.map((s) => s.hex), ...ACCENTS.flatMap((a) => (a.hex ? [a.hex] : []))];
    expect(auto.style.background).not.toBe('');
    expect(taken.map(normalised)).not.toContain(auto.style.background);
  });

  it('renderSelection marks the first entry of EVERY row when nothing has been stored', () => {
    choices.renderSelection();
    expect(marked('hull')).toEqual([PALETTE[0].id]);
    expect(marked('skin')).toEqual([SKINS[0].id]);
    expect(marked('accent')).toEqual([ACCENTS[0].id]);
  });

  it.each([
    ['hull', () => choices.setHullColor('purple'), 'purple'],
    ['skin', () => choices.setSkin('checker'), 'checker'],
    ['accent', () => choices.setAccentColor('gold'), 'gold'],
  ] as const)('storing a %s choice moves that row\'s ring at once', (key, store, id) => {
    store();
    expect(marked(key)).toEqual([id]);
  });

  it.each([
    ['hull', (cb: (id: string) => void) => choices.onPickHullColor(cb), 'purple'],
    ['skin', (cb: (id: string) => void) => choices.onPickSkin(cb), 'checker'],
    ['accent', (cb: (id: string) => void) => choices.onPickAccentColor(cb), 'gold'],
  ] as const)('a pick in the %s row reaches every subscriber with its own id, in order', (key, subscribe, id) => {
    const heard: string[] = [];
    subscribe((picked) => heard.push(`first:${picked}`));
    subscribe((picked) => heard.push(`second:${picked}`));
    buttons(key)
      .find((b) => b.dataset[key] === id)!
      .dispatchEvent(new MouseEvent('click', { detail: 1 }));
    expect(heard).toEqual([`first:${id}`, `second:${id}`]);
  });

  it.each(['hull', 'skin', 'accent'] as const)(
    'a button in the %s row keeps focus when the keyboard presses it, and lets go after a pointer click',
    (key) => {
      const b = buttons(key)[1];
      b.focus();
      // Enter or Space activates a button with a click whose `detail` is 0.
      b.dispatchEvent(new MouseEvent('click', { detail: 0 }));
      expect(document.activeElement).toBe(b);
      b.dispatchEvent(new MouseEvent('click', { detail: 1 }));
      expect(document.activeElement).not.toBe(b);
    },
  );
});
