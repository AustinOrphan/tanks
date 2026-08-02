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

/** Where in the game a suite belongs. */
export type SuiteContext = 'menu' | 'arena' | 'victory' | 'defeat';

export const SUITE_CONTEXTS: SuiteContext[] = ['menu', 'arena', 'victory', 'defeat'];

export interface SuiteDef {
  id: string;
  /**
   * The game state this suite scores. The roam only ever considers suites in
   * the CURRENT context, which is why a menu suite may sit far outside the
   * tempo rules that govern arena-to-arena joins: a scene change is a
   * legitimate place for a bigger jump, and it never happens mid-roam.
   */
  context: SuiteContext;
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
  const context = raw.context ?? 'arena';
  if (typeof context !== 'string' || !SUITE_CONTEXTS.includes(context as SuiteContext)) {
    fail(`${at}.context`, `must be one of ${SUITE_CONTEXTS.join(', ')}, got ${JSON.stringify(context)}`);
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
  // The pickup entry -- a suite is ENTERED through its members' final bar -- only
  // sounds right because that bar is the key's dominant. The through-line
  // construction guarantees it (i-VI-VII-V); this makes the guarantee a boot
  // failure instead of a sour join discovered by ear.
  const home = parseChord(key);
  const last = parseChord(first.chords[first.chords.length - 1] ?? '');
  if (!home || !last || last.root !== (home.root + 7) % 12) {
    fail(
      `${at}.members`,
      `"${first.id}" ends on ${first.chords[first.chords.length - 1]}, not the dominant of ${key} -- the pickup entry needs the final bar to be the V`,
    );
  }
  return { id, key, context: context as SuiteContext, stepSeconds, transition: transition as TransitionKind, members };
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

/** Exposed for the validator's own negative controls. */
export const __parseAllForTests = parseAll;

export const SUITES: readonly SuiteDef[] = Object.freeze(
  parseAll(suitesJson).map((s) => Object.freeze({ ...s, members: Object.freeze([...s.members]) as string[] })),
);

export function suitesFor(context: SuiteContext): SuiteDef[] {
  return SUITES.filter((s) => s.context === context);
}

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
/**
 * How related two KEYS are, for choosing the next suite.
 *
 * Austin: "probably weight same keys higher and then related keys." The tiers:
 *
 *   4 -- the same key: no harmonic distance at all.
 *   2 -- relative major/minor (Am and C share every note), or a fifth apart in
 *        the same mode (Am to Em or Dm): one accidental of distance.
 *   1 -- parallel major/minor (Am and A): same tonic, different colour.
 *   0 -- anything else: excluded from selection outright, because a join the
 *        dominant has to drag across three accidentals is a jar no transition
 *        machinery hides.
 */
export function keyAffinity(a: string, b: string): number {
  const ca = parseChord(a);
  const cb = parseChord(b);
  if (!ca || !cb) return 0;
  const minor = (c: Chord): boolean => (c.pitchClasses[1] - c.root + 12) % 12 === 3;
  const sameMode = minor(ca) === minor(cb);
  const interval = (cb.root - ca.root + 12) % 12;
  if (interval === 0 && sameMode) return 4;
  // Relative pair: minor root sits 3 below its relative major.
  if (!sameMode && ((minor(ca) && interval === 3) || (minor(cb) && interval === 9))) return 2;
  if (sameMode && (interval === 5 || interval === 7)) return 2;
  if (interval === 0) return 1; // parallel
  return 0;
}

/** Within 20% tempo, per Austin: beyond that a ramp reads as a gear change. */
export const TEMPO_RATIO_LIMIT = 1.2;

export interface RankedSuite {
  suite: SuiteDef;
  weight: number;
}

/**
 * The suites that may follow `from`, weighted. Pure, so the policy is testable
 * without randomness: tempo outside the limit excludes outright, then key
 * affinity is the weight. An empty result means `from` has no musical neighbour
 * and should simply keep cycling its own members.
 */
export function rankCandidates(from: SuiteDef, all: readonly SuiteDef[]): RankedSuite[] {
  return all
    // Same context only: the roam stays inside the world it is scoring, and a
    // menu suite is never a candidate to follow an arena one.
    .filter((s) => s.id !== from.id && s.context === from.context)
    .map((s) => {
      const ratio = Math.max(s.stepSeconds, from.stepSeconds) / Math.min(s.stepSeconds, from.stepSeconds);
      const weight = ratio > TEMPO_RATIO_LIMIT ? 0 : keyAffinity(from.key, s.key);
      return { suite: s, weight };
    })
    .filter((r) => r.weight > 0)
    .sort((x, y) => y.weight - x.weight);
}

/** Weighted draw over rankCandidates. `rnd` in [0,1), injected for determinism. */
export function pickNextSuite(from: SuiteDef, all: readonly SuiteDef[], rnd: () => number): SuiteDef | null {
  const ranked = rankCandidates(from, all);
  if (ranked.length === 0) return null;
  const total = ranked.reduce((acc, r) => acc + r.weight, 0);
  let draw = rnd() * total;
  for (const r of ranked) {
    draw -= r.weight;
    if (draw < 0) return r.suite;
  }
  return ranked[ranked.length - 1].suite;
}

export function dominantOf(suite: SuiteDef): Chord {
  const home = parseChord(suite.key);
  if (!home) fail(`[${suite.id}].key`, `is not a chord name: ${JSON.stringify(suite.key)}`);
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const fifth = (home.root + 7) % 12;
  const chord = parseChord(NAMES[fifth]); // no quality suffix = major
  if (!chord) fail(`[${suite.id}]`, `could not build a dominant for ${suite.key}`);
  return chord;
}
