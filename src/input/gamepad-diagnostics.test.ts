import { describe, it, expect } from 'vitest';
import {
  readPadDiagnostics,
  formatPadReport,
  padLabel,
  type PadDiagnostic,
} from './gamepad-diagnostics';
import type { GamepadLike } from './gamepad';

/**
 * A pad the browser HAS remapped onto the standard layout: `mapping: 'standard'`, the four
 * axes and seventeen buttons that layout defines. This is the shape `gamepad.ts`'s fixed
 * fire/mine/stick indices are correct for.
 */
function standardPad(overrides: Partial<{ id: string; axes: number[]; buttons: { pressed: boolean; value?: number }[] }> = {}): GamepadLike {
  return {
    id: overrides.id ?? 'Standard Pad (Vendor: 057e Product: 2009)',
    mapping: 'standard',
    axes: overrides.axes ?? [0, 0, 0, 0],
    buttons: overrides.buttons ?? Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}

/**
 * A pad the browser has NOT remapped -- the case the self-test exists for. Different in
 * three ways at once, on purpose: no mapping string, a DIFFERENT axis count and a
 * DIFFERENT button count. A fixture that only dropped `mapping` would flow through the
 * same code path as the standard one and could not fail if the non-standard path broke.
 */
function nonStandardPad(): GamepadLike {
  return {
    id: 'HuiJia  USB GamePad',
    mapping: '',
    axes: [0.05, -0.98, 0, 0, 1, -1],
    buttons: Array.from({ length: 12 }, (_, i) => ({ pressed: i === 3, value: i === 3 ? 1 : 0 })),
  };
}

describe('readPadDiagnostics', () => {
  it('reports every occupied index of a sparse pad array, and skips the holes', () => {
    // `navigator.getGamepads()` returns a SPARSE array: `length` is the highest index ever
    // occupied plus one, not the pad count, and unplugged slots read `null`. A walk that
    // trusted `length` would report two phantom pads here.
    const pads = readPadDiagnostics(() => [null, standardPad({ id: 'A' }), null, standardPad({ id: 'B' })]);
    expect(pads.map((p) => [p.padIndex, p.id])).toEqual([
      [1, 'A'],
      [3, 'B'],
    ]);
  });

  it('reports each pad independently, with its own mapping and its own axis and button counts', () => {
    // The multiple-pads criterion and the non-standard-fixture criterion in one read: the
    // two pads disagree about all three, so a model that shared any of them across pads --
    // or derived a count from a constant rather than from the array it came with -- lands here.
    const [standard, odd] = readPadDiagnostics(() => [standardPad(), nonStandardPad()]);
    expect(standard.mapping).toBe('standard');
    expect(standard.axes.length).toBe(4);
    expect(standard.buttons.length).toBe(17);
    expect(odd.mapping).toBe('');
    expect(odd.axes.length).toBe(6);
    expect(odd.buttons.length).toBe(12);
  });

  it('leaves an unmapped pad unmapped rather than normalising it to standard', () => {
    // The whole subject of the report. If a missing `mapping` were defaulted to
    // `'standard'`, the report would state that the browser had remapped a pad it had not,
    // which is the single most misleading sentence this feature could produce.
    const [pad] = readPadDiagnostics(() => [{ axes: [0, 0], buttons: [{ pressed: false }] }]);
    expect(pad.mapping).toBe('');
    expect(pad.id).toBe('');
  });

  it('reads a pressed button with no reported value as fully travelled, not as untouched', () => {
    // `value` is optional on `GamepadLike`. Reading `undefined` as 0 would draw a HELD
    // button as up -- the report would state the opposite of what the tester is doing.
    const [pad] = readPadDiagnostics(() => [
      { axes: [], buttons: [{ pressed: true }, { pressed: false }, { pressed: false, value: 0.42 }] },
    ]);
    expect(pad.buttons).toEqual([
      { pressed: true, value: 1 },
      { pressed: false, value: 0 },
      { pressed: false, value: 0.42 },
    ]);
  });

  it('copies the live axis and button arrays instead of retaining the browser’s own', () => {
    // A real `Gamepad` object is re-read each frame; a retained reference is a snapshot of
    // nothing in particular. Held references are also how a "live" readout silently stops
    // updating -- the pane would redraw the SAME array object forever and show no change.
    const axes = [0.1, 0.2];
    const buttons = [{ pressed: false, value: 0 }];
    const [pad] = readPadDiagnostics(() => [{ axes, buttons }]);
    axes[0] = 0.9;
    buttons[0] = { pressed: true, value: 1 };
    expect(pad.axes).toEqual([0.1, 0.2]);
    expect(pad.buttons).toEqual([{ pressed: false, value: 0 }]);
  });

  it('tolerates a getGamepads that throws, exactly as readDetectedPads does', () => {
    expect(
      readPadDiagnostics(() => {
        throw new Error('no gamepad permission');
      }),
    ).toEqual([]);
  });
});

describe('padLabel', () => {
  it('falls back to the index when the browser reports no name, and never invents one otherwise', () => {
    expect(padLabel({ padIndex: 2, id: '', mapping: '', axes: [], buttons: [] })).toBe('Controller 2');
    expect(padLabel({ padIndex: 2, id: 'Real Name', mapping: '', axes: [], buttons: [] })).toBe('Real Name');
  });
});

describe('formatPadReport', () => {
  const context = { userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15', url: 'https://example.test/tanks/?dev=1' };

  it('carries the browser and page context, so a pasted report is attributable', () => {
    // The acceptance criterion is "copied into an issue WITH hardware/browser context". A
    // report that listed only axis numbers would satisfy the copy half and be useless.
    const text = formatPadReport([], context);
    expect(text).toContain('Mozilla/5.0 (Macintosh) Safari/605.1.15');
    expect(text).toContain('https://example.test/tanks/?dev=1');
  });

  it('says no pad is visible, rather than rendering an empty report that reads as a pad with nothing on it', () => {
    const text = formatPadReport([], context);
    expect(text).toContain('Pads visible: 0');
    expect(text).toMatch(/No gamepad is visible/);
  });

  it('states every pad’s index, name, mapping and counts, and one line per axis and per button', () => {
    const pads: PadDiagnostic[] = readPadDiagnostics(() => [null, nonStandardPad()]);
    const text = formatPadReport(pads, context);
    expect(text).toContain('Pads visible: 1');
    expect(text).toContain('### Index 1 -- HuiJia  USB GamePad');
    expect(text).toContain('- mapping: (none reported)');
    expect(text).toContain('- axes: 6');
    expect(text).toContain('- buttons: 12');
    expect(text).toContain('axis 1: -0.98');
    expect(text).toContain('button 3: down 1.00');
    expect(text).toContain('button 0: up   0.00');
    // One line per axis and per button, no truncation: a report that showed the first few
    // would hide exactly the high indices a non-standard pad puts its controls on.
    expect(text.match(/^axis \d+:/gm)).toHaveLength(6);
    expect(text.match(/^button \d+:/gm)).toHaveLength(12);
  });

  it('names an unreported mapping as unreported rather than printing an empty field', () => {
    const text = formatPadReport(readPadDiagnostics(() => [standardPad()]), context);
    expect(text).toContain('- mapping: standard');
  });
});
