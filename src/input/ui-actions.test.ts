// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  UI_ACTIONS,
  actionDirection,
  keyToUiAction,
  isTextEntry,
  consumesKey,
  type UiAction,
} from './ui-actions';

describe('UI_ACTIONS', () => {
  it('is the complete seven-action vocabulary, in the order a single poll emits them', () => {
    // gamepad-menu.ts walks this array to order a multi-action frame, so the ORDER is a
    // contract, not a convenience: pinned as a literal rather than derived.
    expect(UI_ACTIONS).toEqual(['up', 'down', 'left', 'right', 'confirm', 'back', 'pause']);
  });
});

describe('actionDirection', () => {
  it('collapses the two axes onto one sign for every one of the seven actions', () => {
    // A table over UI_ACTIONS rather than seven `it`s: the point is that the map is
    // total (no action falls through to a wrong sign) and that up/left share -1 while
    // down/right share +1. Swapping any sign, or returning a number for a one-shot,
    // breaks the equality.
    const table = Object.fromEntries(UI_ACTIONS.map((a) => [a, actionDirection(a)]));
    expect(table).toEqual({
      up: -1,
      left: -1,
      down: 1,
      right: 1,
      confirm: null,
      back: null,
      pause: null,
    });
  });
});

describe('keyToUiAction', () => {
  const mapped: [string, UiAction][] = [
    ['ArrowUp', 'up'],
    ['w', 'up'],
    ['ArrowDown', 'down'],
    ['s', 'down'],
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
    ['Enter', 'confirm'],
    [' ', 'confirm'],
    ['Spacebar', 'confirm'],
    ['Escape', 'back'],
    ['p', 'pause'],
  ];

  it.each(mapped)('maps %j to %s', (key, action) => {
    expect(keyToUiAction(key)).toBe(action);
  });

  it('is case-insensitive: the upper-case spelling of every mapped key lands on the same action', () => {
    // Shift+W and Caps Lock both deliver 'W'. The lower-case table above is the
    // negative control: if the upper-case path were not folded, these would be null.
    for (const [key, action] of mapped) {
      expect(keyToUiAction(key.toUpperCase())).toBe(action);
    }
  });

  it('leaves A/D (the tank\'s strafe keys), M, Tab and every other key unmapped', () => {
    // A/D are absent on purpose -- with nothing open they drive the tank, and a menu
    // that claimed them would need the container check the arrows already provide. M
    // is the mute hotkey and must always reach the game (see consumesKey).
    for (const key of ['a', 'd', 'A', 'D', 'm', 'M', 'Tab', 'Home', 'End', 'q', 'Shift', '']) {
      expect(keyToUiAction(key)).toBeNull();
    }
  });
});

/** A fresh element of the given tag with optional attributes, created in this jsdom window. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

describe('isTextEntry', () => {
  it('is true for every text-like input type, and for an input with no type at all (which is text)', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time']) {
      expect(isTextEntry(el('input', { type }))).toBe(true);
    }
    expect(isTextEntry(el('input'))).toBe(true);
  });

  it('is true for a textarea and for a contenteditable, and for an element nested inside either', () => {
    expect(isTextEntry(el('textarea'))).toBe(true);
    const editable = el('div', { contenteditable: '' });
    expect(isTextEntry(editable)).toBe(true);
    const inner = el('span');
    editable.appendChild(inner);
    expect(isTextEntry(inner)).toBe(true); // resolves through closest(), not the target alone
  });

  it('is false for a range, checkbox or button-typed input, a button, a select, and a plain div', () => {
    // The negative controls for the block above: these are widgets or nothing, and a
    // 'w' typed at them is a throttle, never a character.
    expect(isTextEntry(el('input', { type: 'range' }))).toBe(false);
    expect(isTextEntry(el('input', { type: 'checkbox' }))).toBe(false);
    expect(isTextEntry(el('input', { type: 'button' }))).toBe(false);
    expect(isTextEntry(el('button'))).toBe(false);
    expect(isTextEntry(el('select'))).toBe(false);
    expect(isTextEntry(el('div'))).toBe(false);
  });
});

describe('consumesKey', () => {
  it('a text input takes every key -- a typed w is a w and Escape is the field\'s own', () => {
    const input = el('input', { type: 'text' });
    for (const key of ['w', 'a', 'Escape', 'escape', 'p', 'm', 'Enter', ' ']) {
      expect(consumesKey(input, key)).toBe(true);
    }
  });

  it('a range input (the volume slider) keeps only the keys that operate it', () => {
    // The shipped bug this rule replaced: the slider stayed focused after a drag and
    // every keystroke was discarded. Arrows and Home/End/Space adjust or activate it
    // and stay with it; Escape, M and P (and WASD) never touch a slider and must reach
    // the game.
    const slider = el('input', { type: 'range' });
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']) {
      expect(consumesKey(slider, key)).toBe(true);
    }
    for (const key of ['Escape', 'm', 'p', 'w', 'a', 's', 'd']) {
      expect(consumesKey(slider, key)).toBe(false);
    }
  });

  it('a button keeps Enter and Space (activation) but not Escape, the arrows or the driving keys', () => {
    // The arrows are the roving focus's: a button that kept them would freeze keyboard
    // navigation on the first focused menu button (hud.test.ts's walk tests spin on
    // exactly that). The range-input case above is the negative control -- the same
    // keys, a control that DOES adjust on them.
    const button = el('button');
    expect(consumesKey(button, 'Enter')).toBe(true);
    expect(consumesKey(button, ' ')).toBe(true);
    expect(consumesKey(button, 'Spacebar')).toBe(true);
    expect(consumesKey(button, 'Escape')).toBe(false);
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(consumesKey(button, key), key).toBe(false);
    }
    expect(consumesKey(button, 'w')).toBe(false);
    expect(consumesKey(button, 'p')).toBe(false);
  });

  it('a select keeps the arrows that walk its options but not P', () => {
    const select = el('select');
    expect(consumesKey(select, 'ArrowDown')).toBe(true);
    expect(consumesKey(select, 'ArrowUp')).toBe(true);
    expect(consumesKey(select, 'p')).toBe(false);
    expect(consumesKey(select, 'Escape')).toBe(false);
  });

  it('a contenteditable takes everything, exactly like a text input', () => {
    const editable = el('div', { contenteditable: 'true' });
    for (const key of ['w', 'Escape', 'p', 'm', 'Enter', ' ', 'Tab']) {
      expect(consumesKey(editable, key)).toBe(true);
    }
  });

  it('the widget key set is case-insensitive', () => {
    const button = el('button');
    expect(consumesKey(button, 'ENTER')).toBe(true);
    expect(consumesKey(button, 'enter')).toBe(true);
    expect(consumesKey(button, 'ESCAPE')).toBe(false); // still not a widget key in any case
  });

  it('a non-element target consumes nothing: null, the window, the document', () => {
    // Keydown is bound at the window, so a keystroke with nothing focused targets the
    // body or the window itself. Even Enter and Space -- the most widget-like keys --
    // go to the game then.
    for (const target of [null, window, document]) {
      expect(consumesKey(target, 'Enter')).toBe(false);
      expect(consumesKey(target, ' ')).toBe(false);
      expect(consumesKey(target, 'ArrowUp')).toBe(false);
    }
  });

  it('a plain div is not a widget: it consumes nothing, even Enter', () => {
    // Negative control for the widget branch -- isWidget must be the gate, not
    // "any HTMLElement".
    const div = el('div');
    expect(consumesKey(div, 'Enter')).toBe(false);
    expect(consumesKey(div, ' ')).toBe(false);
    expect(consumesKey(div, 'w')).toBe(false);
  });

  it('a span nested inside a button resolves through closest(): it keeps the button\'s keys and no more', () => {
    // A button with an icon or label span: the keydown targets the span (the focused
    // element is the button, but a test target or a synthetic event can name the child),
    // and the rule must see the button around it.
    const button = el('button');
    const span = el('span');
    button.appendChild(span);
    expect(consumesKey(span, 'Enter')).toBe(true);
    expect(consumesKey(span, ' ')).toBe(true);
    expect(consumesKey(span, 'Escape')).toBe(false);
    expect(consumesKey(span, 'w')).toBe(false);
    // And the same span OUTSIDE any widget consumes nothing: the ancestor is what matters.
    const loose = el('span');
    expect(consumesKey(loose, 'Enter')).toBe(false);
  });
});
