// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { createHud } from './hud';
import { equalizeMenuRows, equalizeRowWidths, MENU_COL_VAR } from './menu-row-width';

/**
 * Issue #706. jsdom lays nothing out, so each button here reports a width the test controls:
 * its label's natural width, or -- once the row carries `--hud-menu-col` -- the width that
 * variable gives it, which is what a real button does. 0 stands for a hidden button.
 * The real rendering is measured in Chromium on the built bundle; see the PR.
 */
function rowOf(widths: number[]): HTMLElement {
  const row = document.createElement('div');
  widths.forEach((_, i) => {
    const button = document.createElement('button');
    button.getBoundingClientRect = () => {
      const given = row.style.getPropertyValue(MENU_COL_VAR);
      const width = widths[i] === 0 ? 0 : given ? parseFloat(given) : widths[i];
      return { width, height: 44, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 44, toJSON: () => ({}) } as DOMRect;
    };
    row.appendChild(button);
  });
  return row;
}

/** A ResizeObserver the test drives by hand. */
class FakeObserver {
  static last: FakeObserver | null = null;
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeObserver.last = this;
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

const realObserver = globalThis.ResizeObserver;
afterEach(() => {
  globalThis.ResizeObserver = realObserver;
  FakeObserver.last = null;
  document.body.innerHTML = '';
});

describe('menu-row-width.ts: one width per Main Menu row (issue #706)', () => {
  it('gives every button the widest sibling width, rounded up', () => {
    // The shipped play row: Versus 89.2 and Practice 98.4. Negative control: keeping the
    // narrowest gives 90px, and rounding down gives 98px, which would clip Practice.
    const row = rowOf([89.2, 98.4]);
    equalizeRowWidths(row);
    expect(row.style.getPropertyValue(MENU_COL_VAR)).toBe('99px');
  });

  it('measures the labels, not the width it gave them last time', () => {
    // The utilities row in developer mode, then at Pause where only Settings is visible.
    // Negative control: without clearing the variable before measuring, Settings reports the
    // 143px it was just given and keeps the Developer Tools width.
    const widths = [115.8, 100, 99.2, 142.7];
    const row = rowOf(widths);
    equalizeRowWidths(row);
    expect(row.style.getPropertyValue(MENU_COL_VAR)).toBe('143px');
    widths[0] = 0;
    widths[1] = 0;
    widths[3] = 0;
    equalizeRowWidths(row);
    expect(row.style.getPropertyValue(MENU_COL_VAR)).toBe('100px');
  });

  it('clears the width when nothing in the row is visible', () => {
    // Negative control: without the clear, a hidden row keeps its last width for whichever
    // buttons it shows next, before the observer has measured them.
    const widths = [89.2, 98.4];
    const row = rowOf(widths);
    equalizeRowWidths(row);
    widths[0] = 0;
    widths[1] = 0;
    equalizeRowWidths(row);
    expect(row.style.getPropertyValue(MENU_COL_VAR)).toBe('');
  });

  it('observes every button in every row, re-equalizes on a size change, and stops when disposed', () => {
    const playWidths = [89.2, 98.4];
    const play = rowOf(playWidths);
    const utilities = rowOf([115.8, 100, 99.2]);
    const handle = equalizeMenuRows([play, utilities], FakeObserver);
    const observer = FakeObserver.last!;
    expect(observer.observed).toEqual([...Array.from(play.children), ...Array.from(utilities.children)]);
    expect(utilities.style.getPropertyValue(MENU_COL_VAR)).toBe('116px');

    // Practice hides: the observer fires and the row is measured again.
    playWidths[1] = 0;
    observer.callback();
    expect(play.style.getPropertyValue(MENU_COL_VAR)).toBe('90px');

    handle.dispose();
    expect(observer.disconnected).toBe(true);
  });

  it('is wired into the HUD for the play and utilities rows, and disposed with it', () => {
    // Negative control: a HUD that never calls equalizeMenuRows observes nothing.
    globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = createHud(root);
    const observer = FakeObserver.last;
    expect(observer, 'the HUD constructed no ResizeObserver').not.toBeNull();
    const observedClasses = observer!.observed.map((el) => el.className);
    for (const cls of ['hud-versus-open', 'hud-levelselect-open', 'hud-customize-open', 'hud-records-open', 'hud-settings-open', 'hud-devtools-open']) {
      expect(observedClasses.some((c) => c.split(' ').includes(cls)), cls).toBe(true);
    }
    hud.dispose();
    expect(observer!.disconnected).toBe(true);
  });
});
