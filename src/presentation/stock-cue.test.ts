import { describe, it, expect } from 'vitest';
import { narrowPipLayout, NARROW_STRIP_QUERY, STOCK_CUES } from './stock-cue';

/**
 * Issue #835: the `pips` arm overflowed a 390px viewport and clipped its last entry silently,
 * because the strip is a nowrap flex row with no wrapping or scrolling.
 *
 * Every number here came from real Chromium layout at 390px against the real stylesheet
 * (`tools/hud/strip-width.mjs`, which is checked in so the measurement can be repeated). These
 * cases pin the TABLE; the tool proves the widths.
 */
describe('stock cue: pip sizing on a narrow viewport (issue #835)', () => {
  it('leaves two- and three-player strips at the shipped size where they already fit', () => {
    // Measured: 2 players never exceeds the budget at any stock count, and 3 players fits up
    // to four stocks. Shrinking those would be a cost with nothing bought.
    for (const total of [1, 2, 3, 4, 5]) {
      expect(narrowPipLayout(2, total), `2p x ${total}`).toEqual({ kind: 'row', pip: 10, gap: 3 });
    }
    for (const total of [1, 2, 3, 4]) {
      expect(narrowPipLayout(3, total), `3p x ${total}`).toEqual({ kind: 'row', pip: 10, gap: 3 });
    }
  });

  it('steps down only where the shipped size overflowed', () => {
    // 3p x 5 measured 271.3px against a 254.1px budget; 4p x 3 measured 261.1px, the 7px
    // overflow the issue reported. Both carry a 9px pip.
    expect(narrowPipLayout(3, 5)).toEqual({ kind: 'row', pip: 9, gap: 2 });
    expect(narrowPipLayout(4, 3)).toEqual({ kind: 'row', pip: 9, gap: 2 });
    expect(narrowPipLayout(4, 1)).toEqual({ kind: 'row', pip: 9, gap: 2 });
  });

  it('keeps ONE pip and states the count, rather than dropping the shape entirely', () => {
    // Four players at four or five stocks fits a full row only at 7px and 6px, with about ONE
    // pixel of margin -- fragile, and self-defeating since `pips` is the arm that turns the
    // count into shape.
    //
    // THE FALLBACK IS NOT A BARE DIGIT, and that was the first answer and wrong twice over: it
    // drops the shape channel this arm exists to provide, and it leaves the loss cue with
    // nothing to animate, because the cue IS the pip swelling and bursting. An entry that
    // cannot burst is the absence of the arm, not a degraded form of it.
    expect(narrowPipLayout(4, 4)).toEqual({ kind: 'one', pip: 10 });
    expect(narrowPipLayout(4, 5)).toEqual({ kind: 'one', pip: 10 });
  });

  it('never draws a pip below the 8px legibility floor, in either layout', () => {
    // The property that makes the null meaningful: every size it DOES return is one a player
    // can count. Population: every player count the game allows (2-4) against every versus
    // stock setting (1-5).
    for (let slots = 2; slots <= 4; slots++) {
      for (let total = 1; total <= 5; total++) {
        const layout = narrowPipLayout(slots, total);
        expect(layout.pip, `${slots}p x ${total}`).toBeGreaterThanOrEqual(8);
        if (layout.kind === 'row') {
          expect(layout.gap, `${slots}p x ${total}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('is scoped to the phone tier the measurement was taken at', () => {
    // A media query rather than a layout read: the strip is rebuilt on every status that
    // moves, and measuring it each time would force a reflow in the HUD path.
    expect(NARROW_STRIP_QUERY).toBe('(max-width: 480px)');
  });

  it('leaves the other arms alone -- this is a pips fix, not a strip redesign', () => {
    // #230's ruling is between the arms, so a change that quietly reshaped a sibling would
    // corrupt the comparison it exists to serve.
    expect([...STOCK_CUES]).toEqual(['pips', 'marks', 'strike', 'badge']);
  });
});
