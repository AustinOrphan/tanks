/*
 * Issue #922's resolution: which identity marker a session's renderer and the page's HUD
 * draw, from the `identityMarker` flag and the session's mode. The wiring that hands these
 * results to `createRenderer` and `createHud` is asserted in loop.test.ts; this file pins the
 * table itself.
 *
 * Population: the five flag states (absent, the reversal value `solid`, and the three
 * drawable styles) against the four mode states a session's `devFlags.mode` can hold once
 * widened to `GameMode | null` (`null` for campaign-coop, plus `campaign-coop`, `ffa` and
 * `teams`): 20 cells, every one asserted below.
 */
import { describe, expect, it } from 'vitest';
import type { GameMode } from '../sim/types';
import { IDENTITY_MARKER_STYLES } from '../presentation/identity-marker';
import {
  IDENTITY_MARKER_FLAG_VALUES,
  IDENTITY_MARKER_REVERSAL,
  SHIPPED_FFA_IDENTITY_MARKER,
  isIdentityMarkerFlag,
  sessionIdentityMarker,
  stripIdentityMarker,
} from './identity-marker-flag';

const MODES: readonly (GameMode | null)[] = [null, 'campaign-coop', 'ffa', 'teams'];
const NOT_FFA = MODES.filter((m) => m !== 'ffa');

describe('the identity-marker flag vocabulary (issue #922)', () => {
  it('ships `shape`, and keeps `solid` out of the drawable styles', () => {
    expect(SHIPPED_FFA_IDENTITY_MARKER).toBe('shape');
    expect(IDENTITY_MARKER_REVERSAL).toBe('solid');
    // The reversal value draws nothing, so it must never reach a layer that draws: four tests
    // pin IDENTITY_MARKER_STYLES as the drawable list, and the HUD's `identityMarkerIcon` would
    // draw a `shape` outline for any style it does not recognise.
    expect(IDENTITY_MARKER_STYLES as readonly string[]).not.toContain(IDENTITY_MARKER_REVERSAL);
    expect(IDENTITY_MARKER_FLAG_VALUES).toEqual([...IDENTITY_MARKER_STYLES, IDENTITY_MARKER_REVERSAL]);
  });

  it('accepts every flag value and rejects anything else -- population: 4 values, 7 rejects', () => {
    for (const v of IDENTITY_MARKER_FLAG_VALUES) expect(isIdentityMarkerFlag(v), v).toBe(true);
    // `none`, `off` and `ring` are what someone reaching for the reversal would type; `Solid`
    // and `SHAPE` are casings, and `circle` is slot 1's outline rather than a style.
    for (const v of ['', 'none', 'off', 'ring', 'Solid', 'SHAPE', 'circle']) {
      expect(isIdentityMarkerFlag(v), v).toBe(false);
    }
  });
});

describe('sessionIdentityMarker: what a session renderer draws (issue #922)', () => {
  it('draws the shipped `shape` marker in an unflagged FFA session', () => {
    expect(sessionIdentityMarker(null, 'ffa')).toBe(SHIPPED_FFA_IDENTITY_MARKER);
  });

  it('keeps the solid ring in every unflagged session that is not FFA -- population: 3 modes', () => {
    // The ruling covers FFA only. A mode-blind default would put slot shapes on teams tanks in
    // team colours and change co-op rings.
    for (const mode of NOT_FFA) expect(sessionIdentityMarker(null, mode), String(mode)).toBeNull();
  });

  it('draws no marker for the reversal value, in every mode -- population: 4 modes', () => {
    for (const mode of MODES) {
      expect(sessionIdentityMarker(IDENTITY_MARKER_REVERSAL, mode), String(mode)).toBeNull();
    }
  });

  it('draws a named style in every mode -- population: 3 styles x 4 modes', () => {
    for (const style of IDENTITY_MARKER_STYLES) {
      for (const mode of MODES) {
        expect(sessionIdentityMarker(style, mode), `${style} in ${String(mode)}`).toBe(style);
      }
    }
  });
});

describe('stripIdentityMarker: what the page HUD draws on FFA entries (issue #922)', () => {
  it('draws the shipped mark unflagged, none for the reversal value, and a named style as named', () => {
    expect(stripIdentityMarker(null)).toBe(SHIPPED_FFA_IDENTITY_MARKER);
    expect(stripIdentityMarker(IDENTITY_MARKER_REVERSAL)).toBeNull();
    for (const style of IDENTITY_MARKER_STYLES) expect(stripIdentityMarker(style), style).toBe(style);
  });
});
