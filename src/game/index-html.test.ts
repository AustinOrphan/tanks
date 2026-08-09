import { describe, it, expect } from 'vitest';
import html from '../../index.html?raw';

/**
 * `index.html` is read by no test and typechecked by nothing, which is the same hole
 * `hud.css.test.ts` exists to close one file over. It carries three rules that the touch
 * controls depend on completely, and deleting any of them is silent: review measured
 * `touch-action: none` being removed and all 1389 tests still passing.
 *
 * The rules are asserted, not the whole file — this is a guard against deletion, not a
 * snapshot that fights every edit.
 */
describe('index.html carries the rules touch input depends on', () => {
  it('loads as text at all', () => {
    // Vacuity check, exactly as hud.css.test.ts needs: every assertion below passes on
    // an empty string.
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(400);
    // NOT '<canvas': the canvas is created in JS, not markup -- this check caught that
    // on its first run, which is the point of having it.
    expect(html).toContain('<div id="app">');
    expect(html).toContain('canvas {'); // ...the style rule for it, which IS here
  });

  it('takes the canvas out of the browser gesture system', () => {
    // THE line that makes the virtual thumbstick work at all. Without it the browser
    // treats a drag as a candidate pan or pinch: measured on a Pixel 5, a drive drag got
    // pointerdown, TWO pointermoves and then pointercancel -- after which no further move
    // is delivered for that finger. A horizontal drag was cancelled after 16px, against a
    // 10.1px dead zone, and two thumbs moving apart zoomed the page to 4.25x.
    const canvasRule = html.slice(html.indexOf('canvas {'), html.indexOf('canvas {') + 200);
    expect(canvasRule, 'the canvas is back in the browser gesture system').toContain(
      'touch-action: none',
    );
  });

  it('keeps pull-to-refresh and the back-swipe off the board', () => {
    // Both begin as a drag on the board, which is also how the tank is driven.
    expect(html, 'overscroll-behavior is gone').toContain('overscroll-behavior: none');
  });

  it('still sizes itself to the device', () => {
    // Without this a phone renders at a ~980px virtual width and the whole touch layout
    // is measured against the wrong viewport -- including the left/right thumb split.
    expect(html).toMatch(/name="viewport"[^>]*width=device-width/);
  });
});
