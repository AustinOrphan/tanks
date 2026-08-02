import { pickNextSuite, membersOf, type SuiteDef } from './suites';
import { trackById, type MusicTrackDef } from './music-data';

/**
 * The playlist policy: WHICH track plays next, decided one cycle at a time.
 *
 * This is the piece that finally makes the suite machinery reachable from the
 * game -- until now engine.ts played one track forever and everything in
 * suites.ts was tested but dead. The bed asks `next()` at every completed
 * cycle; the answer is a directive, and the bed applies it (queueTrack for a
 * sibling, changeSuite for a new set). Policy here, scheduling there.
 *
 * Two rules, both from the design doc:
 *
 *   - WITHIN a suite: a shuffle bag, not independent draws. Uniform random
 *     repeats a member back-to-back about one time in four, which reads as more
 *     broken than a plain loop; a fixed rotation becomes its own audible
 *     pattern. The bag reshuffles when empty, re-rolling once if the reshuffle
 *     would repeat the member that just played.
 *   - ACROSS suites: after `tracksPerSuite` members, move on via pickNextSuite
 *     (tempo-limited, key-weighted). The whole collection is a connected graph,
 *     so the walk can always continue.
 *
 * Deterministic under an injected rnd, so every decision is testable.
 */

export type Directive =
  | { kind: 'stay' }
  | { kind: 'queue'; track: MusicTrackDef }
  | { kind: 'suite'; track: MusicTrackDef };

export interface MusicDirector {
  /** The track to start with. */
  first(): MusicTrackDef;
  /** Called by the bed at each completed cycle. */
  next(): Directive;
}

/** How many members play before the walk moves to a neighbouring suite. */
export const TRACKS_PER_SUITE = 3;

export function createMusicDirector(
  suites: readonly SuiteDef[],
  rnd: () => number,
  opts: { startSuiteId?: string; tracksPerSuite?: number } = {},
): MusicDirector | null {
  const dwell = opts.tracksPerSuite ?? TRACKS_PER_SUITE;
  let suite =
    suites.find((s) => s.id === (opts.startSuiteId ?? '')) ?? suites[0] ?? null;
  if (!suite) return null;

  let bag: MusicTrackDef[] = [];
  let lastId: string | null = null;
  let playedInSuite = 0;

  function refill(s: SuiteDef): void {
    bag = [...membersOf(s)];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    // A fresh bag whose first draw repeats the member that just played is the
    // one repeat the bag exists to prevent: swap it away when possible.
    if (bag.length > 1 && bag[bag.length - 1].id === lastId) {
      [bag[bag.length - 1], bag[0]] = [bag[0], bag[bag.length - 1]];
    }
  }

  function draw(s: SuiteDef): MusicTrackDef {
    if (bag.length === 0) refill(s);
    const track = bag.pop()!;
    lastId = track.id;
    return track;
  }

  const start = draw(suite);
  playedInSuite = 1;

  return {
    first: () => start,
    next(): Directive {
      if (!suite) return { kind: 'stay' };
      if (playedInSuite >= dwell) {
        const nextSuite = pickNextSuite(suite, suites, rnd);
        if (nextSuite) {
          suite = nextSuite;
          bag = [];
          playedInSuite = 1;
          return { kind: 'suite', track: draw(nextSuite) };
        }
        // No legal neighbour (a one-suite install): stay home, keep shuffling.
        playedInSuite = 0;
      }
      playedInSuite += 1;
      return { kind: 'queue', track: draw(suite) };
    },
  };
}

/** The suite the game opens in. Its first member is what boot plays. */
export const START_SUITE_ID = 'assault';

/** Convenience for the engine: null when the data has no suites at all. */
export function defaultDirector(
  suites: readonly SuiteDef[],
  rnd: () => number,
): MusicDirector | null {
  const director = createMusicDirector(suites, rnd, { startSuiteId: START_SUITE_ID });
  if (director) return director;
  // Degenerate data: fall back to the old single-track behaviour.
  const track = trackById('arena');
  if (!track) return null;
  return { first: () => track, next: () => ({ kind: 'stay' }) };
}
