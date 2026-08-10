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

  it('covers the display cutouts, which is what makes the safe-area insets non-zero', () => {
    // hud.css insets .hud-topbar and .hud-touch by `max(base, env(safe-area-inset-*))`.
    // Those functions resolve to 0px unless the viewport covers the cutouts, so without
    // this token every one of those rules quietly falls back to its base spacing -- on
    // exactly the devices they exist for, and with nothing red anywhere. The assertion
    // above passes either way: it stops at `width=device-width`.
    expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
  });

  it('links the manifest and the iOS icon, both by RELATIVE href', () => {
    // Same rule as the favicon comment in the file: this is a /tanks/ project page, so
    // an origin-absolute href resolves against austinorphan.com's root. For the manifest
    // it is worse than a 404 -- `start_url` and `scope` resolve against the MANIFEST's
    // own URL, so a manifest fetched from the root would install a shortcut to the
    // portfolio. `tools/portability/check.mjs` re-asserts this against the BUILT output,
    // where the value could differ; this catches it in the source.
    expect(html).toMatch(/<link[^>]*rel="manifest"[^>]*href="\.\/manifest\.webmanifest"/);
    expect(html).toMatch(/<link[^>]*rel="apple-touch-icon"[^>]*href="\.\/icons\//);
  });
});
