import { describe, it } from 'vitest';
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
    console.log(`BASELINE ${h.digest('hex')}`);
  }, 300_000);
});
