// The strings a player reads on the assignment panel (issue #556).
//
// WHY THIS FILE EXISTS AT ALL. Until these moved out of `createHud` they were closure members
// reading `currentDetectedPads` from scope, so the only way to assert on them was to render a
// panel and read the DOM back. Every one of them is a pure function of a slot source and the
// live pad list, and this is what that buys: the copy is checked directly, including the
// fallbacks nobody renders on purpose.
import { describe, it, expect } from 'vitest';
import {
  NOT_SUPPORTED, candidateLabel, slotSourceLabel, unsupportedPad, unsupportedSentence,
} from './controller-labels';
import type { SlotSource } from '../input/assignment';
import type { DetectedPad } from '../input/gamepad';
import type { UnsupportedReason } from '../input/gamepad-profile';

const pad = (padIndex: number, id: string, unsupported?: UnsupportedReason): DetectedPad =>
  ({ padIndex, id, unsupported } as DetectedPad);

// The two real `UnsupportedReason` variants, built in full rather than cast. An earlier draft
// used `{ code: 'unreadable' } as DetectedPad['unsupported']`, which is not a code this union
// has -- the cast compiled under one tsc invocation and the repository's own `npm run
// typecheck` refused it. A fabricated code would also have meant the "cannot read its buttons"
// branch was never exercised by a reason the type can actually produce.
const TOO_FEW: UnsupportedReason = {
  code: 'insufficient-controls',
  profileId: 'generic',
  axes: 1,
  buttons: 2,
  requiredAxes: 2,
  requiredButtons: 8,
};
const UNKNOWN_MAPPING: UnsupportedReason = {
  code: 'unknown-mapping',
  mapping: '',
  id: 'Odd Pad',
};

const NAMED: DetectedPad[] = [pad(0, 'Xbox Wireless Controller'), pad(1, '')];

describe('slotSourceLabel', () => {
  it('names every variant of the union', () => {
    // Population: all four `SlotSource` kinds, so a variant added without a label fails here
    // rather than rendering `undefined` on the panel.
    const cases: [SlotSource, string][] = [
      [{ kind: 'keyboard' }, 'Keyboard / Mouse / Touch'],
      [{ kind: 'bot' }, 'Bot'],
      [{ kind: 'none' }, 'Unassigned'],
      [{ kind: 'gamepad', padIndex: 0 }, 'Xbox Wireless Controller (index 0)'],
    ];
    for (const [source, want] of cases) expect(slotSourceLabel(source, NAMED), source.kind).toBe(want);
    expect(cases).toHaveLength(4);
  });

  it('falls back to `Controller N` when the browser names a pad with an empty string', () => {
    // Pad 1 in the fixture has `id: ''`. Without the length check the label reads
    // " (index 1)" -- a leading space and nothing else, which is what a player would see.
    expect(slotSourceLabel({ kind: 'gamepad', padIndex: 1 }, NAMED)).toBe('Controller 1 (index 1)');
  });

  it('falls back when the pad is not in the live list at all', () => {
    // A slot bound to a controller that has since been unplugged. The index is still true.
    expect(slotSourceLabel({ kind: 'gamepad', padIndex: 7 }, NAMED)).toBe('Controller 7 (index 7)');
  });

  it('reads the list it is GIVEN, which is the point of threading it', () => {
    // The same source, two different lists, two different labels. This is what could not be
    // asserted while the function captured `currentDetectedPads` from a closure.
    const source: SlotSource = { kind: 'gamepad', padIndex: 0 };
    expect(slotSourceLabel(source, NAMED)).toBe('Xbox Wireless Controller (index 0)');
    expect(slotSourceLabel(source, [pad(0, 'DualSense')])).toBe('DualSense (index 0)');
    expect(slotSourceLabel(source, [])).toBe('Controller 0 (index 0)');
  });
});

describe('candidateLabel', () => {
  it('shortens the prose kinds and leaves a gamepad alone', () => {
    // The distinction the button copy exists for: "Keyboard / Mouse / Touch" reads as a
    // summary, not as something to click.
    expect(candidateLabel({ kind: 'keyboard' }, NAMED)).toBe('Keyboard');
    expect(candidateLabel({ kind: 'none' }, NAMED)).toBe('None');
    expect(candidateLabel({ kind: 'bot' }, NAMED)).toBe('Bot');
    expect(candidateLabel({ kind: 'gamepad', padIndex: 0 }, NAMED))
      .toBe(slotSourceLabel({ kind: 'gamepad', padIndex: 0 }, NAMED));
  });

  it('differs from slotSourceLabel for exactly the two prose kinds', () => {
    // Stated as a contrast rather than as four literals, so the relationship is the assertion.
    const differs = (['keyboard', 'bot', 'none'] as const).filter(
      (kind) => candidateLabel({ kind }, NAMED) !== slotSourceLabel({ kind }, NAMED),
    );
    expect(differs).toEqual(['keyboard', 'none']);
  });
});

describe('unsupportedPad and unsupportedSentence', () => {
  const BAD: DetectedPad[] = [
    pad(0, 'Tiny Pad', TOO_FEW),
    pad(1, 'Odd Pad', UNKNOWN_MAPPING),
    pad(2, 'Fine Pad'),
  ];

  it('flags only the pads carrying an unsupported reason', () => {
    expect(unsupportedPad(0, BAD)).toBe(true);
    expect(unsupportedPad(1, BAD)).toBe(true);
    expect(unsupportedPad(2, BAD), 'a supported pad').toBe(false);
    expect(unsupportedPad(9, BAD), 'a pad not in the list').toBe(false);
  });

  it('gives each documented code its own sentence, named from the live list', () => {
    expect(unsupportedSentence(BAD[0], BAD))
      .toBe("Tiny Pad (index 0) isn't supported: it has too few buttons or sticks for Tanks.");
    expect(unsupportedSentence(BAD[1], BAD))
      .toBe("Odd Pad (index 1) isn't supported: Tanks can't read its buttons in this browser.");
  });

  it('is the suffix the panel appends, not a sentence', () => {
    // Pinned because it is concatenated onto a label rather than rendered alone: the leading
    // space and the em dash are both load-bearing.
    expect(NOT_SUPPORTED).toBe(' — not supported');
    expect(NOT_SUPPORTED.startsWith(' ')).toBe(true);
  });
});
