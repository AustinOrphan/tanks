import { MUSIC_TRACKS, type MusicTrackDef } from './music-data';
import { parseChord, type Chord } from './chords';
import suitesJson from './data/music-suites.json';

/**
 * Suites: sets of interchangeable tracks, and the joins between sets.
 *
 * Inside a suite the members share key, tempo, bar length and progression, so
 * any member may follow any other with nothing to reconcile -- measured on the
 * arena family, every join lands at a sample step of 0. ACROSS suites those very
 * things differ, and that is the whole difficulty: key and tempo are what make a
 * cross-suite join hard. Everything else is instrumentation and does not fight.
 *
 * See docs/superpowers/specs/2026-08-02-music-suites-design.md, which also
 * records the two transition strategies not yet built (`outro`, `bridge`) so
 * they can be tried rather than rediscovered.
 */

const FILE = 'music-suites.json';

/** How a suite is entered from whatever was playing before it. */
export type TransitionKind = 'dominant' | 'outro' | 'bridge';

export interface SuiteDef {
  id: string;
  /** The suite's home chord. The dominant transition is derived from this. */
  key: string;
  stepSeconds: number;
  transition: TransitionKind;
  members: string[];
}

function fail(path: string, message: string): never {
  throw new Error(`${FILE}: ${path} ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const KINDS: TransitionKind[] = ['dominant', 'outro', 'bridge'];

function parseSuite(raw: unknown, i: number): SuiteDef {
  const at = `[${i}]`;
  if (!isRecord(raw)) fail(at, 'must be an object');
  const id = raw.id;
  if (typeof id !== 'string' || !id) fail(`${at}.id`, `must be a non-empty string, got ${JSON.stringify(id)}`);
  const key = raw.key;
  if (typeof key !== 'string' || !parseChord(key)) {
    fail(`${at}.key`, `must be a chord name, got ${JSON.stringify(key)}`);
  }
  const stepSeconds = raw.stepSeconds;
  if (typeof stepSeconds !== 'number' || !Number.isFinite(stepSeconds) || stepSeconds <= 0) {
    fail(`${at}.stepSeconds`, `must be a positive number, got ${JSON.stringify(stepSeconds)}`);
  }
  const transition = raw.transition ?? 'dominant';
  if (typeof transition !== 'string' || !KINDS.includes(transition as TransitionKind)) {
    fail(`${at}.transition`, `must be one of ${KINDS.join(', ')}, got ${JSON.stringify(transition)}`);
  }
  if (transition !== 'dominant') {
    // Declared in the design doc, deliberately not built yet. Failing loudly is
    // better than silently behaving like `dominant` and being blamed for it.
    fail(`${at}.transition`, `"${transition}" is designed but not implemented yet (see the suites design doc)`);
  }
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    fail(`${at}.members`, 'must be a non-empty array of track ids');
  }
  const members = raw.members.map((m: unknown, mi: number) => {
    if (typeof m !== 'string') fail(`${at}.members[${mi}]`, `must be a track id, got ${JSON.stringify(m)}`);
    return m;
  });

  // Members must actually be interchangeable. A member that disagrees on tempo,
  // bar length or progression cannot join its siblings seamlessly, and finding
  // that out by ear later is exactly what this check exists to prevent.
  const defs = members.map((m, mi) => {
    const t = MUSIC_TRACKS.find((x) => x.id === m);
    if (!t) fail(`${at}.members[${mi}]`, `names no such track: ${JSON.stringify(m)}`);
    return t;
  });
  const first = defs[0];
  defs.forEach((t, mi) => {
    if (t.stepSeconds !== stepSeconds) {
      fail(`${at}.members[${mi}]`, `"${t.id}" runs at ${t.stepSeconds}s per step, the suite at ${stepSeconds}s`);
    }
    if (t.barSteps !== first.barSteps) {
      fail(`${at}.members[${mi}]`, `"${t.id}" has ${t.barSteps}-step bars, "${first.id}" has ${first.barSteps}`);
    }
    if (t.chords.join(',') !== first.chords.join(',')) {
      fail(`${at}.members[${mi}]`, `"${t.id}" plays ${t.chords.join('-')}, "${first.id}" plays ${first.chords.join('-')}`);
    }
  });
  return { id, key, stepSeconds, transition: transition as TransitionKind, members };
}

function parseAll(raw: unknown): SuiteDef[] {
  if (!Array.isArray(raw)) fail('root', 'must be an array of suites');
  const parsed = raw.map(parseSuite);
  const ids = new Set<string>();
  for (const s of parsed) {
    if (ids.has(s.id)) fail(`[${s.id}]`, 'duplicate id');
    ids.add(s.id);
  }
  return parsed;
}

export const SUITES: readonly SuiteDef[] = Object.freeze(
  parseAll(suitesJson).map((s) => Object.freeze({ ...s, members: Object.freeze([...s.members]) as string[] })),
);

export function suiteById(id: string): SuiteDef | null {
  return SUITES.find((s) => s.id === id) ?? null;
}

export function membersOf(suite: SuiteDef): MusicTrackDef[] {
  return suite.members
    .map((m) => MUSIC_TRACKS.find((t) => t.id === m))
    .filter((t): t is MusicTrackDef => !!t);
}

/**
 * The chord that leads INTO a suite: the fifth degree of its key, as a major
 * triad regardless of whether the key is major or minor.
 *
 * That is the whole trick. A dominant sounds unfinished and pulls toward its
 * home chord, so a bar of it before the switch makes the new key sound arrived
 * at rather than cut to. Major even in a minor key -- the raised third is the
 * leading tone, and it is what does the pulling; a minor v has no such pull.
 */
export function dominantOf(suite: SuiteDef): Chord {
  const home = parseChord(suite.key);
  if (!home) fail(`[${suite.id}].key`, `is not a chord name: ${JSON.stringify(suite.key)}`);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const fifth = (home.root + 7) % 12;
  const chord = parseChord(NAMES[fifth]); // no quality suffix = major
  if (!chord) fail(`[${suite.id}]`, `could not build a dominant for ${suite.key}`);
  return chord;
}
