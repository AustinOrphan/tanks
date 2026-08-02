import tracksJson from './data/music-tracks.json';
import { parseChord } from './chords';
import { noteToHz, REST } from './notes';

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

export { noteToHz, REST };

/** Audible bounds. Outside these a "note" is either inaudible or a typo. */
const MIN_HZ = 16;
const MAX_HZ = 12000;

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

/** A layer either plays authored notes or generates them over the harmony. */
export interface MusicLayerDef {
  voice: VoiceName;
  /** Authored: one entry per step, null being a rest. */
  notes: Array<number | null> | null;
  /** Generated: rebuilt each cycle from the track's chords, so it never repeats. */
  generate: { density: number; lowOctave: number; highOctave: number; seedSalt: number } | null;
  /**
   * Plays only when the mix intensity is at least this. 0 means always. This is
   * what lets the music thin out and build with the round instead of running
   * flat, and it is why the arrangement can be sparse without being empty.
   */
  intensity: number;
}

export interface MusicTrackDef {
  id: string;
  stepSeconds: number;
  /** Steps per bar. Required once a track declares chords. */
  barSteps: number;
  /** One chord name per bar, e.g. ["Am","F","G","E"]. Empty when unharmonised. */
  chords: string[];
  tracks: MusicLayerDef[];
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
    // hasOwn, NOT `in`: `in` walks the prototype chain, so "constructor",
    // "toString", "valueOf" and "hasOwnProperty" all validated as voices and
    // then threw a non-finite AudioParam error from inside the scheduler --
    // exactly the "boot failure, not a runtime throw" contract this file claims.
    if (typeof voice !== 'string' || !Object.hasOwn(VOICES, voice)) {
      fail(`${tAt}.voice`, `must be one of ${Object.keys(VOICES).join(', ')}, got ${JSON.stringify(voice)}`);
    }
    const hasNotes = t.notes !== undefined;
    const hasGenerate = t.generate !== undefined;
    if (hasNotes === hasGenerate) {
      fail(tAt, 'must have exactly one of "notes" or "generate"');
    }

    let generate: MusicLayerDef['generate'] = null;
    if (hasGenerate) {
      const g = t.generate;
      if (!isRecord(g)) fail(`${tAt}.generate`, 'must be an object');
      const density = g.density;
      if (typeof density !== 'number' || !(density > 0) || density > 1) {
        fail(`${tAt}.generate.density`, `must be within (0, 1], got ${JSON.stringify(density)}`);
      }
      for (const k of ['lowOctave', 'highOctave'] as const) {
        const v = g[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 8) {
          fail(`${tAt}.generate.${k}`, `must be an integer octave 0-8, got ${JSON.stringify(v)}`);
        }
      }
      if ((g.highOctave as number) < (g.lowOctave as number)) {
        fail(`${tAt}.generate`, 'highOctave must not be below lowOctave');
      }
      const salt = g.seedSalt ?? 0;
      if (typeof salt !== 'number' || !Number.isFinite(salt)) {
        fail(`${tAt}.generate.seedSalt`, `must be a number, got ${JSON.stringify(salt)}`);
      }
      generate = {
        density: density as number,
        lowOctave: g.lowOctave as number,
        highOctave: g.highOctave as number,
        seedSalt: salt as number,
      };
    }

    if (hasNotes && (!Array.isArray(t.notes) || t.notes.length === 0)) {
      fail(`${tAt}.notes`, 'must be a non-empty array');
    }
    const notes = !hasNotes ? null : (t.notes as unknown[]).map((n: unknown, ni: number) => {
      if (typeof n !== 'string') {
        fail(`${tAt}.notes[${ni}]`, `must be a string, got ${JSON.stringify(n)}`);
      }
      const hz = noteToHz(n);
      // NaN, not null: null is a rest, which is legitimate.
      if (hz !== null && Number.isNaN(hz)) {
        fail(`${tAt}.notes[${ni}]`, `is not a note name or a rest, got ${JSON.stringify(n)}`);
      }
      // Every other field is range-checked; pitch was not. 'A44' is a plausible
      // fat-finger for 'A4' and rendered as inaudible silence with no error at
      // all; 'C9999' reached Infinity and threw from inside the scheduler.
      if (hz !== null && (hz < MIN_HZ || hz > MAX_HZ)) {
        fail(
          `${tAt}.notes[${ni}]`,
          `is ${hz.toFixed(2)}Hz, outside the audible ${MIN_HZ}-${MAX_HZ}Hz range (got ${JSON.stringify(n)})`,
        );
      }
      return hz;
    });
    const intensity = t.intensity ?? 0;
    // Number.isFinite, not just typeof: NaN is a number and fails BOTH `< 0` and
    // `> 1`, so it validated and then silently made the layer always audible
    // (every `NaN > intensity` comparison is false).
    if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
      fail(`${tAt}.intensity`, `must be within [0, 1], got ${JSON.stringify(intensity)}`);
    }
    return { voice: voice as VoiceName, notes, generate, intensity: intensity as number };
  });
  const chordsRaw = raw.chords ?? [];
  if (!Array.isArray(chordsRaw)) fail(`${at}.chords`, 'must be an array of chord names');
  const chords = chordsRaw.map((c: unknown, ci: number) => {
    if (typeof c !== 'string' || !parseChord(c)) {
      fail(`${at}.chords[${ci}]`, `is not a chord name, got ${JSON.stringify(c)}`);
    }
    return c as string;
  });
  const barSteps = raw.barSteps ?? 0;
  if (typeof barSteps !== 'number' || !Number.isInteger(barSteps) || barSteps < 0) {
    fail(`${at}.barSteps`, `must be a non-negative integer, got ${JSON.stringify(barSteps)}`);
  }
  // A generated layer cannot exist without harmony to follow, and harmony cannot
  // be placed in time without a bar length. Caught here rather than surfacing as
  // an empty melody at runtime.
  if (tracks.some((t) => t.generate) && (chords.length === 0 || barSteps === 0)) {
    fail(at, 'has a generated layer but no chords/barSteps to generate against');
  }
  // A context change lands when `stepsIntoCycle % barSteps === 0`, which is only
  // a real downbeat if the bar divides every authored layer -- the cycle is the
  // LCM of the layer lengths, so a layer that is not a whole number of bars puts
  // the last "bar" of the cycle short and lands the change inside it. Nothing
  // else enforces this: it held for 31 of 31 shipped tracks by authoring habit
  // alone, and a track that broke it would go off-downbeat silently, with no
  // test able to see it. Zero means "no bar declared" and is checked above.
  for (const t of tracks) {
    if (barSteps > 0 && t.notes && t.notes.length % (barSteps as number) !== 0) {
      fail(
        `${at}.tracks`,
        `has a layer of ${t.notes.length} notes, which is not a whole number of ` +
          `${barSteps}-step bars -- a suite change would land off the downbeat`,
      );
    }
  }
  return { id, stepSeconds, barSteps: barSteps as number, chords, tracks };
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
/**
 * Deep: a shallow freeze left the note ARRAYS mutable, and the module cache
 * means one test mutating them in place leaks into every other test file.
 */
function deepFreeze(tracks: MusicTrackDef[]): readonly MusicTrackDef[] {
  for (const t of tracks) {
    for (const layer of t.tracks) {
      if (layer.notes) Object.freeze(layer.notes);
      // generate{} too: review found this function reintroduced exactly the bug
      // its own comment documents, leaving the spec object and the chord list
      // mutable across the module cache.
      if (layer.generate) Object.freeze(layer.generate);
      Object.freeze(layer);
    }
    Object.freeze(t.chords);
    Object.freeze(t.tracks);
    Object.freeze(t);
  }
  return Object.freeze(tracks);
}

export const MUSIC_TRACKS: readonly MusicTrackDef[] = deepFreeze(parseAll(tracksJson));

export function trackById(id: string): MusicTrackDef | null {
  return MUSIC_TRACKS.find((t) => t.id === id) ?? null;
}

/** Exposed for the validator's own negative controls. */
export const __parseAllForTests = parseAll;
