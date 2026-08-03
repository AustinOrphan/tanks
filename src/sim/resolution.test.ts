import { describe, it, expect } from 'vitest';
import { ARENA_DEFS } from './config/arenas';
import { loadArena } from './arena';
import { cellCentre } from './arena-claims';

// What makes a 3x upscale safe, pinned so nobody "tidies" it to an even factor.
describe('the arena resolution', () => {
  it('is 2/3 on every shipped arena', () => {
    for (const a of ARENA_DEFS) expect(a.cellSize, a.id).toBeCloseTo(2 / 3, 12);
  });

  it('places every spawn on a coordinate the old cellSize-2 grid also had', () => {
    // THE property the migration rests on. An old cell c at cellSize 2 had its centre at
    // 2c+1; the centre sub-cell of its 3x3 block is at (3c+1.5)*(2/3), which float64
    // rounds to exactly 2c+1. An even upscale cannot do this -- the old centre lands on a
    // boundary BETWEEN two new cells -- which is why the factor is 3 and not 2.
    for (const a of ARENA_DEFS) {
      for (const s of loadArena(a).spawns) {
        for (const v of [s.pos.x, s.pos.y]) {
          expect(Number.isInteger((v - 1) / 2), `${a.id} spawn at ${v}`).toBe(true);
        }
      }
    }
  });

  it('keeps float64 exact across the whole coordinate range boards use', () => {
    // Not a mathematical guarantee -- 2/3 is not representable in binary -- but an
    // empirical property of float64 rounding, so it is checked rather than assumed.
    // Routed through the REAL `cellCentre` production function and REAL shipped-arena
    // dimensions, not a formula reimplemented in isolation with no imported symbol --
    // a change to either cellCentre's arithmetic or an arena's cols/cellSize is what
    // this test is meant to catch, and a copy of the formula catches neither.
    // Population: every arena in ARENA_DEFS, every column c with c ≡ 1 (mod 3) -- the
    // centre sub-cell of each old cellSize-2 cell's 3x3 block -- against that old cell's
    // own centre formula (c_old + 0.5) * 2.
    let checked = 0;
    for (const a of ARENA_DEFS) {
      for (let c = 1; c < a.cols; c += 3) {
        const cOld = (c - 1) / 3;
        expect(cellCentre(a, [c, 0]).x, `${a.id} col ${c}`).toBe((cOld + 0.5) * 2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
