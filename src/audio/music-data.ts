import tracksJson from './data/music-tracks.json';

/**
 * Composed music, as data.
 *
 * The generated bed (music.ts) closed the "no music at all" gap, but its content
 * lived as constants inside the scheduler -- composing meant editing scheduling
 * code, and the notes were written as raw Hz (`61.74` for a B1), which is
 * unreadable to anyone writing a tune.
 *
 * Tracks are now JSON, validated AT LOAD exactly as the sim's entity data is: a
 * bad edit is a boot failure naming the exact path, never a silently-wrong note.
 * The validator's own tests carry the negative controls that prove each check can
 * fail -- a guard is worth what its own tests prove.
 *
 * Only the NOTES are data. Timbre stays in code (`VOICES` below), so the file
 * stays about music rather than about DSP.
 */

const FILE = 'music-tracks.json';

/** Timbres a track may name. Each maps to an oscillator type + envelope shape. */
export const VOICES = {
  bass: { type: 'triangle' as OscillatorType, peak: 0.22, hold: 0.9 },
  drone: { type: 'sine' as OscillatorType, peak: 0.05, hold: 1.8 },
  pluck: { type: 'square' as OscillatorType, peak: 0.12, hold: 0.35 },
  /**
   * `hold` is in STEPS, so a pad sustains across a whole bar while the notes
   * above it move. Without a long-held voice every chord is a stab and the
   * piece has no harmony to sit on -- which is exactly how the first tracks
   * sounded.
   */
  pad: { type: 'sine' as OscillatorType, peak: 0.055, hold: 8 },
  /** Melody: long enough to sing, short enough to leave space. */
  lead: { type: 'triangle' as OscillatorType, peak: 0.1, hold: 1.6 },
  /**
   * Chord stabs. Square for bite and short enough to read as rhythm rather than
   * harmony -- a sustained chord is calming, a stabbed one is not, and that
   * difference is most of what separates arena music from menu music.
   */
  stab: { type: 'square' as OscillatorType, peak: 0.085, hold: 1.4 },
} as const;

export type VoiceName = keyof typeof VOICES;

export interface MusicTrackDef {
  id: string;
  stepSeconds: number;
  tracks: Array<{ voice: VoiceName; notes: Array<number | null> }>;
}

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

function fail(path: string, message: string): never {
  throw new Error(`${FILE}: ${path} ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTrack(raw: unknown, index: number): MusicTrackDef {
  const at = `[${index}]`;
  if (!isRecord(raw)) fail(at, 'must be an object');
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    fail(`${at}.id`, `must be a non-empty string, got ${JSON.stringify(id)}`);
  }
  const stepSeconds = raw.stepSeconds;
  if (typeof stepSeconds !== 'number' || !Number.isFinite(stepSeconds) || stepSeconds <= 0) {
    fail(`${at}.stepSeconds`, `must be a positive number, got ${JSON.stringify(stepSeconds)}`);
  }
  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    fail(`${at}.tracks`, 'must be a non-empty array');
  }
  const tracks = raw.tracks.map((t: unknown, ti: number) => {
    const tAt = `${at}.tracks[${ti}]`;
    if (!isRecord(t)) fail(tAt, 'must be an object');
    const voice = t.voice;
    if (typeof voice !== 'string' || !(voice in VOICES)) {
      fail(`${tAt}.voice`, `must be one of ${Object.keys(VOICES).join(', ')}, got ${JSON.stringify(voice)}`);
    }
    if (!Array.isArray(t.notes) || t.notes.length === 0) {
      fail(`${tAt}.notes`, 'must be a non-empty array');
    }
    const notes = t.notes.map((n: unknown, ni: number) => {
      if (typeof n !== 'string') {
        fail(`${tAt}.notes[${ni}]`, `must be a string, got ${JSON.stringify(n)}`);
      }
      const hz = noteToHz(n);
      // NaN, not null: null is a rest, which is legitimate.
      if (hz !== null && Number.isNaN(hz)) {
        fail(`${tAt}.notes[${ni}]`, `is not a note name or a rest, got ${JSON.stringify(n)}`);
      }
      return hz;
    });
    return { voice: voice as VoiceName, notes };
  });
  return { id, stepSeconds, tracks };
}

function parseAll(raw: unknown): MusicTrackDef[] {
  if (!Array.isArray(raw)) fail('root', 'must be an array of tracks');
  const parsed = raw.map(parseTrack);
  const ids = new Set<string>();
  for (const t of parsed) {
    if (ids.has(t.id)) fail(`[${t.id}]`, 'duplicate id');
    ids.add(t.id);
  }
  return parsed;
}

/** Validated at module load: a bad edit fails the boot, not a later note. */
export const MUSIC_TRACKS: readonly MusicTrackDef[] = Object.freeze(parseAll(tracksJson));

export function trackById(id: string): MusicTrackDef | null {
  return MUSIC_TRACKS.find((t) => t.id === id) ?? null;
}

/** Exposed for the validator's own negative controls. */
export const __parseAllForTests = parseAll;
