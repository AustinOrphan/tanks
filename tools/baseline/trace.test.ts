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
    // What it does and does not cover: across this plan the hash moved for Tasks 1, 2
    // and 4 (wall geometry and movement behaviour) but did NOT move for Task 3 (bank
    // shots), Task 5 (tests only) or Task 5b (hull-inside-wall escape). So this is a
    // pin on arena and movement behaviour; it is blind to the bank-shot path and to
    // the inside-wall escape mechanism, and a green run here does not mean either of
    // those is covered.
    expect(hash).toBe('015a5d1745ce2d3a9ca11e150b2874c10b1b8ca6d77988599787e2269fd198e4');
  }, 300_000);
});
