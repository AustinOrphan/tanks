import { describe, it, expect } from 'vitest';
import { cellCentre, cellOf } from './arena-claims';
import { ARENA_DEFS } from './config/arenas';
import { WIDE_ARENA } from './config/arena-fixtures';
import { loadArena } from './arena';
import { SPAWN_LETTERS } from './config/arena-types';

// The cell<->world formula `(c + 0.5) * cellSize` lives in THREE places: loadArena
// (arena.ts, where spawns are placed), cellCentre (arena-claims.ts, where a claim's
// cell becomes a point to trace), and cellOf (its inverse, used by failure messages
// and by arena-validation.test.ts's set-equality check). Nothing pinned them
// together, so a change to loadArena's placement would have made claims silently
// measure the wrong points -- the geometry would still "work", it would just be
// answering about different cells than the author wrote down.
//
// These tests are that pin. They fail if any of the three drifts from the others.

const ARENAS_UNDER_TEST = [...ARENA_DEFS, WIDE_ARENA];

describe('cellCentre and cellOf are exact inverses', () => {
  it('round-trips every cell of every arena, including the non-square fixture', () => {
    // Population: all cells of all 8 shipped arenas -- three at 33x27, arena-04
    // and arena-05 at 45x33 (the 33x27s are the old 11x9 board upscaled 3x), and the
    // three dedicated versus boards -- plus the 17x13 fixture, untouched by the
    // upscale = 891 + 891 + 891 + 1485 + 1485 + 567 + 459 + 459 + 221 = 7349 cells:
    // the 567 is issue #271's 27x21 vs-duel-01 and the two 459s are #272's vs-tri-01
    // and #273's vs-quad-01, both 27x17. Recomputed in full rather than incremented,
    // because the enumeration above had already drifted from its own total. The
    // non-square boards matter here: a formula that confused cols with rows would
    // round-trip fine on a square-ish board.
    let checked = 0;
    for (const arena of ARENAS_UNDER_TEST) {
      for (let r = 0; r < arena.rows; r++) {
        for (let c = 0; c < arena.cols; c++) {
          expect(cellOf(arena, cellCentre(arena, [c, r])), `${arena.id ?? 'arena'} [${c},${r}]`)
            .toEqual([c, r]);
          checked++;
        }
      }
    }
    expect(checked).toBe(7349);
  });

  it('resolves a point anywhere inside a cell, not only its exact centre', () => {
    // Failure messages call cellOf on a SPAWN position, which is a centre today --
    // but a nudged or moved tank is not, and the inverse should still name the cell
    // it stands in. Quarter-cell offsets in both axes, all four corners of the cell.
    const arena = ARENA_DEFS[0];
    const q = arena.cellSize / 4;
    for (const [dx, dy] of [[-q, -q], [q, -q], [-q, q], [q, q]] as const) {
      const p = cellCentre(arena, [3, 5]);
      expect(cellOf(arena, { x: p.x + dx, y: p.y + dy })).toEqual([3, 5]);
    }
  });
});

describe("loadArena's spawn placement is the formula cellCentre encodes", () => {
  it('every spawn lands exactly on its grid cell centre, in every arena', () => {
    // THE cross-module pin: if loadArena's `(c + 0.5) * cellSize` ever changes,
    // this fails here rather than silently relocating what every claim measures.
    let spawnsChecked = 0;
    for (const arena of ARENAS_UNDER_TEST) {
      const { spawns } = loadArena(arena);
      // Rebuild the expected spawn list straight from the grid text.
      const fromGrid: Array<{ kind: string; cell: [number, number] }> = [];
      for (let r = 0; r < arena.rows; r++) {
        for (let c = 0; c < arena.cols; c++) {
          const kind = SPAWN_LETTERS[arena.grid[r][c]];
          if (kind) fromGrid.push({ kind, cell: [c, r] });
        }
      }
      expect(spawns.length).toBe(fromGrid.length);
      for (let i = 0; i < spawns.length; i++) {
        expect(spawns[i].kind).toBe(fromGrid[i].kind);
        expect(spawns[i].pos).toEqual(cellCentre(arena, fromGrid[i].cell));
        expect(cellOf(arena, spawns[i].pos)).toEqual(fromGrid[i].cell);
        spawnsChecked++;
      }
    }
    // 4 + 5 + 6 + 7 + 8 campaign (each count INCLUDES that arena's player spawn) + 3
    // fixture = 33. Written as 17 first when the total was 18; the test caught the
    // arithmetic, which is the denominator discipline working on its own author.
    // 39, not 33: each of the three dedicated versus boards authors one player and one
    // enemy letter, the minimum arenas.json accepts, and all six sit on the
    // 1-(mod 3) lattice this test pins -- vs-quad-01's pair (issue #273) at column 13
    // on the mirror axis, deliberately away from the four corners its versus spawns
    // are picked at.
    expect(spawnsChecked).toBe(39);
  });
});
