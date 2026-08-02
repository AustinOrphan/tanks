import { describe, it, expect } from 'vitest';
import { createMusicDirector, defaultDirector, START_SUITE_ID } from './playlist';
import { SUITES, suiteById } from './suites';

const xorshift = (seed: number) => {
  let x = seed || 1;
  return (): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
};

/** Walk n directives, returning the track ids in play order (first included). */
function walk(n: number, seed = 7, tracksPerSuite?: number): { ids: string[]; kinds: string[] } {
  const d = createMusicDirector(SUITES, xorshift(seed), { startSuiteId: START_SUITE_ID, tracksPerSuite })!;
  const ids = [d.first().id];
  const kinds: string[] = [];
  for (let i = 0; i < n; i++) {
    const dir = d.next();
    kinds.push(dir.kind);
    if (dir.kind !== 'stay') ids.push(dir.track.id);
  }
  return { ids, kinds };
}

describe('the music director', () => {
  it('starts in the start suite', () => {
    const d = createMusicDirector(SUITES, xorshift(1), { startSuiteId: START_SUITE_ID })!;
    expect(suiteById(START_SUITE_ID)!.members).toContain(d.first().id);
  });

  it('never plays the same member twice in a row -- the shuffle-bag promise', () => {
    // Uniform draws repeat back-to-back about one time in four; the design doc
    // calls that "more broken than a plain loop". Population: 400 consecutive
    // plays across many bag refills and suite changes, three seeds.
    for (const seed of [3, 99, 4242]) {
      const { ids } = walk(400, seed);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i], `seed ${seed}, position ${i}`).not.toBe(ids[i - 1]);
      }
    }
  });

  it('plays every member of a suite before repeating any -- a bag, not a die', () => {
    // Within one dwell the draws come from a bag: with dwell >= member count,
    // the first N plays in a suite are a permutation, no repeats.
    const members = suiteById(START_SUITE_ID)!.members;
    const { ids } = walk(members.length - 1, 11, 100); // huge dwell: stays home
    expect(new Set(ids.slice(0, members.length)).size).toBe(members.length);
  });

  it('moves to a NEIGHBOURING suite after the dwell, never an illegal one', () => {
    const byId = new Map(SUITES.map((s) => [s.id, s]));
    const suiteOf = (trackId: string): string =>
      SUITES.find((s) => s.members.includes(trackId))!.id;
    const { ids, kinds } = walk(60, 5);
    // Dwell of TRACKS_PER_SUITE: every TRACKS_PER_SUITEth directive is a suite change.
    const changes = kinds.filter((k) => k === 'suite').length;
    expect(changes).toBeGreaterThan(10);
    // And each change lands on a suite that is a legal neighbour of the previous
    // track's suite -- the compatibility rules, observed end to end.
    let current = START_SUITE_ID;
    let index = 1;
    for (const kind of kinds) {
      if (kind === 'stay') continue;
      const next = suiteOf(ids[index]);
      if (kind === 'suite') {
        expect(next).not.toBe(current);
        const from = byId.get(current)!;
        const to = byId.get(next)!;
        const ratio = Math.max(from.stepSeconds, to.stepSeconds) / Math.min(from.stepSeconds, to.stepSeconds);
        expect(ratio, `${current} -> ${next}`).toBeLessThanOrEqual(1.2 + 1e-9);
        current = next;
      } else {
        expect(next, `queue directive left the suite`).toBe(current);
      }
      index += 1;
    }
  });

  it('roams: over a long walk it visits more than two suites', () => {
    const suiteOf = (trackId: string): string =>
      SUITES.find((s) => s.members.includes(trackId))!.id;
    const { ids } = walk(200, 21);
    const visited = new Set(ids.map(suiteOf));
    expect(visited.size, [...visited].join(',')).toBeGreaterThan(2);
  });

  it('is deterministic under a seed', () => {
    expect(walk(50, 77)).toEqual(walk(50, 77));
    expect(walk(50, 77).ids).not.toEqual(walk(50, 78).ids);
  });

  it('a reshuffled bag never opens with the member that just played', () => {
    // The one repeat the bag exists to prevent lives at the REFILL boundary --
    // and the normal walk never reaches it, because the dwell (3) is shorter
    // than the member count (4), so a suite change resets the bag first. This
    // pins the refill path directly: one suite, huge dwell, many refills.
    const only = [suiteById(START_SUITE_ID)!];
    for (const seed of [2, 17, 300]) {
      const d = createMusicDirector(only, xorshift(seed), { startSuiteId: START_SUITE_ID, tracksPerSuite: 10000 })!;
      let last = d.first().id;
      for (let i = 0; i < 120; i++) {
        const dir = d.next();
        if (dir.kind === 'stay') continue;
        expect(dir.track.id, `seed ${seed}, play ${i}`).not.toBe(last);
        last = dir.track.id;
      }
    }
  });

  it('a one-suite collection stays home rather than stopping', () => {
    const only = [suiteById(START_SUITE_ID)!];
    const d = createMusicDirector(only, xorshift(9), { startSuiteId: START_SUITE_ID, tracksPerSuite: 2 })!;
    const kinds = Array.from({ length: 12 }, () => d.next().kind);
    expect(kinds).not.toContain('suite'); // nowhere to go
    expect(kinds.filter((k) => k === 'queue').length).toBeGreaterThan(8);
  });

  it('defaultDirector survives empty suite data by falling back to one track', () => {
    const d = defaultDirector([], xorshift(1));
    expect(d).not.toBeNull();
    expect(d!.first().id).toBe('arena');
    expect(d!.next()).toEqual({ kind: 'stay' });
  });
});
