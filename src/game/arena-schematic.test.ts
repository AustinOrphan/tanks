// @vitest-environment jsdom
//
// The versus map card's board preview (issue #274).
//
// WHAT THIS FILE CAN AND CANNOT MEASURE, stated because the boundary decides whether the
// rest of it means anything. jsdom does not implement `HTMLCanvasElement.getContext`, so
// no pixel this feature draws is observable here -- exactly the "computed is not visible"
// trap where broken render cues pass a green suite. So `arena-schematic.ts` keeps every
// number in `arenaSchematic`, which returns plain data and is measured exhaustively below,
// and `drawArenaSchematic` holds only the fill calls. The drawing is photographed by
// tools/screens (`screen.versus-setup`), not asserted here.
import { describe, it, expect } from 'vitest';
import { arenaSchematic, drawArenaSchematic, type SchematicRect } from './arena-schematic';
import { arenaById } from '../sim/config/arenas';
import { VERSUS_CATALOG } from '../sim/config/versus-catalog';
import { wallsForQuery } from '../sim/versus-spawns';

const PAINT = { floor: '#000', solid: '#fff', destructible: '#888' };

describe('arenaSchematic', () => {
  it('covers every board the versus catalog offers', () => {
    // The population is the catalog, not a list here: a ninth entry must not arrive with a
    // card that throws on `arenaById`. Eight today.
    expect(VERSUS_CATALOG.length).toBe(8);
    for (const entry of VERSUS_CATALOG) {
      expect(() => arenaSchematic(entry.arenaId), entry.id).not.toThrow();
    }
  });

  it('reports the board\'s floor in world units, matching the arena it names', () => {
    // Derived from the definition rather than pinned as literals, so retuning a grid moves
    // the card with it -- and compared against a DIFFERENT arena's size below, so a
    // function that returned one fixed board would fail.
    for (const entry of VERSUS_CATALOG) {
      const arena = arenaById(entry.arenaId);
      const schematic = arenaSchematic(entry.arenaId);
      expect(schematic.arenaId, entry.id).toBe(entry.arenaId);
      expect(schematic.width, entry.id).toBeCloseTo(arena.cols * arena.cellSize);
      expect(schematic.height, entry.id).toBeCloseTo(arena.rows * arena.cellSize);
    }
    // Non-vacuity: at least two shipped boards differ in size, so "every card is the same
    // box" would fail the loop above rather than satisfying it.
    const sizes = new Set(
      VERSUS_CATALOG.map((e) => {
        const s = arenaSchematic(e.arenaId);
        return `${s.width}x${s.height}`;
      }),
    );
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('draws the same cover the simulation builds, not a second grid walk', () => {
    // The whole reason this reads `wallsForQuery`: that function's rectangles are already
    // checked against the walls `loadArena` really builds, on every shipped arena
    // (versus-spawns.test.ts). This asserts the schematic did not lose or reshape them on
    // the way through -- a `.filter` that dropped destructibles, or a width computed as
    // `maxX` instead of `maxX - minX`, both of which draw something plausible.
    for (const entry of VERSUS_CATALOG) {
      const arena = arenaById(entry.arenaId);
      const walls = wallsForQuery(arena.grid, arena.cols, arena.rows, arena.cellSize, arena.legend);
      const rects = arenaSchematic(entry.arenaId).rects;
      expect(rects.length, entry.id).toBe(walls.length);
      for (const [i, rect] of rects.entries()) {
        const { aabb, kind } = walls[i];
        expect(rect.kind, `${entry.id} rect ${i}`).toBe(kind);
        expect(rect.x, `${entry.id} rect ${i}`).toBeCloseTo(aabb.minX);
        expect(rect.y, `${entry.id} rect ${i}`).toBeCloseTo(aabb.minY);
        expect(rect.w, `${entry.id} rect ${i}`).toBeCloseTo(aabb.maxX - aabb.minX);
        expect(rect.h, `${entry.id} rect ${i}`).toBeCloseTo(aabb.maxY - aabb.minY);
      }
    }
  });

  it('keeps every rectangle inside the floor it reports', () => {
    // A card scales the board to fit its box, so a rectangle outside the reported extent is
    // drawn outside the card -- clipped by the canvas and invisible, which is the failure
    // mode a "did it draw anything" check cannot see. Swapping `cols` and `rows` in the
    // extent is the slip this catches, and it is silent on the four square-ish boards.
    for (const entry of VERSUS_CATALOG) {
      const s = arenaSchematic(entry.arenaId);
      for (const r of s.rects) {
        expect(r.x, entry.id).toBeGreaterThanOrEqual(0);
        expect(r.y, entry.id).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w, entry.id).toBeLessThanOrEqual(s.width + 1e-9);
        expect(r.y + r.h, entry.id).toBeLessThanOrEqual(s.height + 1e-9);
      }
    }
  });

  it('gives every board both kinds of cover, so a card can tell them apart', () => {
    // Non-vacuity for the colour distinction the drawing makes. If some board had only
    // solid cover, a renderer that painted destructibles solid would still look right on it
    // -- so the population is stated here rather than assumed while reading a card.
    const kinds = (id: string): Set<SchematicRect['kind']> =>
      new Set(arenaSchematic(id).rects.map((r) => r.kind));
    for (const entry of VERSUS_CATALOG) {
      expect([...kinds(entry.arenaId)].sort(), entry.id).toEqual(['destructible', 'solid']);
    }
  });

  it('is deterministic: the same id twice gives identical geometry', () => {
    // Cards are rebuilt on every count and mode change, so a board that drew differently
    // the second time would flicker under a filter change. Nothing here is random today;
    // this is the guard that says so.
    for (const entry of VERSUS_CATALOG) {
      expect(arenaSchematic(entry.arenaId)).toEqual(arenaSchematic(entry.arenaId));
    }
  });

  it('refuses an id no arena answers to, rather than drawing an empty board', () => {
    // An empty schematic renders as a blank card, which reads as "this board is open
    // ground" rather than as a bug.
    expect(() => arenaSchematic('no-such-arena')).toThrow(/Unknown arena id/);
  });
});

describe('drawArenaSchematic', () => {
  it('reports that it could not draw, instead of throwing, with no 2D context', () => {
    // THIS IS THE jsdom PATH, and it is the one every HUD test takes: `getContext` returns
    // null there, and a throw would take out every case that mounts the versus pane. The
    // return value is the only thing this environment can observe about drawing at all --
    // which is why the caller in hud.ts must not depend on it having happened.
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 100;
    expect(canvas.getContext('2d'), 'jsdom grew a canvas implementation').toBeNull();
    expect(drawArenaSchematic(canvas, arenaSchematic('vs-duel-01'), PAINT)).toBe(false);
  });

  it('draws through a fake context, in the order and geometry a board needs', () => {
    // A hand-rolled 2D context, because jsdom has none and the alternative is asserting
    // nothing about the drawing at all. It records calls; what is checked is the part that
    // is arithmetic rather than pixels -- the floor is painted before any cover, the board
    // is scaled by ONE factor so it is never stretched, and it is centred in the box.
    const calls: string[] = [];
    const fills: { x: number; y: number; w: number; h: number; style: string }[] = [];
    let style = '';
    const ctx = {
      set fillStyle(v: string) {
        style = v;
      },
      get fillStyle() {
        return style;
      },
      clearRect: () => calls.push('clear'),
      fillRect: (x: number, y: number, w: number, h: number) => {
        calls.push('fill');
        fills.push({ x, y, w, h, style });
      },
    };
    const canvas = { width: 200, height: 100, getContext: () => ctx } as unknown as HTMLCanvasElement;

    const schematic = arenaSchematic('vs-duel-01');
    expect(drawArenaSchematic(canvas, schematic, PAINT)).toBe(true);

    expect(calls[0], 'the floor was painted over the cover').toBe('clear');
    expect(fills.length).toBe(schematic.rects.length + 1);
    const [floor, ...cover] = fills;
    expect(floor.style).toBe(PAINT.floor);

    // ONE scale on both axes. Measured as the aspect ratio of the painted floor against the
    // board's own, not as the scale factor itself, so this fails on a draw that fitted each
    // axis independently -- which for this board would look almost right.
    expect(floor.w / floor.h).toBeCloseTo(schematic.width / schematic.height, 6);
    // Centred: the box is 200x100 and the board is not 2:1, so one axis has real slack and
    // the two margins on it must match. A draw anchored at (0, 0) fails here.
    expect(floor.x * 2 + floor.w).toBeCloseTo(canvas.width, 6);
    expect(floor.y * 2 + floor.h).toBeCloseTo(canvas.height, 6);
    // Every rectangle lands inside the painted floor, at the floor's own scale.
    const scale = floor.w / schematic.width;
    for (const [i, rect] of schematic.rects.entries()) {
      expect(cover[i].x, `rect ${i}`).toBeCloseTo(floor.x + rect.x * scale, 6);
      expect(cover[i].w, `rect ${i}`).toBeCloseTo(rect.w * scale, 6);
      expect(cover[i].style, `rect ${i}`).toBe(
        rect.kind === 'solid' ? PAINT.solid : PAINT.destructible,
      );
    }
    // Non-vacuity: both colours actually occur, so the ternary above is exercised in both
    // directions rather than only on solids.
    expect(new Set(cover.map((c) => c.style))).toEqual(new Set([PAINT.solid, PAINT.destructible]));
  });
});
