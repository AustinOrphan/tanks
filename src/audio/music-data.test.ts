import { describe, it, expect } from 'vitest';
import {
  noteToHz,
  trackById,
  MUSIC_TRACKS,
  VOICES,
  __parseAllForTests as parseAll,
} from './music-data';

describe('noteToHz', () => {
  it('anchors on A4 = 440, the definition everything else derives from', () => {
    expect(noteToHz('A4')).toBeCloseTo(440, 9);
  });

  it('halves per octave down and doubles per octave up', () => {
    expect(noteToHz('A3')).toBeCloseTo(220, 9);
    expect(noteToHz('A2')).toBeCloseTo(110, 9);
    expect(noteToHz('A1')).toBeCloseTo(55, 9);
    expect(noteToHz('A5')).toBeCloseTo(880, 9);
  });

  it('numbers octaves from C, not from A -- the off-by-one that sounds plausible', () => {
    // In scientific pitch notation the octave increments at C. So B3 and C4 are
    // ONE semitone apart, while A3 and A4 are twelve. An implementation that
    // increments at A puts every note below C an octave out, which is only
    // audible as "the bass line is wrong" long after the fact.
    const b3 = noteToHz('B3')!;
    const c4 = noteToHz('C4')!;
    expect(c4 / b3).toBeCloseTo(Math.pow(2, 1 / 12), 9);
    expect(c4).toBeCloseTo(261.625565, 5); // middle C
    expect(noteToHz('C1')).toBeCloseTo(32.703196, 5);
  });

  it('reads sharps and flats, and they agree enharmonically', () => {
    expect(noteToHz('A#4')).toBeCloseTo(466.163762, 5);
    expect(noteToHz('Bb4')).toBeCloseTo(noteToHz('A#4')!, 9);
    expect(noteToHz('Db3')).toBeCloseTo(noteToHz('C#3')!, 9);
  });

  it('treats "-" as a rest, and rejects anything that is not a note', () => {
    expect(noteToHz('-')).toBeNull();
    // Population: the plausible-looking mistakes. NaN (not null) so the
    // validator can tell "rest" from "nonsense".
    for (const junk of ['H4', 'A', '4A', 'A4b', 'Ax4', '', 'A#', 'A4.5']) {
      expect(Number.isNaN(noteToHz(junk)), junk).toBe(true);
    }
  });
});

describe('the shipped track data', () => {
  it('loads, and every track names voices that exist', () => {
    expect(MUSIC_TRACKS.length).toBeGreaterThan(0);
    for (const t of MUSIC_TRACKS) {
      expect(t.stepSeconds, t.id).toBeGreaterThan(0);
      expect(t.tracks.length, t.id).toBeGreaterThan(0);
      for (const layer of t.tracks) {
        expect(Object.keys(VOICES), `${t.id}/${layer.voice}`).toContain(layer.voice);
        // Exactly one source of notes: authored or generated, never both.
        expect(Boolean(layer.notes) !== Boolean(layer.generate), t.id).toBe(true);
        if (!layer.notes) continue;
        expect(layer.notes.length).toBeGreaterThan(0);
        // Every entry is either a real frequency or a rest -- never NaN.
        for (const n of layer.notes) expect(n === null || Number.isFinite(n)).toBe(true);
      }
    }
  });

  // NOTE ON WHAT IS *NOT* TESTED HERE. Earlier versions asserted the arena
  // track's layer lengths and its chord voicing. Both broke the moment the music
  // was rewritten -- correctly, because the piece changed, not because anything
  // regressed. Musical content is DATA and belongs with the repo's other
  // "feel, not measurement" numbers: pinning it makes every edit a test edit and
  // teaches nothing. What IS pinned below are the properties whose failure is a
  // BUG rather than a change of mind -- a layer that can never sound, or a tempo
  // typo that makes the loop a fraction of a second long.

  it('gives every layer at least one sounding note', () => {
    // An all-rests layer is dead weight and almost always a typo: it costs a
    // cursor and produces nothing, and nothing else would ever report it.
    for (const t of MUSIC_TRACKS) {
      for (const [i, layer] of t.tracks.entries()) {
        if (!layer.notes) continue; // generated layers have no authored notes
        const sounding = layer.notes.filter((n) => n !== null).length;
        expect(sounding, `${t.id}.tracks[${i}] (${layer.voice}) is all rests`).toBeGreaterThan(0);
      }
    }
  });

  it('loops over a sane span, so a stepSeconds typo cannot ship', () => {
    // A misplaced decimal is the realistic failure: 0.015 instead of 0.15 makes
    // the piece a one-second chirp, and 15 makes each note last a quarter minute.
    for (const t of MUSIC_TRACKS) {
      const authored = t.tracks.filter((l) => l.notes);
      const longest = Math.max(
        ...(authored.length ? authored.map((l) => l.notes!.length) : [t.barSteps * t.chords.length]),
      );
      const seconds = longest * t.stepSeconds;
      expect(seconds, `${t.id} loops in ${seconds}s`).toBeGreaterThan(2);
      expect(seconds, `${t.id} loops in ${seconds}s`).toBeLessThan(120);
    }
  });

  it('trackById returns null for an unknown id rather than throwing', () => {
    expect(trackById('no-such-track')).toBeNull();
  });
});

describe('the validator refuses bad data, naming the path', () => {
  const good = () => [
    { id: 'ok', stepSeconds: 1, tracks: [{ voice: 'bass', notes: ['A1', '-'] }] },
  ];

  it('accepts the good shape', () => {
    expect(parseAll(good())).toHaveLength(1);
  });

  // Population: every field the format has, one negative control each. A guard
  // is worth what its own tests prove.
  const cases: Array<[string, unknown, string]> = [
    ['root is not an array', { id: 'x' }, 'root'],
    ['entry is not an object', [42], '[0]'],
    ['missing id', [{ stepSeconds: 1, tracks: [] }], '[0].id'],
    ['empty id', [{ id: '', stepSeconds: 1, tracks: [] }], '[0].id'],
    ['stepSeconds zero', [{ id: 'x', stepSeconds: 0, tracks: [] }], '[0].stepSeconds'],
    ['stepSeconds negative', [{ id: 'x', stepSeconds: -1, tracks: [] }], '[0].stepSeconds'],
    ['stepSeconds not a number', [{ id: 'x', stepSeconds: '1', tracks: [] }], '[0].stepSeconds'],
    ['tracks empty', [{ id: 'x', stepSeconds: 1, tracks: [] }], '[0].tracks'],
    [
      'unknown voice',
      [{ id: 'x', stepSeconds: 1, tracks: [{ voice: 'tuba', notes: ['A1'] }] }],
      '[0].tracks[0].voice',
    ],
    [
      'notes empty',
      [{ id: 'x', stepSeconds: 1, tracks: [{ voice: 'bass', notes: [] }] }],
      '[0].tracks[0].notes',
    ],
    [
      'note is not a string',
      [{ id: 'x', stepSeconds: 1, tracks: [{ voice: 'bass', notes: [55] }] }],
      '[0].tracks[0].notes[0]',
    ],
    [
      'note is not a note name',
      [{ id: 'x', stepSeconds: 1, tracks: [{ voice: 'bass', notes: ['H2'] }] }],
      '[0].tracks[0].notes[0]',
    ],
  ];

  for (const [name, input, path] of cases) {
    it(`rejects: ${name}`, () => {
      let message = '';
      try {
        parseAll(input);
        throw new Error('SHOULD HAVE THROWN');
      } catch (e) {
        message = String(e);
      }
      expect(message).not.toContain('SHOULD HAVE THROWN');
      // The path is the point: "something is wrong" is not a usable error when
      // the file is a wall of note names.
      expect(message, name).toContain(path);
      expect(message, name).toContain('music-tracks.json');
    });
  }

  it('rejects NaN intensity, which validated and then played always', () => {
    // NaN is a number and fails both range comparisons, so it slipped through --
    // and at runtime `NaN > intensity` is false, so the layer sounded on every
    // step regardless of the mix.
    const bad = [{ id: 'x', stepSeconds: 1, tracks: [{ voice: 'bass', notes: ['A1'], intensity: NaN }] }];
    expect(() => parseAll(bad)).toThrow(/intensity/);
  });

  it('rejects a layer that is not a whole number of bars, and accepts one that is', () => {
    // The bar-aligned context change reduces to `stepsIntoCycle % barSteps === 0`,
    // which only names a downbeat if the bar divides every authored layer. This
    // held for 31 of 31 shipped tracks by authoring habit and nothing checked it,
    // so a new track could send every screen change off the downbeat silently.
    const ragged = [{
      id: 'ragged', stepSeconds: 0.5, barSteps: 3, chords: ['Am'],
      tracks: [{ voice: 'bass', notes: ['A1', 'A1', 'A1', 'A1', 'A1', 'A1', 'A1', 'A1'], intensity: 0 }],
    }];
    expect(() => parseAll(ragged)).toThrow(/whole number of 3-step bars/);
    // The negative control: the SAME track with a bar that does divide 8 must
    // parse, so the rule is rejecting raggedness and not simply everything.
    const even = [{ ...ragged[0], barSteps: 4 }];
    expect(() => parseAll(even)).not.toThrow();
  });

  it('accepts every shipped track under the bar-divides-layer rule', () => {
    // Recomputed rather than asserted as prose: this is the invariant the bar
    // predicate in music.ts depends on, over the whole shipped population.
    const offenders = MUSIC_TRACKS.filter((t) =>
      t.barSteps > 0 && t.tracks.some((l) => l.notes && l.notes.length % t.barSteps !== 0),
    ).map((t) => t.id);
    expect(offenders, 'a shipped track is not a whole number of bars').toEqual([]);
    expect(MUSIC_TRACKS.length, 'the shipped track population changed').toBe(31);
  });

  it('freezes the WHOLE track, including chords and generate specs', () => {
    // A shallow freeze let one test mutate shipped data in place and leak it to
    // every other file through the module cache.
    const t = MUSIC_TRACKS[0];
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.tracks)).toBe(true);
    expect(Object.isFrozen(t.chords), 'chords[]').toBe(true);
    for (const layer of t.tracks) {
      expect(Object.isFrozen(layer)).toBe(true);
      if (layer.notes) expect(Object.isFrozen(layer.notes), 'notes[]').toBe(true);
      if (layer.generate) expect(Object.isFrozen(layer.generate), 'generate{}').toBe(true);
    }
  });

  it('rejects pitches outside the audible band, naming the path', () => {
    // The range guard's negative control, which review found missing -- the one
    // check in this file whose failure mode was untested, against the module's
    // own stated contract. 'A44' is the realistic fat-finger; 'C-2' is below
    // hearing.
    for (const [note, why] of [['A44', 'a typo for A4'], ['C-2', 'subsonic']] as const) {
      const bad = [{ id: 'x', stepSeconds: 1, tracks: [{ voice: 'bass', notes: [note] }] }];
      let message = '';
      try {
        parseAll(bad);
        throw new Error('SHOULD HAVE THROWN');
      } catch (e) {
        message = String(e);
      }
      expect(message, why).toContain('outside the audible');
      expect(message, why).toContain('[0].tracks[0].notes[0]');
    }
  });

  it('rejects duplicate ids, which would make trackById silently ambiguous', () => {
    const dup = [...good(), ...good()];
    expect(() => parseAll(dup)).toThrow(/duplicate id/);
  });
});
