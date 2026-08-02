import { describe, it, expect } from 'vitest';
import { parseChord, pitchClassOf, chordTones } from './chords';
import { generateMelody } from './melody';

const PROG = ['Am', 'F', 'G', 'E'].map((n) => parseChord(n)!);
const SPEC = { density: 0.4, lowOctave: 4, highOctave: 5 };

describe('parseChord', () => {
  it('reads the qualities the progressions use', () => {
    expect(parseChord('Am')!.pitchClasses).toEqual([9, 0, 4]); // A C E
    expect(parseChord('F')!.pitchClasses).toEqual([5, 9, 0]); // F A C
    expect(parseChord('G')!.pitchClasses).toEqual([7, 11, 2]); // G B D
    expect(parseChord('E')!.pitchClasses).toEqual([4, 8, 11]); // E G# B
  });

  it('handles accidentals and extended qualities', () => {
    expect(parseChord('C#m')!.root).toBe(1);
    expect(parseChord('Bb')!.root).toBe(10);
    expect(parseChord('G7')!.pitchClasses).toHaveLength(4);
    expect(parseChord('Dsus4')!.pitchClasses).toEqual([2, 7, 9]);
  });

  it('refuses nonsense rather than inventing a chord', () => {
    for (const junk of ['H', 'Am9b5', 'Amaj', '', 'xyz']) {
      expect(parseChord(junk), junk).toBeNull();
    }
  });
});

describe('chordTones', () => {
  it('lists only pitches of the chord, in the requested register', () => {
    const tones = chordTones(parseChord('Am')!, 4, 4);
    expect(tones).toEqual(['C4', 'E4', 'A4']);
    // And every one really is a chord tone -- this is the property the whole
    // generator leans on.
    for (const t of tones) expect(parseChord('Am')!.pitchClasses).toContain(pitchClassOf(t));
  });

  it('spans octaves without skipping any', () => {
    const tones = chordTones(parseChord('F')!, 3, 5);
    expect(tones.filter((t) => t.endsWith('3')).length).toBe(3);
    expect(tones.filter((t) => t.endsWith('5')).length).toBe(3);
  });
});

describe('generateMelody', () => {
  it('only ever writes notes from the CHORD of that bar', () => {
    // The whole safety argument: a generated line cannot clash, because the
    // palette is rebuilt per bar from the declared harmony. Population: every
    // sounding step of a 4-bar generation, checked against its own bar's chord.
    const notes = generateMelody(PROG, 16, SPEC, 12345);
    expect(notes).toHaveLength(64);
    let sounded = 0;
    notes.forEach((n, i) => {
      if (n === '-') return;
      sounded += 1;
      const chord = PROG[Math.floor(i / 16)];
      expect(chord.pitchClasses, `step ${i} played ${n} over ${chord.name}`).toContain(
        pitchClassOf(n),
      );
    });
    expect(sounded).toBeGreaterThan(6); // it actually produced a line
  });

  it('is deterministic per seed, and different seeds give different lines', () => {
    expect(generateMelody(PROG, 16, SPEC, 7)).toEqual(generateMelody(PROG, 16, SPEC, 7));
    expect(generateMelody(PROG, 16, SPEC, 7)).not.toEqual(generateMelody(PROG, 16, SPEC, 8));
  });

  it('decorrelates ADJACENT seeds, which is what the cycle counter produces', () => {
    // Seeds come from a counter (cycle number + layer index), not from anything
    // random. Raw xorshift32 from neighbouring seeds gave visibly similar early
    // output -- measured at 0.90 correlation between two cycles of melody that
    // should have been unrelated. Population: 12 consecutive seeds, every
    // adjacent pair.
    const lines = Array.from({ length: 12 }, (_, i) => generateMelody(PROG, 16, SPEC, 1000 + i));
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1];
      const b = lines[i];
      const same = a.filter((n, k) => n === b[k] && n !== '-').length;
      const sounding = Math.max(a.filter((n) => n !== '-').length, 1);
      // Some coincidence is fine -- the palette is small. Near-identity is not.
      expect(same / sounding, `seeds ${999 + i} and ${1000 + i}`).toBeLessThan(0.8);
    }
  });

  it('separates two layers of the same piece via seedSalt', () => {
    const a = generateMelody(PROG, 16, SPEC, 42);
    const b = generateMelody(PROG, 16, { ...SPEC, seedSalt: 1 }, 42);
    expect(a).not.toEqual(b);
  });

  it('places notes on a rhythmic GRID rather than scattering them', () => {
    // Independent per-step randomness gives an even mush with no pulse. The
    // templates are all built from even offsets or a consistent syncopation, so
    // a generated bar should never look like uniform noise: with 16 steps and a
    // handful of hits, they must fall on template positions.
    const TEMPLATE_POSITIONS = new Set([0, 2, 3, 4, 6, 8, 10, 11, 12, 14]);
    for (const seed of [1, 2, 3, 4, 5]) {
      const notes = generateMelody(PROG, 16, SPEC, seed);
      notes.forEach((n, i) => {
        if (n === '-') return;
        expect(TEMPLATE_POSITIONS, `seed ${seed} step ${i % 16}`).toContain(i % 16);
      });
    }
  });

  it('mostly STEPS rather than leaping, so the line has direction', () => {
    // An arpeggiator jumps around the chord; a melody moves. Measured over the
    // palette index, most intervals should be small.
    const notes = generateMelody(PROG, 16, SPEC, 99).filter((n) => n !== '-');
    const tones = chordTones(PROG[0], SPEC.lowOctave, SPEC.highOctave);
    const idx = notes.map((n) => tones.indexOf(n)).filter((i) => i >= 0);
    const jumps = idx.slice(1).map((v, i) => Math.abs(v - idx[i]));
    if (jumps.length >= 3) {
      const small = jumps.filter((j) => j <= 2).length;
      expect(small / jumps.length).toBeGreaterThan(0.6);
    }
  });

  it('RESOLVES onto the root, so the cycle lands instead of stopping', () => {
    // The clearest tell of a generated line is ending wherever the walk left it.
    for (const seed of [11, 22, 33, 44]) {
      const notes = generateMelody(PROG, 16, SPEC, seed);
      const last = [...notes].reverse().find((n) => n !== '-');
      if (!last) continue;
      expect(pitchClassOf(last), `seed ${seed} ended on ${last}`).toBe(PROG[PROG.length - 1].root);
    }
  });

  it('stays inside the requested register', () => {
    const notes = generateMelody(PROG, 16, { ...SPEC, lowOctave: 3, highOctave: 3 }, 5);
    for (const n of notes) {
      if (n !== '-') expect(n.endsWith('3'), n).toBe(true);
    }
  });
});
