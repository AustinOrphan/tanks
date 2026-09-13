// The gallery's own arithmetic. `buildGallery` needs a WebGLRenderer and so cannot be
// reached from here at all -- what it composes is checked in tools/gl/harness.ts, in a
// real browser. This file covers the part that is plain numbers.
//
// No `@vitest-environment` pragma: node, like the rest of the sim-adjacent tests.
import { describe, it, expect } from 'vitest';
import { DT } from '../../src/sim/constants';
import { compose, timelineDt, ELEMENTS, ENEMY_KINDS } from './subjects';
import { TANK_KINDS } from '../../src/sim/config/validate';

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

  it('the entrant element is dead before age 0 and alive from age 0 on', () => {
    // entities.ts's respawn entrance only triggers on a dead->alive (or roundStartTick)
    // edge; `tank` is always alive and cannot supply that edge (see subjects.ts's own
    // comment on `entrant`), which is why this element exists at all -- for
    // tools/gl/harness.ts's --spawn-anim pixel check to have a world shape that actually
    // fires the trigger.
    // Mutation that breaks this: flipping the `age >= 0` threshold (an off-by-one at the
    // boundary tested here) or hardcoding `alive: true` regardless of age.
    const dead = compose(['entrant'], -1).world;
    expect(dead.tanks).toHaveLength(1);
    expect(dead.tanks[0].alive).toBe(false);
    expect(dead.tanks[0].kind).toBe('player');

    const alive = compose(['entrant'], 0).world;
    expect(alive.tanks).toHaveLength(1);
    expect(alive.tanks[0].alive).toBe(true);
    expect(alive.tanks[0].kind).toBe('player');
  });
});


describe('the roster subject: every enemy kind, side by side (issue #357)', () => {
  const tanks = () => compose(['roster'], 0).world.tanks;

  it('poses one tank of EVERY enemy kind -- population: the shipped roster minus the player', () => {
    // The guard that makes "derived from TANK_KINDS, not listed" worth anything. Without it
    // the derivation is a comment: a kind added to the roster could quietly miss the one
    // subject whose entire job is to show every kind together, and the capture would still
    // look complete.
    //
    // `yellow` is why this is not hypothetical. It is a full entry in tank-defs.json with its
    // own arena letter and it is placed in NO shipped arena, so no match-based capture can
    // ever include it. A hand-written list would have been written from what the author had
    // seen in play.
    // Asserted against TANK_KINDS, the CANONICAL roster, not against ENEMY_KINDS. Comparing
    // the posed row to ENEMY_KINDS is a tautology -- both come from the same constant, so a
    // wrong list matches its own output and the test passes. MEASURED: replacing the
    // derivation with a hand-written five-kind list leaves that comparison green.
    const expected = TANK_KINDS.filter((k) => k !== 'player');
    expect([...new Set(tanks().map((t) => t.kind))].sort()).toEqual([...expected].sort());
    expect(tanks()).toHaveLength(expected.length);
    // ...and the exported list agrees with the roster too, since the subject's framing and
    // the args-layer checks both read it.
    expect([...ENEMY_KINDS].sort()).toEqual([...expected].sort());
  });

  it('poses NO player tank, so nothing in the row is the thing being compared against', () => {
    expect(tanks().some((t) => t.kind === 'player')).toBe(false);
    // ...and ENEMY_KINDS really is the roster minus exactly one entry, rather than a list
    // that happens to agree today.
    expect(ENEMY_KINDS.length).toBe(TANK_KINDS.length - 1);
  });

  it('holds every tank at ONE pose, which is what leaves hue as the only variable', () => {
    // The property the subject exists for. A row at mixed angles invites "olive looks
    // different" when what differs is that olive was drawn at 45 degrees; #357's claim is
    // that the kinds are separated by colour ALONE, and a confounded row can neither show
    // that nor refute it.
    const angles = new Set(tanks().map((t) => t.bodyAngle));
    expect(angles.size, 'the row poses tanks at more than one angle').toBe(1);
    expect(new Set(tanks().map((t) => t.turretAngle)).size).toBe(1);
  });

  it('lays them out left to right with even spacing, centred on the subject slot', () => {
    // Framing depends on it: `width` is derived from the same spacing, so a row that drifted
    // would clip its end tanks out of the capture.
    const xs = tanks().map((t) => t.pos.x);
    const gaps = xs.slice(1).map((x, i) => +(x - xs[i]).toFixed(6));
    expect(new Set(gaps).size, 'spacing is uneven').toBe(1);
    expect(Math.abs((xs[0] + xs[xs.length - 1]) / 2), 'the row is not centred').toBeLessThan(1e-9);
    expect(ELEMENTS.roster.width).toBeGreaterThanOrEqual(xs[xs.length - 1] - xs[0]);
  });
});
