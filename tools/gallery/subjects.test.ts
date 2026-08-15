// The gallery's own arithmetic. `buildGallery` needs a WebGLRenderer and so cannot be
// reached from here at all -- what it composes is checked in tools/gl/harness.ts, in a
// real browser. This file covers the part that is plain numbers.
//
// No `@vitest-environment` pragma: node, like the rest of the sim-adjacent tests.
import { describe, it, expect } from 'vitest';
import { DT } from '../../src/sim/constants';
import { compose, timelineDt, ELEMENTS } from './subjects';

describe('timelineDt: the gallery animation clock', () => {
  it('turns a whole age step into exactly one sim tick of seconds', () => {
    // The mapping the gallery commits to. A skin scrolled by anything else here would
    // drift at a rate the game never shows.
    expect(timelineDt(0, 1)).toBeCloseTo(DT, 12);
    expect(timelineDt(4, 5)).toBeCloseTo(DT, 12);
    expect(timelineDt(0, 90)).toBeCloseTo(90 * DT, 12);
  });

  it('counts a sub-divided step as a fraction of a tick', () => {
    // --subdiv 3 walks alpha 0, 1/3, 2/3 within an age, and each of those steps has to
    // advance the skin by a third of a tick -- otherwise a sub-divided animation either
    // stalls between ages or triple-counts each one.
    expect(timelineDt(0, 1 / 3)).toBeCloseTo(DT / 3, 12);
    expect(timelineDt(2 + 2 / 3, 3)).toBeCloseTo(DT / 3, 12);
  });

  it('never runs backwards, however the caller walks the timeline', () => {
    // GALLERY_DRAW is exposed on window and is called by hand as well as by the runner.
    // A negative dt would be swallowed by entities.sync's `dt > 0` gate, so the symptom
    // would be a skin that silently stops rather than an error.
    expect(timelineDt(90, 0)).toBe(0);
    expect(timelineDt(1, 1)).toBe(0);
  });
});

describe('compose still lays subjects out the way the camera assumes', () => {
  // Not new behaviour -- but `frames` is now overridable by --frames, and this is the
  // value that override replaces, so it is worth having one assertion on it.
  it('takes the LONGEST animation among the elements it was given', () => {
    expect(compose(['tank'], 0).frames).toBe(1);
    expect(compose(['tank', 'blast'], 0).frames).toBe(ELEMENTS.blast.frames);
    expect(ELEMENTS.blast.frames).toBeGreaterThan(1); // or the line above proves nothing
  });

  it('puts a player tank in the world for a skin to be painted onto', () => {
    // setPlayerStyle only ever reaches a tank whose kind is 'player' (entities.ts gates
    // the map on it), so `--elements tank --skin flow` showing nothing would be this.
    const w = compose(['tank'], 0).world;
    expect(w.tanks.filter((t) => t.kind === 'player')).toHaveLength(1);
  });

  it('the coop element places two DIFFERENTLY-slotted player tanks, each with its own shell', () => {
    // Below 2 player-kind tanks entities.ts draws no identity ring at all -- this is the
    // element `--elements coop` exists to get past that threshold reliably, without
    // depending on a second live input source the gallery cannot drive.
    const w = compose(['coop'], 0).world;
    const players = w.tanks.filter((t) => t.kind === 'player');
    expect(players).toHaveLength(2);
    expect(players.map((t) => t.controlledBy).sort()).toEqual([0, 1]);
    expect(w.bullets).toHaveLength(2);
    // Each bullet's ownerId resolves back to ONE of the two tanks placed above, not to
    // an id nothing in this world has (which would render untinted regardless of slot).
    const tankIds = new Set(players.map((t) => t.id));
    for (const b of w.bullets) expect(tankIds.has(b.ownerId)).toBe(true);
  });
});
