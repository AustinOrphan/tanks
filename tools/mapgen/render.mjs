import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadArena } from '../../src/sim/arena';
import { encodePng } from '../icons/render.mjs';

/**
 * Draw a board as a PNG, so candidate maps can be compared by eye and not only by table.
 *
 * `encodePng` is borrowed from `tools/icons/render.mjs` rather than reimplemented, for the
 * reason that file's own comment gives: nothing on this machine rasterises SVG -- no
 * imagemagick, no rsvg, no headless-browser step -- so a hand-rolled PNG is how a picture
 * gets made here at all. Its encoder is already pinned by `render.test.ts`.
 *
 * WHAT IS DRAWN IS WHAT IS PLAYED. The rectangles come from `loadArena`, so a picture shows
 * the MERGED solid runs collision and bank shots really use, not a re-walk of the grid that
 * is free to disagree with them. Spawn markers are the positions `loadArena` really picked
 * for that player count and mode, not the authored letters: on a versus board the letters
 * are not where anyone starts.
 */

/** Board colours, dark-on-dark to match the game's own palette rather than a debug look. */
const FLOOR = [26, 26, 26, 255];
const SOLID = [122, 132, 120, 255];
const DESTRUCTIBLE = [138, 106, 74, 255];
const GRID = [38, 38, 38, 255];
const SPAWN = [
  [232, 196, 84, 255],
  [110, 178, 232, 255],
  [214, 108, 108, 255],
  [138, 206, 138, 255],
];

/**
 * Render one board. `scale` is pixels per world unit; 24 puts a 22x18 board at 528x432,
 * which is legible in a document at full width and still cheap to write.
 */
export function renderBoard(arena, { playerCount = 2, scale = 24, gridLines = true } = {}) {
  const width = Math.round(arena.cols * arena.cellSize * scale);
  const height = Math.round(arena.rows * arena.cellSize * scale);
  const rgba = Buffer.alloc(width * height * 4);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const k = (y * width + x) * 4;
    rgba[k] = c[0];
    rgba[k + 1] = c[1];
    rgba[k + 2] = c[2];
    rgba[k + 3] = c[3];
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, FLOOR);

  if (gridLines) {
    // One faint line per CELL, because the cell is the unit every authoring rule is stated
    // in -- a reader counting cells off a picture is checking a corridor width.
    const step = arena.cellSize * scale;
    for (let c = 0; c <= arena.cols; c++) {
      const x = Math.round(c * step);
      for (let y = 0; y < height; y++) put(x, y, GRID);
    }
    for (let r = 0; r <= arena.rows; r++) {
      const y = Math.round(r * step);
      for (let x = 0; x < width; x++) put(x, y, GRID);
    }
  }

  const { walls, tanks } = loadArena(arena, playerCount, 'ffa');
  const boardW = arena.cols * arena.cellSize;
  const boardH = arena.rows * arena.cellSize;
  for (const wall of walls) {
    const b = wall.aabb;
    // Skip the boundary ring: it lies entirely outside the playfield and drawing it would
    // only thicken the image's own border.
    if (!(b.maxX > 0 && b.minX < boardW && b.maxY > 0 && b.minY < boardH)) continue;
    const colour = wall.kind === 'destructible' ? DESTRUCTIBLE : SOLID;
    const x0 = Math.round(Math.max(0, b.minX) * scale);
    const x1 = Math.round(Math.min(boardW, b.maxX) * scale);
    const y0 = Math.round(Math.max(0, b.minY) * scale);
    const y1 = Math.round(Math.min(boardH, b.maxY) * scale);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, colour);
  }

  // Spawns as open rings at the tank's true radius, so the picture shows how much room a
  // tank actually has where it starts -- a filled dot would hide exactly that.
  const players = tanks.filter((t) => t.kind === 'player');
  players.forEach((tank, i) => {
    const colour = SPAWN[i % SPAWN.length];
    const cx = tank.pos.x * scale;
    const cy = tank.pos.y * scale;
    const r = 0.5 * scale;
    for (let a = 0; a < 720; a++) {
      const th = (a / 720) * Math.PI * 2;
      for (const rr of [r - 1, r, r + 1]) {
        put(Math.round(cx + Math.cos(th) * rr), Math.round(cy + Math.sin(th) * rr), colour);
      }
    }
  });

  return { width, height, rgba, png: encodePng({ width, height, rgba }) };
}

/** Render and write one board to `path`. */
export function writeBoardPng(arena, path, opts) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderBoard(arena, opts).png);
  return path;
}
