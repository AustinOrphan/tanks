import { noteToHz } from './notes';

/**
 * The harmony, made explicit.
 *
 * Until now a track's chords existed only implicitly, in whichever notes the pad
 * layers happened to play. That is fine for a human writing every note, and
 * useless for anything that has to GENERATE notes: a melody generator needs to
 * know which pitches are consonant right now, and it cannot infer that from a
 * pad layer without effectively transcribing the piece.
 *
 * So a track may declare its progression. Everything downstream -- generated
 * melodies, and later any layer that wants to follow the harmony -- reads it
 * from here rather than guessing. This is also what makes recombination SAFE:
 * variants written against a declared progression cannot clash with it, because
 * they are constrained to it by construction.
 */

/** Chord quality -> semitone offsets from the root. */
const QUALITIES: Record<string, number[]> = {
  // Triads are enough for this game's harmony; sevenths can be added as data
  // without touching any consumer.
  '': [0, 4, 7], // major
  m: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus4: [0, 5, 7],
  7: [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
};

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface Chord {
  /** As written, e.g. "Am". Kept for error messages and tooling. */
  name: string;
  /** Semitone classes (0-11) the chord contains; octave-free on purpose. */
  pitchClasses: number[];
  /** The root's pitch class, which generators weight most heavily. */
  root: number;
}

/**
 * "Am", "F", "G7", "C#m", "Bbsus4" -> a chord, or null if unparseable.
 *
 * Octave-free: a chord is a set of pitch CLASSES, and the layer using it
 * chooses the register. Baking octaves in here would mean re-authoring the
 * progression for every voice that plays it.
 */
export function parseChord(name: string): Chord | null {
  const m = /^([A-G])([#b]?)(.*)$/.exec(name);
  if (!m) return null;
  const [, letter, accidental, quality] = m;
  if (!(quality in QUALITIES)) return null;
  const root = (LETTERS[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12;
  return {
    name,
    root,
    pitchClasses: QUALITIES[quality].map((s) => (root + s) % 12),
  };
}

/**
 * The pitch class of a note name, for checking a written note against a chord.
 * Returns null for a rest and NaN for nonsense, mirroring noteToHz.
 */
export function pitchClassOf(note: string): number | null {
  const hz = noteToHz(note);
  if (hz === null) return null;
  if (Number.isNaN(hz)) return NaN;
  // 12 * log2(f / 440) semitones from A4, which is pitch class 9.
  const semis = Math.round(12 * Math.log2(hz / 440));
  return ((semis + 9) % 12 + 12) % 12;
}

/**
 * Every note name in `octave` (inclusive) whose pitch class is in the chord,
 * lowest first. This is the generator's palette: choosing only from here is what
 * makes a generated line consonant by construction rather than by luck.
 */
export function chordTones(chord: Chord, lowOctave: number, highOctave: number): string[] {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const out: string[] = [];
  for (let oct = lowOctave; oct <= highOctave; oct++) {
    for (let pc = 0; pc < 12; pc++) {
      if (chord.pitchClasses.includes(pc)) out.push(`${NAMES[pc]}${oct}`);
    }
  }
  return out;
}
