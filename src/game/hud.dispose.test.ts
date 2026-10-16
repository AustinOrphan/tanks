// @vitest-environment jsdom
//
// What `dispose` must take off `window` and `document`: every listener the HUD registered
// there outlives it otherwise.
//
// ITS OWN FILE so a mutation that leaks one of these listeners runs a short scope. The harness
// runs an entry's scoped files whole, and in `hud.navigation.test.ts` a leaked roving `keydown`
// listener is left behind by every test and runs on every later key press: 58s for the file
// under jsdom 30.1.1, already 132s on a CI shard (killed at 180s once, main at aafa0b90), and
// past the harness's 180s kill under jsdom 30.1.2, which recomputes styles after each focus move.
import { describe, it, expect, vi } from 'vitest';
import { createHud } from './hud';

describe('createHud dispose', () => {
  it('removes every capture-phase window key listener it added, by reference, on dispose', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);

    // Every window `keydown`/`keypress`/`keyup` registration the HUD makes, capture or not:
    // the carried-Confirm guard's three (issue #919), bound first, then the roving walk's
    // `onNavKeyDown`. All four at capture, and four distinct registrations, so a dispose that
    // drops any one of them leaves a listener that outlives its HUD.
    const added = addSpy.mock.calls.filter((c) => ['keydown', 'keypress', 'keyup'].includes(c[0]));
    expect(
      added.map((c) => [c[0], c[2]]),
      'the HUD registered a different set of window key listeners',
    ).toEqual([
      ['keydown', true],
      ['keypress', true],
      ['keyup', true],
      ['keydown', true],
    ]);

    h.dispose();

    // The SAME function reference and the same capture flag: `removeEventListener` with any
    // other is a silent no-op. Named with its index, because two of the four are keydowns.
    added.forEach(([type, listener], i) => {
      const removed = removeSpy.mock.calls.some((c) => c[0] === type && c[1] === listener && c[2] === true);
      expect(removed, `dispose did not remove window key listener ${i} (${type})`).toBe(true);
    });

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  /**
   * The keydown case above had a test and this one did not (issue #921), although the two
   * are registered four lines apart and torn down two lines apart.
   *
   * It is on `document`, not `window`, which is why the spy above cannot see it: the modal
   * focus trap has to catch a focus landing anywhere in the document, and `focusin` is not
   * fired at `window`. A leaked one outlives the HUD that owns it and keeps dragging focus
   * back toward an overlay that is no longer on the page.
   */
  it('removes its own capture-phase document focusin listener on dispose', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);

    const added = addSpy.mock.calls.find((c) => c[0] === 'focusin' && c[2] === true);
    expect(added, 'no capture-phase focusin listener was registered at document').toBeDefined();

    h.dispose();

    // The SAME function reference, not merely a focusin removal: `removeEventListener`
    // with a different callback is a silent no-op, so an assertion that only counted
    // calls would pass against the leak it exists to catch.
    const removed = removeSpy.mock.calls.find(
      (c) => c[0] === 'focusin' && c[1] === added![1] && c[2] === true,
    );
    expect(removed, 'dispose did not remove the capture-phase focusin listener it added').toBeDefined();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
