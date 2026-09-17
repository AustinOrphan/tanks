import { describe, expect, it } from 'vitest';

import { HIT_FLOOR, hitTargetFailures } from './hit-targets.mjs';

/**
 * The verdict applied to a measured screen state (issue #686). The browser half cannot run
 * here, so each case below is a measurement shape that must fail, beside the passing shape it
 * departs from.
 *
 * The failing sizes are real readings from Chromium on the tree before the floor: a `--sm`
 * toggle at 27 px tall, the versus player-count button at 39.4 px wide, and the tertiary
 * Start New Campaign at 157.9x19.
 */
const control = (over: Partial<{ key: string; text: string; x: number; y: number; w: number; h: number; reachable: boolean; pinned: string }> = {}) => ({
  key: 'button.ui-btn.ui-btn--slab.hud-settings-back',
  text: 'Back',
  x: 100,
  y: 500,
  w: 72,
  h: 44,
  reachable: true,
  ...over,
});

function holding() {
  return {
    state: 'screen.settings',
    viewport: '320x568',
    controls: [control(), control({ key: 'button.ui-btn.ui-btn--sm.hud-settings-mute', text: 'Mute (M)', y: 440, w: 83 })],
    overflow: { page: false },
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
    run.overflow = { page: true };
    expect(hitTargetFailures(run)).toEqual(['screen.settings 320x568: the page scrolls horizontally']);
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
