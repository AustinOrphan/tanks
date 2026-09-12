/**
 * A deterministic top-down schematic of a versus board, for the map cards in Versus Setup
 * (issue #274: "a compact arena card with display name, deterministic visual/schematic
 * preview, supported configuration, and one short gameplay-intent phrase").
 *
 * NO ASSET SHIPS. The board is drawn from the arena's own grid at runtime, which settles
 * #274's "relative-base Pages paths resolve every preview asset" criterion by having no
 * preview asset to resolve. It also settles determinism: a pre-rendered picture drifts
 * from the grid the moment an arena is retuned, and a WebGL preview would depend on the
 * device's renderer, which is the one thing a card comparing eight boards must not.
 *
 * THE DERIVATION AND THE DRAWING ARE SEPARATE, and the split is the point rather than
 * tidiness. jsdom does not implement `HTMLCanvasElement.getContext` at all, so nothing
 * inside `drawArenaSchematic` can be asserted by the unit suite -- the trap this
 * repository already records as "computed is not visible". `arenaSchematic` therefore
 * returns plain data with every rectangle resolved, and that is what
 * `arena-schematic.test.ts` measures; `drawArenaSchematic` is kept small enough to read,
 * carries no geometry of its own, and is photographed by `tools/screens` instead.
 *
 * GEOMETRY IS BORROWED, NOT REDERIVED. The rectangles come from `wallsForQuery`, which
 * `versus-spawns.test.ts` already checks against the walls `loadArena` really builds on
 * every shipped arena. A second grid walk here would be a third copy of the same
 * merge rule, free to disagree with the board the player then plays on.
 */
import { arenaById } from '../sim/config/arenas';
import { wallsForQuery } from '../sim/versus-spawns';

/** One drawable rectangle, in world units with the board's origin at (0, 0). */
export interface SchematicRect {
  readonly kind: 'solid' | 'destructible';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A whole board, ready to draw into any box. */
export interface ArenaSchematic {
  readonly arenaId: string;
  /** World width of the floor, `cols * cellSize`. */
  readonly width: number;
  readonly height: number;
  readonly rects: readonly SchematicRect[];
}

/**
 * The board's cover, as rectangles.
 *
 * Solid cover arrives merged into runs and destructible cover one box per cell, which is
 * `loadArena`'s own distinction (a destructible cell is a destruction unit) and is why the
 * two read differently on a card without the drawing having to decide anything.
 *
 * SPAWN LETTERS ARE FLOOR HERE, deliberately. `P`, `B`, `G` and the rest are the CAMPAIGN
 * spawns authored into the grid, and a versus match strips every non-player spawn letter
 * and then relocates the players by `pickVersusSpawnSet` for the chosen count -- so drawing
 * the authored letters would mark positions no versus match uses. Showing the real versus
 * spawns would mean running that placement per card on every count or mode change; #274
 * asks for layout and match intent, not starting positions, so that is left out rather
 * than approximated.
 */
export function arenaSchematic(arenaId: string): ArenaSchematic {
  const arena = arenaById(arenaId);
  const walls = wallsForQuery(arena.grid, arena.cols, arena.rows, arena.cellSize, arena.legend);
  return {
    arenaId,
    width: arena.cols * arena.cellSize,
    height: arena.rows * arena.cellSize,
    rects: walls.map((wall) => ({
      kind: wall.kind,
      x: wall.aabb.minX,
      y: wall.aabb.minY,
      w: wall.aabb.maxX - wall.aabb.minX,
      h: wall.aabb.maxY - wall.aabb.minY,
    })),
  };
}

/** The four colours a schematic draws with, resolved by the caller from the stylesheet. */
export interface SchematicPaint {
  readonly floor: string;
  readonly solid: string;
  readonly destructible: string;
}

/**
 * Paints `schematic` to fill `canvas`, preserving the board's aspect ratio.
 *
 * RETURNS FALSE WHEN THERE IS NO 2D CONTEXT, rather than throwing. jsdom returns `null`
 * from `getContext` (it does not implement canvas), and every HUD test mounts the whole
 * pane -- so a throw here would take out a hundred cases that have nothing to do with
 * drawing. The boolean is what `arena-schematic.test.ts` asserts in place of pixels.
 *
 * `canvas.width`/`height` are set from the attributes the caller already chose, NOT from
 * `getBoundingClientRect`: layout is unavailable in jsdom and would make the same call
 * produce different geometry under test than in a browser.
 */
export function drawArenaSchematic(
  canvas: HTMLCanvasElement,
  schematic: ArenaSchematic,
  paint: SchematicPaint,
): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const { width, height } = canvas;
  // One scale for both axes, so a board is never stretched: an arena whose cover reads as
  // square on screen and oblong on its card is a card that misinforms the choice it exists
  // to inform.
  const scale = Math.min(width / schematic.width, height / schematic.height);
  const offsetX = (width - schematic.width * scale) / 2;
  const offsetY = (height - schematic.height * scale) / 2;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = paint.floor;
  ctx.fillRect(offsetX, offsetY, schematic.width * scale, schematic.height * scale);

  for (const rect of schematic.rects) {
    ctx.fillStyle = rect.kind === 'solid' ? paint.solid : paint.destructible;
    ctx.fillRect(
      offsetX + rect.x * scale,
      offsetY + rect.y * scale,
      rect.w * scale,
      rect.h * scale,
    );
  }
  return true;
}
