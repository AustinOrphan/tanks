import { describe, it, expect } from 'vitest';
import {
  __parseAllForTests,
  SUITES,
  suiteById,
  membersOf,
  dominantOf,
  keyAffinity,
  rankCandidates,
  pickNextSuite,
  type SuiteDef,
} from './suites';
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

describe('keyAffinity', () => {
  it('tiers keys the way the selection policy needs', () => {
    // Table-driven over the relations that matter; each row names its tier.
    const cases: Array<[string, string, number, string]> = [
      ['Am', 'Am', 4, 'same key'],
      ['C', 'C', 4, 'same key, major'],
      ['Am', 'C', 2, 'relative major'],
      ['C', 'Am', 2, 'relative minor'],
      ['Am', 'Em', 2, 'dominant minor'],
      ['Am', 'Dm', 2, 'subdominant minor'],
      ['C', 'G', 2, 'dominant major'],
      ['Am', 'A', 1, 'parallel major'],
      ['A', 'Am', 1, 'parallel minor'],
      ['Am', 'Ebm', 0, 'a tritone away: excluded'],
      ['Am', 'Bm', 0, 'a tone away: excluded'],
      ['C', 'F#', 0, 'tritone major: excluded'],
    ];
    for (const [a, b, want, label] of cases) {
      expect(keyAffinity(a, b), `${a} -> ${b} (${label})`).toBe(want);
    }
  });
});

describe('rankCandidates / pickNextSuite', () => {
  const mk = (id: string, key: string, stepSeconds: number): SuiteDef => ({
    id, key, stepSeconds, transition: 'dominant', members: [],
  });

  it('excludes a tempo gap beyond 20% no matter how related the key', () => {
    // The lesson of the siege join: 47% slower in the SAME related key still
    // jarred. Tempo is a hard limit, not a weight.
    const from = mk('a', 'Am', 0.15);
    const ranked = rankCandidates(from, [from, mk('slow', 'Am', 0.22), mk('ok', 'Dm', 0.16)]);
    expect(ranked.map((r) => r.suite.id)).toEqual(['ok']);
  });

  it('weights the same key above related keys', () => {
    const from = mk('a', 'Am', 0.15);
    const ranked = rankCandidates(from, [from, mk('rel', 'Dm', 0.15), mk('same', 'Am', 0.16)]);
    expect(ranked[0].suite.id).toBe('same');
    expect(ranked[0].weight).toBeGreaterThan(ranked[1].weight);
  });

  it('draws in proportion to weight, deterministically under an injected rnd', () => {
    const from = mk('a', 'Am', 0.15);
    const all = [from, mk('same', 'Am', 0.15), mk('rel', 'C', 0.15)];
    // Weights 4 and 2: a draw below 4/6 picks 'same', above it picks 'rel'.
    expect(pickNextSuite(from, all, () => 0.0)!.id).toBe('same');
    expect(pickNextSuite(from, all, () => 0.65)!.id).toBe('same');
    expect(pickNextSuite(from, all, () => 0.7)!.id).toBe('rel');
    // And over a seeded run, BOTH appear -- weighted, not winner-takes-all.
    let x = 42;
    const rnd = (): number => {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return ((x >>> 0) % 1000) / 1000;
    };
    const picks = new Set(Array.from({ length: 60 }, () => pickNextSuite(from, all, rnd)!.id));
    expect(picks).toEqual(new Set(['same', 'rel']));
  });

  it('returns null when nothing is compatible, rather than forcing a jar', () => {
    const from = mk('a', 'Am', 0.15);
    expect(pickNextSuite(from, [from, mk('far', 'Ebm', 0.15), mk('slow', 'Am', 0.5)], () => 0.5)).toBeNull();
  });

  it('the SHIPPED suites give assault at least one legal neighbour', () => {
    const assault = suiteById('assault')!;
    const ranked = rankCandidates(assault, SUITES);
    expect(ranked.length, 'assault has no compatible neighbour to chain into').toBeGreaterThan(0);
  });
});

describe('the suite validator', () => {
  it('rejects a suite whose members do not END on its dominant', () => {
    // The pickup entry plays the final bar first, trusting it to be the V. The
    // menu track ends on G, and G is not the dominant of A minor -- accepting
    // this suite would make every entry into it land on the wrong chord, a sour
    // join found by ear instead of at boot.
    const bad = [{ id: 'bad', key: 'Am', stepSeconds: 0.4, transition: 'dominant', members: ['menu'] }];
    expect(() => __parseAllForTests(bad)).toThrow(/dominant of Am/);
  });


  it('every shipped member exists in the track catalog', () => {
    for (const s of SUITES) {
      for (const m of s.members) {
        expect(MUSIC_TRACKS.map((t) => t.id), `${s.id} names ${m}`).toContain(m);
      }
    }
  });
});
