import { describe, expect, it } from 'vitest';

import { HIT_FLOOR, hitTargetFailures, scrollsSideways } from './hit-targets.mjs';

/**
 * The verdict applied to a measured screen state (issue #686). The browser half cannot run
 * here, so each case below is a measurement shape that must fail, beside the passing shape it
 * departs from.
 *
 * The failing sizes are real readings from Chromium on the tree before the floor: a `--sm`
 * toggle at 27 px tall, the versus player-count button at 39.4 px wide, and the tertiary
 * Start New Campaign at 157.9x19.
 */
const control = (over: Partial<{ key: string; text: string; x: number; y: number; w: number; h: number; pressableW: number; reachable: boolean; pinned: string }> = {}) => {
  const box = {
    key: 'button.ui-btn.ui-btn--slab.hud-settings-back',
    text: 'Back',
    x: 100,
    y: 500,
    w: 72,
    h: 44,
    reachable: true,
    ...over,
  };
  // `pressableW` follows the width unless a case sets it, so a control that is not clipped
  // reads the same as it always did and every existing case keeps its meaning.
  return { pressableW: box.w, ...box };
};

function holding() {
  return {
    state: 'screen.settings',
    viewport: '320x568',
    controls: [control(), control({ key: 'button.ui-btn.ui-btn--sm.hud-settings-mute', text: 'Mute (M)', y: 440, w: 83 })],
    overflow: { page: false, sideways: [] },
  };
}

describe('menu hit-target verdict (issue #686)', () => {
  it('passes a surface whose controls all clear the floor, including ones exactly at it', () => {
    expect(HIT_FLOOR).toBe(44);
    expect(hitTargetFailures(holding())).toEqual([]);
  });

  it('fails a control under the floor in height -- the shipped 27px --sm toggle', () => {
    const run = holding();
    run.controls[1] = control({ key: 'button.ui-btn.ui-btn--sm.hud-haptics-toggle', text: 'Haptics', y: 440, w: 102.8, h: 27 });
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: button.ui-btn.ui-btn--sm.hud-haptics-toggle "Haptics" is 102.8x27, under the 44px floor',
    ]);
  });

  it('fails a control under the floor in width alone -- the 39.4px player-count button', () => {
    const run = holding();
    run.controls[1] = control({ key: 'button.ui-btn.hud-versus-option-btn', text: '2 players', y: 440, w: 39.4, h: 44 });
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: button.ui-btn.hud-versus-option-btn "2 players" is 39.4x44, under the 44px floor',
    ]);
  });

  it('fails two controls whose boxes overlap, and not two that only share an edge', () => {
    const run = holding();
    run.controls[1] = control({ key: 'button.ui-btn.hud-settings-mute', text: 'Mute (M)', y: 520 });
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: button.ui-btn.ui-btn--slab.hud-settings-back "Back" overlaps button.ui-btn.hud-settings-mute "Mute (M)"',
    ]);
    const touching = holding();
    touching.controls[1] = control({ key: 'button.ui-btn.hud-settings-mute', text: 'Mute (M)', y: 544 });
    expect(hitTargetFailures(touching), 'adjacent, not overlapping').toEqual([]);
  });

  it('does not fail scrolled content passing under a pinned action bar, but fails two pinned controls that overlap', () => {
    // Measured at 320x568 on Versus Setup: a map card 29.8px under the sticky Start bar.
    const card = control({ key: 'button.ui-btn.ui-selectable.hud-versus-map-card', text: 'Arena 3', x: 40, y: 480, w: 240, h: 80 });
    const start = control({ key: 'button.ui-btn.ui-btn--primary.hud-versus-start', text: 'Start', x: 63, y: 530, w: 193, h: 47, pinned: 'hud-versus-actions' });
    expect(hitTargetFailures({ ...holding(), controls: [card, start] })).toEqual([]);
    const back = control({ key: 'button.ui-btn.ui-btn--slab.hud-versus-back', text: 'Back', x: 200, y: 530, pinned: 'hud-versus-actions' });
    expect(hitTargetFailures({ ...holding(), controls: [card, start, back] })).toEqual([
      'screen.settings 320x568: button.ui-btn.ui-btn--primary.hud-versus-start "Start" overlaps button.ui-btn.ui-btn--slab.hud-versus-back "Back"',
    ]);
  });

  it('judges overlap on the visible part, so a control scrolled out of its container does not overlap one outside it (issue #766)', () => {
    // Shaped on the Controllers pane with two pads at 1280x800@200% (a 640x400 page): the
    // unsupported pad's button is scrolled below its rows container, and its box lies on Back.
    const back = control({ key: 'button.ui-btn.ui-btn--slab.hud-controllers-back', text: 'Back', x: 284, y: 356, w: 72, h: 44 });
    const hidden = control({
      key: 'button.ui-btn.ui-selectable.hud-controller-source-btn',
      text: 'HuiJia USB GamePad (index 1) — not suppo',
      x: 237, y: 360, w: 167, h: 44,
      clip: { x: 237, y: 236, w: 167, h: 0 },
    });
    expect(hitTargetFailures({ ...holding(), controls: [back, hidden] })).toEqual([]);
    // The same button half scrolled into view, where its visible half does lie on Back, still fails.
    const halfShown = { ...hidden, clip: { x: 237, y: 360, w: 167, h: 22 } };
    expect(hitTargetFailures({ ...holding(), controls: [back, halfShown] })).toEqual([
      'screen.settings 320x568: button.ui-btn.ui-btn--slab.hud-controllers-back "Back" overlaps button.ui-btn.ui-selectable.hud-controller-source-btn "HuiJia USB GamePad (index 1) — not suppo"',
    ]);
    // And the size floor still reads the whole box: a clipped 30px-tall control is still too small.
    const small = { ...hidden, y: 600, h: 30, clip: { x: 237, y: 236, w: 167, h: 0 } };
    expect(hitTargetFailures({ ...holding(), controls: [back, small] })).toEqual([
      'screen.settings 320x568: button.ui-btn.ui-selectable.hud-controller-source-btn "HuiJia USB GamePad (index 1) — not suppo" is 167x30, under the 44px floor',
    ]);
  });

  it('fails a control a player cannot scroll to', () => {
    const run = holding();
    run.controls[0] = control({ reachable: false });
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: button.ui-btn.ui-btn--slab.hud-settings-back "Back" cannot be scrolled to',
    ]);
  });

  it('fails a page that scrolls horizontally', () => {
    const run = holding();
    run.overflow = { page: true, sideways: [] };
    expect(hitTargetFailures(run)).toEqual(['screen.settings 320x568: the page scrolls horizontally']);
  });

  it('fails a control clipped by the screen edge, which measures 44px but cannot all be pressed', () => {
    // THE READING #932 EXISTS FOR, in the numbers it was found with. Measured on the tree
    // before #913: the first and last hull swatch sat at x=-2 and right=322 in a 320px
    // viewport. Both reported w=44 and cleared the floor, while 2px of each hung off the
    // screen -- and `.hud-customize` carries `touch-action: pan-y`, so no gesture brought
    // them back. The box was never the thing a player presses.
    const run = holding();
    run.controls[1] = control({ key: 'button.ui-selectable.hud-swatch', text: 'Hull: Classic blue', x: -2, y: 300, w: 44, h: 44, pressableW: 42 });
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: button.ui-selectable.hud-swatch "Hull: Classic blue" is 44x44 with only 42px of it on screen, under the 44px floor',
    ]);
  });

  it('does not fail a control clipped downward, because scrolling answers that one', () => {
    // The asymmetry, asserted rather than described. A control below the fold is still its full
    // size once a player scrolls to it, and whether they CAN is `reachable`'s question, already
    // asked above. Only the across reading is cut to the screen, so this must stay passing --
    // a floor that read a clipped height would fail most of a long pane.
    const run = holding();
    run.controls[1] = control({ key: 'button.ui-btn.hud-settings-mute', text: 'Mute (M)', y: 900, h: 44, clip: { x: 100, y: 900, w: 72, h: 0 } });
    expect(hitTargetFailures(run)).toEqual([]);
  });

  it('fails a control measured without a pressable width, instead of falling back to its box', () => {
    // A negative control for the requirement itself. Defaulting the missing field to `c.w`
    // would restore the exact behaviour that passed the swatches, and nothing would say so.
    const run = holding();
    const { pressableW: _dropped, ...noWidth } = control({ key: 'button.ui-btn.hud-settings-mute', text: 'Mute (M)', y: 440 });
    run.controls[1] = noWidth as typeof run.controls[1];
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: button.ui-btn.hud-settings-mute "Mute (M)" was measured without a pressable width',
    ]);
  });

  it('fails a container that scrolls sideways, naming it and its two widths', () => {
    // The pane that shipped: 320px of viewport over 322px of content, which `overflow.page`
    // could not see because everything here is inside a `position: fixed` app root.
    const run = holding();
    run.overflow = { page: false, sideways: [{ key: 'div.hud-customize', clientW: 320, scrollW: 322, overflowX: 'auto' }] };
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: div.hud-customize scrolls sideways, 320px wide over 322px of content',
    ]);
  });

  it('passes the two reported shapes that are wider than their box and are not defects', () => {
    // Both exemptions, with the populations that forced each. A bare `scrollWidth >
    // clientWidth` sweep reported 236 boxes on a CLEAN tree and would have been unusable.
    const run = holding();
    run.overflow = {
      page: false,
      sideways: [
        // 168 of the 236: a visible-overflow box paints its content outside its padding box
        // without scrolling anywhere. Nearly all were buttons whose label is wider than the
        // box the text is centred in.
        { key: 'button.ui-btn.hud-versus-option-btn', clientW: 96, scrollW: 118, overflowX: 'visible' },
        // The other 68: `.ui-sr-only` is 1px wide holding a whole sentence.
        { key: 'span.ui-sr-only', clientW: 1, scrollW: 55, overflowX: 'hidden' },
      ],
    };
    expect(hitTargetFailures(run)).toEqual([]);
  });

  it('fails a one-pixel box only for being one pixel, not for the class it happens to carry', () => {
    // The exemption is keyed on the BOX, so any visually-hidden idiom is covered and a real
    // pane cannot buy its way out by borrowing a class name. Same 1px box under a different
    // class still passes; the same class at a real width does not.
    expect(scrollsSideways({ key: 'p.visually-hidden', clientW: 1, scrollW: 55, overflowX: 'hidden' })).toBe(false);
    expect(scrollsSideways({ key: 'div.ui-sr-only', clientW: 320, scrollW: 322, overflowX: 'hidden' })).toBe(true);
    // And clipped counts, not just scrollable: `overflow-x: hidden` means the content cannot be
    // reached at all, which is worse than a pane a player can drag.
    expect(scrollsSideways({ key: 'div.hud-customize', clientW: 320, scrollW: 322, overflowX: 'hidden' })).toBe(true);
    expect(scrollsSideways({ key: 'div.hud-customize', clientW: 320, scrollW: 320, overflowX: 'auto' })).toBe(false);
  });

  it('fails a reading with no sideways result at all, instead of passing it', () => {
    // The same hole one level up: `overflow.page` spent its whole life unable to fire and
    // looked exactly like a clean reading. A collector that stopped reporting `sideways` --
    // or a `page.evaluate` that returned undefined -- must not read as "nothing overflowed".
    const run = holding();
    run.overflow = { page: false } as typeof run.overflow;
    expect(hitTargetFailures(run)).toEqual([
      'screen.settings 320x568: no sideways overflow reading, so nothing was checked',
    ]);
  });

  it('fails a reading that never reached its surface, instead of passing an empty one', () => {
    expect(hitTargetFailures({ ...holding(), failed: 'Timeout 20000ms exceeded' })).toEqual([
      'screen.settings 320x568: never reached its surface (Timeout 20000ms exceeded)',
    ]);
    expect(hitTargetFailures({ ...holding(), controls: [] })).toEqual([
      'screen.settings 320x568: no controls measured, so nothing was checked',
    ]);
  });
});
