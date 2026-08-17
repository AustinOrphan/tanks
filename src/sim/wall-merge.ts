/**
 * Maximal-rectangle decomposition of a solid-cell mask: horizontal runs per row, then
 * runs with identical extent stacked vertically.
 *
 * CANONICAL — the same region yields the same rectangles whatever cell size expressed
 * it, which is the whole point: resolveWalls and bankShot both read the wall ARRAY, so
 * a wall's slicing was leaking into collision and aiming.
 *
 * Solid only. A destructible cell is a destruction unit -- mine blasts destroy by
 * world-space radius, so finer cells mean finer breaching -- and arena-02's centre
 * barrier is authored as adjacent blocks that must stay separately destructible. (Those
 * blocks were 2.0 units when this was written and are 0.667 since the rescale, which is
 * exactly the point: merging them would fuse a barrier the level breaches piecemeal.)
 *
 * Extracted from `arena.ts` (PR versus-spawns): `versus-spawns.ts` needed the same
 * algorithm for its own wall-geometry-for-a-visibility-query build (`wallsForQuery`) and
 * could not import `arena.ts`'s copy without closing a cycle (`arena.ts` already imports
 * `versus-spawns.ts`), so the two carried byte-identical duplicates for one PR. Two
 * implementations of geometry this collision-relevant is a maintenance hazard -- a cross-
 * check test can only make divergence DETECTABLE, where a shared module makes it
 * IMPOSSIBLE -- so this file is the shared home instead. Zero dependencies by
 * construction (plain arrays and numbers in, plain tuples out), which is what makes it
 * safe for both `arena.ts` and `versus-spawns.ts` to import: a leaf module cannot
 * introduce a cycle no matter which other file reaches for it.
 */
export function mergeSolidRuns(mask: boolean[][], cols: number, rows: number): [number, number, number, number][] {
  const runs: { r: number; c0: number; c1: number }[] = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!mask[r][c]) { c++; continue; }
      let c1 = c;
      while (c1 + 1 < cols && mask[r][c1 + 1]) c1++;
      runs.push({ r, c0: c, c1 });
      c = c1 + 1;
    }
  }
  const used = new Set<number>();
  const rects: [number, number, number, number][] = [];
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const a = runs[i];
    let rEnd = a.r;
    for (;;) {
      const j = runs.findIndex((b, k) => !used.has(k) && b.r === rEnd + 1 && b.c0 === a.c0 && b.c1 === a.c1);
      if (j < 0) break;
      used.add(j);
      rEnd++;
    }
    rects.push([a.c0, a.r, a.c1 + 1, rEnd + 1]);
  }
  return rects;
}
