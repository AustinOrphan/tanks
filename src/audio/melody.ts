import { chordTones, pitchClassOf, type Chord } from './chords';

/**
 * A melody, generated over a declared progression.
 *
 * The failure mode of procedural melody is not wrong notes -- constraining the
 * palette to chord tones makes wrong notes impossible -- it is AIMLESSNESS: a
 * sequence of individually-consonant pitches with no shape, which sounds like a
 * random arpeggiator and is worse than a short loop.
 *
 * Three constraints do most of the work of making it sound composed:
 *
 *   - RHYTHM comes from templates, not per-step coin flips. Real melodies place
 *     notes on strong beats and syncopate deliberately; independent random
 *     placement gives an even mush with no pulse.
 *   - CONTOUR prefers small intervals. A line that leaps freely around the chord
 *     is an arpeggio; one that mostly steps has direction.
 *   - PHRASE SHAPE gives the line an arc: it drifts up over the first half and
 *     resolves down onto the root at the end, so the cycle has a beginning and
 *     an end rather than being a texture.
 *
 * Deterministic: the same seed and progression give the same melody, which is
 * what lets a test assert anything and what keeps a session reproducible.
 */

export interface MelodySpec {
  /** Fraction of steps that sound, before rhythm weighting. 0.2-0.5 is musical. */
  density: number;
  /** Register the line sits in. */
  lowOctave: number;
  highOctave: number;
  /** Distinguishes two generated layers in the same piece. */
  seedSalt?: number;
}

/** Rhythm templates over one bar, as step offsets. Chosen per bar. */
export const RHYTHMS: number[][] = [
  [0, 4, 8, 12], // four on the floor: the plainest, most grounded
  [0, 3, 6, 8, 11, 14], // syncopated
  [0, 2, 4, 8, 10, 12], // busy front half, space at the end
  [2, 6, 10, 14], // entirely off the beat -- urgent
  [0, 8], // sparse: gives the ear a rest between busier bars
];

/**
 * Scramble before use. The caller's seed is a COUNTER (cycle number plus a layer
 * index), and raw xorshift32 is strongly autocorrelated across consecutive
 * seeds: measured over seeds 0..63, the lag-1 autocorrelation of the first draw
 * is -0.18 unscrambled and 0.014 scrambled.
 *
 * HONEST LIMIT, corrected after review: an earlier version of this comment
 * claimed two cycles of melody correlating at 0.90 without the scramble. That
 * number is not reproducible -- the worst consecutive-cycle melody similarity
 * measured over 2000 pairs is 0.667 unscrambled and 0.700 scrambled, i.e. the
 * scramble does not measurably improve the end-to-end melody metric. It is kept
 * because a counter feeding a raw PRNG is a latent trap, not because it fixed an
 * observed musical problem.
 */
function scramble(seed: number): number {
  let x = (seed | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

function xorshift(seed: number): () => number {
  let x = scramble(seed) || 0x2545f491;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

/**
 * Generate `bars` bars of melody as note names, one entry per step.
 *
 * `chords` is one chord per bar and is what makes every note safe: the palette
 * is rebuilt per bar, so the line follows the harmony without knowing anything
 * about it.
 */
export function generateMelody(
  chords: Chord[],
  barSteps: number,
  spec: MelodySpec,
  seed: number,
): string[] {
  const rnd = xorshift(seed + (spec.seedSalt ?? 0) * 7919);
  const notes: string[] = new Array(chords.length * barSteps).fill('-');
  let previous: number | null = null; // index into the current palette

  chords.forEach((chord, bar) => {
    const palette = chordTones(chord, spec.lowOctave, spec.highOctave);
    if (palette.length === 0) return;
    const template = RHYTHMS[Math.floor(rnd() * RHYTHMS.length) % RHYTHMS.length];
    // Density thins the template rather than replacing it, so the pulse the
    // template establishes survives.
    const hits = template.filter((offset) => offset < barSteps && rnd() < spec.density * 2);

    // The arc: rise through the first half of the piece, fall back for the end.
    const throughPiece = bar / Math.max(1, chords.length - 1);
    const target = Math.round((0.25 + 0.5 * Math.sin(throughPiece * Math.PI)) * (palette.length - 1));

    for (const offset of hits) {
      let index: number;
      if (previous === null) {
        index = target;
      } else {
        // Contour: mostly step, occasionally leap. Pull toward the arc's target
        // so the line has somewhere to go rather than wandering.
        const drift = rnd() < 0.75 ? (rnd() < 0.5 ? -1 : 1) : (rnd() < 0.5 ? -2 : 2);
        const pull = Math.sign(target - previous);
        index = previous + drift + (rnd() < 0.4 ? pull : 0);
      }
      index = Math.max(0, Math.min(palette.length - 1, index));
      notes[bar * barSteps + offset] = palette[index];
      previous = index;
    }
  });

  // Resolve: the last sounding note becomes the root of ITS OWN bar, so the
  // cycle lands rather than stopping.
  //
  // "Its own bar" is the whole correctness of this step. An earlier version used
  // the LAST chord's root regardless of where the note fell, and when the final
  // bar drew no hits it stamped that root over an earlier bar -- a note that
  // clashes with the chord underneath it. Measured before the fix: 190 clashing
  // notes across 20,000 seeds, and 8% of cycles on the shipped pluck layer,
  // which is roughly once every two minutes of play. The whole safety argument
  // for generated melody is that a note cannot clash with its bar, and this was
  // the one place that could violate it.
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i] === '-') continue;
    const bar = Math.min(Math.floor(i / barSteps), chords.length - 1);
    const chord = chords[bar];
    const palette = chordTones(chord, spec.lowOctave, spec.highOctave);
    const wanted = noteNameOfClass(chord.root);
    // Exact pitch-class match, not startsWith: 'C' prefix-matches 'C#4', which
    // only failed to bite because chordTones happens to emit naturals first.
    const rootName = palette.find((n) => pitchClassOf(n) === chord.root);
    if (rootName) notes[i] = rootName;
    void wanted;
    break;
  }
  return notes;
}

const CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteNameOfClass(pc: number): string {
  return CLASS_NAMES[((pc % 12) + 12) % 12];
}
