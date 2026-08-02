import { describe, it, expect } from 'vitest';
import { createMusicDirector, defaultDirector, START_SUITE_ID, TRACKS_PER_SUITE } from './playlist';
import { SUITES, suiteById, suitesFor, type SuiteDef } from './suites';

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
    // EXACT, not "more than ten": review showed the loose bound passed for
    // dwells of 1, 2, 4 and 5 alike, so TRACKS_PER_SUITE could be changed with
    // the suite still green. 60 directives at a dwell of 3 is exactly 20.
    const changes = kinds.filter((k) => k === 'suite').length;
    expect(changes, `dwell of ${TRACKS_PER_SUITE} over 60 directives`).toBe(60 / TRACKS_PER_SUITE);
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

  it('a one-member suite says STAY rather than re-queueing itself', () => {
    // The no-repeat promise cannot be honoured with one member; re-queueing the
    // same track every cycle is a repeat dressed as a decision.
    const solo: SuiteDef = { ...suiteById(START_SUITE_ID)!, id: 'solo', members: ['arena'] };
    const d = createMusicDirector([solo], xorshift(4), { startSuiteId: 'solo' })!;
    expect(d.first().id).toBe('arena');
    expect(Array.from({ length: 8 }, () => d.next().kind)).toEqual(Array(8).fill('stay'));
  });

  it('fails LOUDLY on bad configuration rather than quietly picking something', () => {
    expect(() => createMusicDirector(SUITES, xorshift(1), { startSuiteId: 'nope' })).toThrow(
      /no suite named "nope"/,
    );
    const ghost: SuiteDef = { ...suiteById(START_SUITE_ID)!, id: 'ghost', members: ['no-such-track'] };
    expect(() => createMusicDirector([ghost], xorshift(1), { startSuiteId: 'ghost' })).toThrow(
      /no playable members/,
    );
  });

  it('enterContext moves to that world and restarts the roam inside it', () => {
    const d = createMusicDirector(SUITES, xorshift(3), { startSuiteId: START_SUITE_ID })!;
    expect(d.currentContext()).toBe('arena');
    const menuTrack = d.enterContext('menu');
    expect(menuTrack, 'no menu track offered').not.toBeNull();
    expect(suitesFor('menu').flatMap((s) => s.members)).toContain(menuTrack!.id);
    expect(d.currentContext()).toBe('menu');
    // The roam continues INSIDE the menu world -- it must not wander back into
    // arena suites, which sit far outside menu's tempo.
    const menuIds = new Set(suitesFor('menu').flatMap((s) => s.members));
    for (let i = 0; i < 20; i++) {
      const dir = d.next();
      if (dir.kind !== 'stay') expect(menuIds, `left the menu world with ${dir.track.id}`).toContain(dir.track.id);
    }
    // And back again.
    const back = d.enterContext('arena');
    expect(back).not.toBeNull();
    expect(d.currentContext()).toBe('arena');
  });

  it('entering the context it is already in is a no-op, not a restart', () => {
    // loop.ts pushes the context on EVERY state change, including ones that do
    // not change world (playing -> paused -> playing). Treating those as
    // entries would restart the music on every pause.
    const d = createMusicDirector(SUITES, xorshift(8), { startSuiteId: START_SUITE_ID })!;
    expect(d.enterContext('arena')).toBeNull();
    expect(d.enterContext('arena')).toBeNull();
  });

  it('a context with no suites leaves the music alone rather than silencing it', () => {
    const d = createMusicDirector(SUITES, xorshift(2), { startSuiteId: START_SUITE_ID })!;
    expect(d.enterContext('victory')).toBeNull(); // none authored yet
    expect(d.currentContext(), 'an empty context stole the music').toBe('arena');
  });

  it('defaultDirector survives empty suite data by falling back to one track', () => {
    const d = defaultDirector([], xorshift(1));
    expect(d).not.toBeNull();
    expect(d!.first().id).toBe('arena');
    expect(d!.next()).toEqual({ kind: 'stay' });
  });
});
