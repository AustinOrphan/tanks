// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { describeDisabledReason, setSelected } from './ui';

afterEach(() => {
  document.body.innerHTML = '';
});

function button(): HTMLButtonElement {
  const b = document.createElement('button');
  document.body.appendChild(b);
  return b;
}

describe('setSelected: the visual and the announced selection move together', () => {
  it('marks a control in BOTH channels, not just the one you can see', () => {
    const b = button();
    setSelected(b, true);
    // The ring hud.css draws...
    expect(b.classList.contains('ui-selectable--on')).toBe(true);
    // ...and the state a screen reader is told, which the five choice rows carried in
    // no form at all before this helper existed.
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });

  it('clears both when the choice moves elsewhere', () => {
    const b = button();
    setSelected(b, true);
    setSelected(b, false);
    expect(b.classList.contains('ui-selectable--on')).toBe(false);
    expect(b.getAttribute('aria-pressed')).toBe('false');
  });

  it('KEEPS aria-pressed on the unselected control rather than removing it', () => {
    // Removing it would be the tidier-looking edit and it is wrong: a button with no
    // aria-pressed announces as a plain button, so every unselected option in the row
    // would stop announcing that it is a choice at all. `false` is a state; absent is
    // a different KIND of control.
    const b = button();
    setSelected(b, false);
    expect(b.hasAttribute('aria-pressed')).toBe(true);
    expect(b.getAttribute('aria-pressed')).toBe('false');
  });

  it('touches nothing else on the element', () => {
    const b = button();
    b.className = 'ui-btn ui-selectable hud-skin';
    setSelected(b, true);
    setSelected(b, false);
    expect(b.className.split(' ').sort()).toEqual(['hud-skin', 'ui-btn', 'ui-selectable']);
  });
});

describe('describeDisabledReason: the reason is associated, not merely nearby', () => {
  it('points the control at the element that explains it', () => {
    const b = button();
    describeDisabledReason(b, 'hud-levels-note');
    expect(b.getAttribute('aria-describedby')).toBe('hud-levels-note');
  });

  it('REMOVES the reference rather than emptying it, so nothing points at nothing', () => {
    // `aria-describedby=""` is still a described-by relationship, one that resolves to
    // no element. Absence is what "this control needs no explanation" is spelled as.
    const b = button();
    describeDisabledReason(b, 'hud-levels-note');
    describeDisabledReason(b, null);
    expect(b.hasAttribute('aria-describedby')).toBe(false);
  });

  it('never leaves a stale reason on a control that has since been enabled', () => {
    const b = button();
    describeDisabledReason(b, 'reason-a');
    describeDisabledReason(b, 'reason-b');
    expect(b.getAttribute('aria-describedby')).toBe('reason-b');
    describeDisabledReason(b, null);
    expect(b.hasAttribute('aria-describedby')).toBe(false);
  });
});
