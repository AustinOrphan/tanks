import { describe, it, expect } from 'vitest';
import { ARENAS, createWorldFor } from '../../src/sim/arena';
import { step } from '../../src/sim/world';
import { createHash } from 'node:crypto';

describe('baseline', () => {
  it('fingerprint', () => {
    const h = createHash('sha256');
    for (let a = 0; a < ARENAS.length; a++) {
      for (let seed = 1; seed <= 6; seed++) {
        let w = createWorldFor(ARENAS[a], seed);
        for (let t = 0; t < 2500 && w.status === 'playing'; t++) {
          const d = { x: Math.cos(t / 37), y: Math.sin(t / 41) };
          w = step(w, { move: d, aim: d, fire: t % 23 === 0, mine: t % 311 === 0 }).world;
          if (t % 100 === 0) {
            h.update(w.tanks.map((k) =>
              `${k.pos.x.toFixed(9)},${k.pos.y.toFixed(9)},${k.turretAngle.toFixed(9)},${k.alive}`).join('|'));
          }
        }
        h.update(`|${a}:${seed}:${w.status}:${w.tick}|`);
      }
    }
    const hash = h.digest('hex');
    console.log(`BASELINE ${hash}`);
    // A golden trace over 4 arenas x 6 seeds x 2500 ticks. determinism.test.ts asserts
    // self-consistency, which is invariant under behaviour changes -- this is the pin
    // that actually moves when AI or collision behaviour moves. Changing it is a
    // deliberate act: re-record the value and say in the commit WHY it moved.
    //
    // What it does and does not cover, RE-MEASURED against the current tree (not carried
    // forward from when it was recorded): mutating bankShot to return the first valid
    // candidate instead of the shortest now changes the hash (to
    // 0cf1f76a14060992eb8763c9cd20e95b8c17cde2d1dbe3e8de6c87ff47137e9a) and fails this
    // test -- a later change to resolveWalls altered trajectories enough that bank shots
    // now do influence the trace, even though the bank-shot rewrite itself did not move it
    // when it landed. Mutating the inside-wall escape (disabling resolveWalls' union-mass
    // marching so a hull inside a wall resolves through the single sub-cell box instead)
    // still leaves the hash unchanged and this test still passes: the seeded replay never
    // drives a hull inside a wall, so that path remains uncovered. Lesson: a coverage claim
    // recorded at one commit can go stale as later changes alter trajectories -- re-measure
    // rather than carrying it forward.
    expect(hash).toBe('015a5d1745ce2d3a9ca11e150b2874c10b1b8ca6d77988599787e2269fd198e4');
  }, 300_000);
});
