import { describe, it, expect } from 'vitest';
import { SUITES, suiteById, membersOf, dominantOf } from './suites';
import { parseChord } from './chords';
import { MUSIC_TRACKS } from './music-data';

describe('the shipped suites', () => {
  it('name real tracks that genuinely interchange', () => {
    expect(SUITES.length).toBeGreaterThan(0);
    for (const s of SUITES) {
      const members = membersOf(s);
      expect(members.length, s.id).toBe(s.members.length);
      // Interchangeability is not a vibe: it is these three fields agreeing.
      // Population: every member of every suite, against the first member.
      const first = members[0];
      for (const m of members) {
        expect(m.stepSeconds, `${s.id}/${m.id} tempo`).toBe(first.stepSeconds);
        expect(m.barSteps, `${s.id}/${m.id} bars`).toBe(first.barSteps);
        expect(m.chords, `${s.id}/${m.id} progression`).toEqual(first.chords);
      }
    }
  });

  it('gives every member the same cycle length, so any order joins cleanly', () => {
    // Differing cycle lengths would mean a switch either truncates a phrase or
    // waits an unpredictable time -- the seam the whole design exists to avoid.
    for (const s of SUITES) {
      const cycles = membersOf(s).map((m) => {
        const lens = m.tracks.map((l) => l.notes?.length ?? m.barSteps * m.chords.length);
        const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
        return lens.reduce((a, b) => (a / gcd(a, b)) * b, 1);
      });
      expect(new Set(cycles).size, `${s.id} cycles: ${cycles.join(',')}`).toBe(1);
    }
  });

  it('suiteById returns null for an unknown id rather than throwing', () => {
    expect(suiteById('nope')).toBeNull();
  });
});

describe('dominantOf', () => {
  it('is the MAJOR triad a fifth above the key, for every key a suite could use', () => {
    // The dominant is what makes a new key sound arrived at rather than cut to.
    // Major even in a minor key: the raised third is the leading tone, and that
    // is what does the pulling -- a minor v has no such pull.
    // Population: all 12 roots, minor and major.
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    for (let root = 0; root < 12; root++) {
      for (const quality of ['', 'm']) {
        const key = `${NAMES[root]}${quality}`;
        const suite = { id: 't', key, stepSeconds: 1, transition: 'dominant' as const, members: [] };
        const dom = dominantOf(suite);
        expect(dom.root, `dominant of ${key}`).toBe((root + 7) % 12);
        // Major triad: root, +4, +7.
        expect(dom.pitchClasses, `quality of the dominant of ${key}`).toEqual([
          (root + 7) % 12,
          (root + 11) % 12,
          (root + 2) % 12,
        ]);
        // And it contains the LEADING TONE of the key -- a semitone below home.
        expect(dom.pitchClasses, `leading tone into ${key}`).toContain((root + 11) % 12);
      }
    }
  });

  it('gives A major for an A minor suite, which is E', () => {
    // The concrete case, spelled out: the assault suite is in Am, so it is
    // entered through E major.
    const assault = suiteById('assault')!;
    expect(assault.key).toBe('Am');
    expect(dominantOf(assault).root).toBe(parseChord('E')!.root);
  });
});

describe('the suite validator', () => {
  it('every shipped member exists in the track catalog', () => {
    for (const s of SUITES) {
      for (const m of s.members) {
        expect(MUSIC_TRACKS.map((t) => t.id), `${s.id} names ${m}`).toContain(m);
      }
    }
  });
});
