import { describe, it, expect } from 'vitest';
import {
  readPadDiagnostics,
  formatPadReport,
  padLabel,
  describeSupport,
  type PadDiagnostic,
} from './gamepad-diagnostics';
import type { GamepadLike } from './gamepad';
import { STANDARD_PROFILE } from './gamepad-profile';

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

describe('the support verdict the self-test carries (issue #596)', () => {
  it('accepts a browser-remapped pad and refuses the unmapped one, in the same walk', () => {
    // The self-test's numbers always SHOWED the difference between these two pads; what it
    // could not say is what the game does about it, which is the question a tester opens the
    // pane to answer. Both pads in one call, because the interesting failure is a verdict
    // that is really a constant: a classifier wired to always-supported passes a test that
    // only ever poses a standard pad.
    const [standard, unmapped] = readPadDiagnostics(() => [standardPad(), nonStandardPad()]);
    expect(standard?.support.kind).toBe('standard');
    expect(unmapped?.support).toEqual({
      kind: 'unknown',
      reason: { code: 'unknown-mapping', mapping: '', id: 'HuiJia  USB GamePad' },
    });
  });

  it('turns each of the four verdicts into a distinct developer line', () => {
    // Four, and all four distinct: a `describeSupport` that fell through to one string for
    // both refusals would read as "unsupported" on a pad whose real problem is a missing
    // stick, and the tester would file the wrong report.
    expect(describeSupport({ kind: 'standard', profile: STANDARD_PROFILE })).toBe('supported (standard mapping)');
    expect(
      describeSupport({ kind: 'profile', profile: { ...STANDARD_PROFILE, id: 'made-up' } }),
    ).toBe('supported (profile: made-up)');
    expect(describeSupport({ kind: 'unknown', reason: { code: 'unknown-mapping', mapping: '', id: 'x' } })).toMatch(
      /^NOT supported/,
    );
    const short = describeSupport({
      kind: 'insufficient',
      reason: {
        code: 'insufficient-controls',
        profileId: 'standard',
        axes: 2,
        buttons: 4,
        requiredAxes: 4,
        requiredButtons: 16,
      },
    });
    // The COUNTS are in the line, both what the pad has and what the profile wanted. "Not
    // supported" alone sends a tester to guess; "2 axes ... needs 4" is the whole diagnosis.
    expect(short).toContain('2 axes and 4 buttons');
    expect(short).toContain('needs 4 and 16');
  });
});

describe('padLabel', () => {
  it('falls back to the index when the browser reports no name, and never invents one otherwise', () => {
    const unknown = { kind: 'unknown', reason: { code: 'unknown-mapping', mapping: '', id: '' } } as const;
    expect(padLabel({ padIndex: 2, id: '', mapping: '', axes: [], buttons: [], support: unknown })).toBe('Controller 2');
    expect(padLabel({ padIndex: 2, id: 'Real Name', mapping: '', axes: [], buttons: [], support: unknown })).toBe('Real Name');
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

  it('states the support verdict per pad, so the reader is not left to infer it (issue #596)', () => {
    // A compatibility report that lists a mapping string and an axis count, and leaves the
    // reader to work out whether the game accepted the device, is making the reader do the
    // classifier's job -- and getting it wrong is the entire failure mode this report exists
    // to prevent. Both pads in one report, so a support line that was really a constant fails.
    const text = formatPadReport(readPadDiagnostics(() => [standardPad(), nonStandardPad()]), context);
    expect(text).toContain('- Tanks support: supported (standard mapping)');
    expect(text).toContain('- Tanks support: NOT supported: no profile matches this mapping/id');
    // One line per pad, directly under that pad's mapping line: the report is read per-section
    // and a verdict that floated to the top would be attributed to whichever pad was first.
    expect(text.match(/^- Tanks support: /gm)).toHaveLength(2);
    const [mappingLine, supportLine] = [text.indexOf('- mapping: standard'), text.indexOf('- Tanks support: supported')];
    expect(supportLine).toBeGreaterThan(mappingLine);
  });
});
