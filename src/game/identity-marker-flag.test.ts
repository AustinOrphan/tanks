/*
 * Issue #922's resolution: which identity marker a session's renderer and the page's HUD
 * draw, from the `identityMarker` flag and the session's mode. The wiring that hands these
 * results to `createRenderer` and `createHud` is asserted in loop.test.ts; this file pins the
 * table itself.
 *
 * Population: the three flag states (absent, the reversal value `solid`, and `shape`, the one
 * drawable style since issue #1023 deleted `arcs` and `roof`) against the four mode states a
 * session's `devFlags.mode` can hold once widened to `GameMode | null` (`null` for
 * campaign-coop, plus `campaign-coop`, `ffa` and `teams`): 12 cells, every one asserted below.
 */
import { describe, expect, it } from 'vitest';
import type { GameMode } from '../sim/types';
import { IDENTITY_MARKER_STYLES } from '../presentation/identity-marker';
import {
  IDENTITY_MARKER_FLAG_VALUES,
  IDENTITY_MARKER_REVERSAL,
  SHIPPED_VERSUS_IDENTITY_MARKER,
  isIdentityMarkerFlag,
  sessionIdentityMarker,
  stripIdentityMarker,
} from './identity-marker-flag';

const MODES: readonly (GameMode | null)[] = [null, 'campaign-coop', 'ffa', 'teams'];
/** The sessions with no stock strip and no ruling on the marker: co-op campaign, both spellings. */
const NOT_VERSUS = MODES.filter((m) => m !== 'ffa' && m !== 'teams');

describe('the identity-marker flag vocabulary (issue #922)', () => {
  it('ships `shape`, and keeps `solid` out of the drawable styles', () => {
    expect(SHIPPED_VERSUS_IDENTITY_MARKER).toBe('shape');
    expect(IDENTITY_MARKER_REVERSAL).toBe('solid');
    // The reversal value draws nothing, so it must never reach a layer that draws: tests pin
    // IDENTITY_MARKER_STYLES as the drawable list, and the renderer's `identityMarkerGeometry`
    // draws the `shape` outline for any non-null style since issue #1023 left `shape` alone.
    expect(IDENTITY_MARKER_STYLES as readonly string[]).not.toContain(IDENTITY_MARKER_REVERSAL);
    expect(IDENTITY_MARKER_FLAG_VALUES).toEqual([...IDENTITY_MARKER_STYLES, IDENTITY_MARKER_REVERSAL]);
  });

  it('accepts every flag value and rejects anything else -- population: 2 values, 9 rejects', () => {
    // Spelled literally rather than looped over IDENTITY_MARKER_FLAG_VALUES, so a value the
    // production list gains or loses is caught here rather than carried along.
    for (const v of ['shape', 'solid']) expect(isIdentityMarkerFlag(v), v).toBe(true);
    // `arcs` and `roof` were styles until issue #1023 deleted them; `none`, `off` and `ring` are
    // what someone reaching for the reversal would type; `Solid` and `SHAPE` are casings, and
    // `circle` is slot 1's outline rather than a style.
    for (const v of ['arcs', 'roof', '', 'none', 'off', 'ring', 'Solid', 'SHAPE', 'circle']) {
      expect(isIdentityMarkerFlag(v), v).toBe(false);
    }
  });
});

describe('sessionIdentityMarker: what a session renderer draws (issue #922)', () => {
  it('draws the shipped `shape` marker in an unflagged FFA session', () => {
    expect(sessionIdentityMarker(null, 'ffa')).toBe(SHIPPED_VERSUS_IDENTITY_MARKER);
  });

  it('keeps the solid ring in every unflagged session that is not versus -- population: 2 modes', () => {
    // The rulings cover FFA (#234) and Teams (#1128) only. A mode-blind default would change
    // co-op rings, which neither ruled on.
    expect(NOT_VERSUS).toEqual([null, 'campaign-coop']);
    for (const mode of NOT_VERSUS) expect(sessionIdentityMarker(null, mode), String(mode)).toBeNull();
  });

  it('draws no marker for the reversal value, in every mode -- population: 4 modes', () => {
    for (const mode of MODES) {
      expect(sessionIdentityMarker(IDENTITY_MARKER_REVERSAL, mode), String(mode)).toBeNull();
    }
  });

  it('draws `shape`, named, in every mode -- population: 4 modes', () => {
    for (const mode of MODES) {
      expect(sessionIdentityMarker('shape', mode), String(mode)).toBe('shape');
    }
  });
});

describe('stripIdentityMarker: what the page HUD draws on every stock entry (issues #922, #1128)', () => {
  it('draws the shipped mark unflagged, none for the reversal value, and a named style as named', () => {
    expect(stripIdentityMarker(null)).toBe(SHIPPED_VERSUS_IDENTITY_MARKER);
    expect(stripIdentityMarker(IDENTITY_MARKER_REVERSAL)).toBeNull();
    expect(stripIdentityMarker('shape')).toBe('shape');
  });
});
