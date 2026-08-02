/**
 * Note names to frequencies. Its own module because BOTH the track format and
 * the chord/harmony code need it, and having chords.ts import it from
 * music-data.ts (which imports chords.ts back) is a circular import: the cycle
 * resolved in an order that left a module-level const uninitialised, and the
 * failure was a ReferenceError at import time, not a wrong note.
 */

/** A rest. Written as `-` in the JSON; parsed to null. */
export const REST = '-';

const SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/**
 * Scientific pitch notation -> Hz. `A4` is 440 by definition, and MIDI note 69
 * is that A, which is the whole of the arithmetic below.
 *
 * Octave numbering is the trap: in this notation the octave increments at C, not
 * at A, so B3 and C4 are a semitone apart while A3 and A4 are twelve. An
 * implementation that increments at A puts every note below C in the wrong
 * octave -- which sounds plausible until a bass line is an octave out.
 */
export function noteToHz(name: string): number | null {
  if (name === REST) return null;
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!m) return NaN;
  const [, letter, accidental, octaveText] = m;
  const octave = Number(octaveText);
  const semitone = SEMITONES[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
  // MIDI 69 = A4 = 440 Hz; MIDI 12 is C0, so C(n) is 12 * (n + 1).
  const midi = 12 * (octave + 1) + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}
