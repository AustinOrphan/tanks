// #1010 criterion 9: board-level stills for the human reader, drawn from the repository's own code.
//
//   cd <worktree> && npx vite-node /Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1010-scripts/boards.ts -- --out <dir>
//
// Read-only: imports the tree's modules, writes only under --out.
//
// 1. Before / after board. "Before" is STANDARD_ARENA (src/sim/config/arena-fixtures.ts), the
//    pre-edit arena-01; this script first asserts its grid equals arena-01's grid at the branch
//    base (c200cf62, read with `git show`), so the fixture is the pre-edit board, not assumed to
//    be. "After" is ARENA_01 at the working tree's HEAD.
// 2. The player's bank onto the brown, on intact and on breached walls. The angle is the real
//    bankShot(playerSpawn, brown, walls, 1); the bounce point is the real reflectSweep along that
//    angle (the sweep a fired shell takes); both legs are sampled every 0.05 units into
//    [column, row, glyph] cells and drawn with renderBoard from src/sim/arena-claims.ts. Cells
//    that are not floor ('.') are not overwritten, so walls and the P/B letters stay visible.
//    The bounce cell is the floor cell just before the face (the point nudged 0.01 back along
//    leg 1), so 'X' never paints over a wall cell.
//
// Writes: boards.txt (every ASCII board and caption), boards.json (the numbers), and two PNGs
// rasterised from SVG by Playwright's Chromium: board-before-after.png and bank-path.png.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = process.cwd();
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : '';
if (!OUT) throw new Error('--out <dir> is required');
mkdirSync(OUT, { recursive: true });

const { ARENA_01, loadArena } = await import(`${W}/src/sim/arena.ts`);
const { STANDARD_ARENA } = await import(`${W}/src/sim/config/arena-fixtures.ts`);
const { breach, cellOf, renderBoard } = await import(`${W}/src/sim/arena-claims.ts`);
const { bankShot, lineOfSight } = await import(`${W}/src/sim/ai/targeting.ts`);
const { reflectSweep } = await import(`${W}/src/sim/collision.ts`);
const { fromAngle } = await import(`${W}/src/sim/types.ts`);
const { TANK_RADIUS, NORMAL_BOUNCES } = await import(`${W}/src/sim/constants.ts`);
const tankDefs = (await import(`${W}/src/sim/config/data/tank-defs.json`)).default;

type V = { x: number; y: number };
type Mark = [number, number, string];
const head = execFileSync('git', ['-C', W, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const BASE = 'c200cf62';
const text: string[] = [];
const say = (s = '') => { text.push(s); console.log(s); };

// ---- 0. the "before" board is the pre-edit arena-01 -------------------------------------------
const baseJson = JSON.parse(execFileSync('git', ['-C', W, 'show', `${BASE}:src/sim/config/data/arenas.json`], { encoding: 'utf8' }));
const baseArena01 = baseJson.arenas.find((a: any) => a.id === 'arena-01');
const sameAsBase = JSON.stringify(baseArena01.grid) === JSON.stringify(STANDARD_ARENA.grid);
if (!sameAsBase) throw new Error(`STANDARD_ARENA.grid differs from arena-01 at ${BASE}`);
const floored = (g: string[]) => g.map((r) => r.replace(/[BGTONY]/g, '.')).join('\n');
const wallsAndPSame = floored(ARENA_01.grid) === floored(STANDARD_ARENA.grid);
if (!wallsAndPSame) throw new Error('walls or P differ between ARENA_01 and STANDARD_ARENA');
const letters = (g: string[]) => Object.fromEntries(['P', 'B', 'G', 'T', 'O', 'N', 'Y'].map((ch) => [ch, g.join('').split(ch).length - 1]));

say(`#1010 criterion 9 boards, worktree HEAD ${head}`);
say(`STANDARD_ARENA.grid === arena-01 grid at ${BASE}: ${sameAsBase}`);
say(`ARENA_01 (HEAD) and STANDARD_ARENA with enemy letters read as floor are identical (walls and P): ${wallsAndPSame}`);
say(`spawn letters before: ${JSON.stringify(letters(STANDARD_ARENA.grid))}`);
say(`spawn letters after:  ${JSON.stringify(letters(ARENA_01.grid))}`);

const spawnsOf = (arena: any) => loadArena(arena).spawns.map((s: any) => ({
  kind: s.kind, pos: s.pos, cell: cellOf(arena, s.pos),
}));
const before = spawnsOf(STANDARD_ARENA);
const after = spawnsOf(ARENA_01);
say('');
say(`BEFORE: STANDARD_ARENA (fixture-standard) = arena-01 at ${BASE}; ${before.length} spawns, loadArena order:`);
for (const s of before) say(`  ${s.kind.padEnd(6)} column ${s.cell[0]} row ${s.cell[1]}, world (${s.pos.x}, ${s.pos.y})`);
say(renderBoard(STANDARD_ARENA, []));
say('');
say(`AFTER: arena-01 at HEAD ${head.slice(0, 8)}; ${after.length} spawns, loadArena order:`);
for (const s of after) say(`  ${s.kind.padEnd(6)} column ${s.cell[0]} row ${s.cell[1]}, world (${s.pos.x}, ${s.pos.y})`);
say(renderBoard(ARENA_01, []));

// ---- 2. the bank path ------------------------------------------------------------------------
const { walls } = loadArena(ARENA_01);
const P: V = loadArena(ARENA_01).spawns.find((s: any) => s.kind === 'player').pos;
const B: V = loadArena(ARENA_01).spawns.find((s: any) => s.kind === 'brown').pos;
const cs = ARENA_01.cellSize;
const r = (v: number) => Math.round(v / cs);
const wallLabel = (w: any) => {
  const [c0, c1, r0, r1] = [r(w.aabb.minX), r(w.aabb.maxX) - 1, r(w.aabb.minY), r(w.aabb.maxY) - 1];
  return c0 === c1 && r0 === r1
    ? `${w.kind} block at column ${c0} row ${r0}`
    : `${w.kind} wall, columns ${c0}-${c1}, rows ${r0}-${r1}`;
};
const faceOf = (w: any, X: V) => {
  const e = 1e-9;
  if (Math.abs(X.x - w.aabb.minX) < e) return 'west face';
  if (Math.abs(X.x - w.aabb.maxX) < e) return 'east face';
  if (Math.abs(X.y - w.aabb.minY) < e) return 'north face';
  if (Math.abs(X.y - w.aabb.maxY) < e) return 'south face';
  return 'face ?';
};

interface Phase {
  phase: string; angle: number; bounce: V; reflector: string; face: string; reflectorKind: string;
  legs: [number, number]; directLine: boolean; marks: Mark[]; board: string; legCells: [number, number];
  reflectorBox: { minX: number; minY: number; maxX: number; maxY: number };
}
const phases: Phase[] = [];
say('');
say(`player's normal shell bounces: NORMAL_BOUNCES = ${NORMAL_BOUNCES}; player spawn (${P.x}, ${P.y}), brown (${B.x}, ${B.y})`);
for (const [phase, ws] of [['walls intact', walls], ['every destructible destroyed (breach(walls))', breach(walls)]] as const) {
  const directLine: boolean = lineOfSight(P, B, ws);
  const angle = bankShot(P, B, ws, 1);
  if (angle === null) throw new Error(`${phase}: bankShot returned null`);
  const live = ws.filter((w: any) => !w.destroyed);
  const d = fromAngle(angle);
  const { hits } = reflectSweep(P, { x: P.x + d.x * 80, y: P.y + d.y * 80 }, live.map((w: any) => w.aabb), 1);
  const X: V = hits[0].point;
  const wall = live[hits[0].wallIndex];
  const marks: Mark[] = [];
  const seen = new Set<string>();
  const legCount = [0, 0];
  const leg = (a: V, b: V, glyph: string, li: number) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    for (let s = 0; s <= L; s += 0.05) {
      const [c, rr] = cellOf(ARENA_01, { x: a.x + (b.x - a.x) * s / L, y: a.y + (b.y - a.y) * s / L });
      const k = `${c},${rr}`;
      if (seen.has(k) || ARENA_01.grid[rr]?.[c] !== '.') continue;
      seen.add(k);
      marks.push([c, rr, glyph]);
      legCount[li]++;
    }
  };
  leg(P, X, 'o', 0);
  leg(X, B, '+', 1);
  // The bounce cell: the floor cell just before the face, along leg 1.
  const L1 = Math.hypot(X.x - P.x, X.y - P.y);
  const xc = cellOf(ARENA_01, { x: X.x - (X.x - P.x) / L1 * 0.01, y: X.y - (X.y - P.y) / L1 * 0.01 });
  const at = marks.findIndex(([c, rr]) => c === xc[0] && rr === xc[1]);
  if (at >= 0) marks.splice(at, 1);
  marks.push([xc[0], xc[1], 'X']);
  const legs: [number, number] = [L1, Math.hypot(B.x - X.x, B.y - X.y)];
  const board = renderBoard(ARENA_01, marks);
  const p: Phase = {
    phase, angle, bounce: X, reflector: wallLabel(wall), face: faceOf(wall, X), reflectorKind: wall.kind,
    legs, directLine, marks, board, legCells: [legCount[0], legCount[1]], reflectorBox: { ...wall.aabb },
  };
  phases.push(p);
  say('');
  say(`${phase}: lineOfSight(spawn, brown) = ${directLine}; bankShot(spawn, brown, walls, 1) = ${angle.toFixed(4)} rad`);
  say(`  bounce at (${X.x.toFixed(3)}, ${X.y.toFixed(3)}) on the ${p.face} of the ${p.reflector}`);
  say(`  legs ${legs[0].toFixed(3)} + ${legs[1].toFixed(3)} = ${(legs[0] + legs[1]).toFixed(3)} units; ` +
    `sampled cells: leg 1 'o' ${legCount[0]}, leg 2 '+' ${legCount[1]}, bounce 'X' 1 (floor cells only)`);
  say(board);
}
say('');
say("Legend: '.' floor, '#' solid wall, 'x' destructible block (still drawn in the breached board: renderBoard draws the grid,");
say("not wall state), 'P' player spawn, 'B' brown, 'G' grey, 'T' teal, 'o' leg 1 (spawn to bounce), '+' leg 2 (bounce to brown),");
say("'X' the floor cell at the bounce.");

writeFileSync(join(OUT, 'boards.txt'), `${text.join('\n')}\n`);
writeFileSync(join(OUT, 'boards.json'), `${JSON.stringify({
  head, base: BASE, standardEqualsBase: sameAsBase, wallsAndPSame,
  lettersBefore: letters(STANDARD_ARENA.grid), lettersAfter: letters(ARENA_01.grid), before, after,
  player: P, brown: B, normalBounces: NORMAL_BOUNCES,
  phases: phases.map(({ board, ...rest }) => rest),
}, null, 1)}\n`);

// ---- PNGs: SVG rasterised by Chromium ----------------------------------------------------------
const CELL = 24;
const PAD = 16;
const BW = ARENA_01.cols * CELL;
const BH = ARENA_01.rows * CELL;
const px = (u: number) => (u / cs) * CELL;
const COLOR: Record<string, string> = {
  floor: '#1a1a1a', grid: '#262626', solid: '#7a8478', destructible: '#8a6a4a',
  leg1: '#3d7bd6', leg2: '#e0b040',
};
const kindColor = (k: string) => (tankDefs as any)[k].color as string;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function boardSvg(arena: any, opts: { breached?: boolean; marks?: Mark[] } = {}): string {
  const parts: string[] = [`<rect width="${BW}" height="${BH}" fill="${COLOR.floor}"/>`];
  const tint: Record<string, string> = { o: COLOR.leg1, '+': COLOR.leg2, X: '#ffffff' };
  for (const [c, rr, g] of opts.marks ?? []) {
    parts.push(`<rect x="${c * CELL}" y="${rr * CELL}" width="${CELL}" height="${CELL}" fill="${tint[g]}" fill-opacity="${g === 'X' ? 0.35 : 0.28}"/>`);
  }
  for (let c = 0; c <= arena.cols; c++) parts.push(`<line x1="${c * CELL}" y1="0" x2="${c * CELL}" y2="${BH}" stroke="${COLOR.grid}"/>`);
  for (let rr = 0; rr <= arena.rows; rr++) parts.push(`<line x1="0" y1="${rr * CELL}" x2="${BW}" y2="${rr * CELL}" stroke="${COLOR.grid}"/>`);
  arena.grid.forEach((row: string, rr: number) => [...row].forEach((ch, c) => {
    const kind = arena.legend[ch];
    if (!kind) return;
    if (kind === 'destructible' && opts.breached) {
      parts.push(`<rect x="${c * CELL + 2}" y="${rr * CELL + 2}" width="${CELL - 4}" height="${CELL - 4}" fill="none" stroke="${COLOR.destructible}" stroke-dasharray="3 3"/>`);
      return;
    }
    parts.push(`<rect x="${c * CELL}" y="${rr * CELL}" width="${CELL}" height="${CELL}" fill="${COLOR[kind]}"/>`);
  }));
  return parts.join('');
}
function tankSvg(kind: string, pos: V, label: string): string {
  const cx = px(pos.x), cy = px(pos.y), rad = px(TANK_RADIUS);
  return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${kindColor(kind)}" stroke="#fff" stroke-width="2"/>` +
    `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">${label}</text>`;
}
const LETTER: Record<string, string> = { player: 'P', brown: 'B', grey: 'G', teal: 'T' };

function panel(x: number, y: number, title: string, sub: string[], body: string): string {
  const lines = sub.map((s, i) => `<text x="0" y="${BH + 22 + i * 18}" font-size="13" fill="#c8c8c8">${esc(s)}</text>`).join('');
  return `<g transform="translate(${x},${y})"><text x="0" y="-10" font-size="17" font-weight="700" fill="#f0f0f0">${esc(title)}</text>` +
    `<g>${body}</g><rect width="${BW}" height="${BH}" fill="none" stroke="#555"/>${lines}</g>`;
}
function svgDoc(width: number, height: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="Helvetica, Arial, sans-serif">` +
    `<rect width="100%" height="100%" fill="#0e0e0e"/>${inner}</svg>`;
}

const TOP = 40;
const SUBH = 18 * 5 + 16;
const figW = PAD * 3 + BW * 2;
const figH = TOP + BH + SUBH + PAD;

const ba = svgDoc(figW, figH,
  panel(PAD, TOP, `Before: arena-01 at ${BASE} (STANDARD_ARENA), 3 enemies`, [
    'Brown column 13 row 7, Grey column 19 row 7, Teal column 16 row 10; player column 16 row 22.',
    `Fixture grid asserted equal to arena-01 at ${BASE} (git show).`,
    'Solid walls grey-green, destructible blocks brown; tank discs at TANK_RADIUS, catalog colours.',
  ], boardSvg(STANDARD_ARENA) + before.map((s: any) => tankSvg(s.kind, s.pos, LETTER[s.kind])).join('')) +
  panel(PAD * 2 + BW, TOP, `After: arena-01 at ${head.slice(0, 8)}, 1 enemy (a lone brown)`, [
    'Brown stays at column 13 row 7; the grey and teal letters became floor.',
    'Walls and the player spawn are unchanged (enemy letters read as floor: identical grids).',
    'Rendered from the repository data with loadArena positions; not a game frame.',
  ], boardSvg(ARENA_01) + after.map((s: any) => tankSvg(s.kind, s.pos, LETTER[s.kind])).join('')));

function pathBody(p: Phase, breached: boolean): string {
  const X = p.bounce;
  const box = p.reflectorBox;
  const refl = `<rect x="${px(box.minX)}" y="${px(box.minY)}" width="${px(box.maxX - box.minX)}" height="${px(box.maxY - box.minY)}" fill="none" stroke="#ffffff" stroke-width="2.5"/>`;
  const direct = `<line x1="${px(P.x)}" y1="${px(P.y)}" x2="${px(B.x)}" y2="${px(B.y)}" stroke="#d66c6c" stroke-width="2" stroke-dasharray="6 5"/>`;
  const legs = `<polyline points="${px(P.x)},${px(P.y)} ${px(X.x)},${px(X.y)}" fill="none" stroke="${COLOR.leg1}" stroke-width="3"/>` +
    `<polyline points="${px(X.x)},${px(X.y)} ${px(B.x)},${px(B.y)}" fill="none" stroke="${COLOR.leg2}" stroke-width="3"/>`;
  const bounce = `<circle cx="${px(X.x)}" cy="${px(X.y)}" r="5" fill="#fff"/>`;
  return boardSvg(ARENA_01, { breached, marks: p.marks }) + refl + direct + legs + bounce +
    tankSvg('player', P, 'P') + tankSvg('brown', B, 'B');
}
const pathFig = svgDoc(figW, figH + 18,
  phases.map((p, i) => panel(PAD + i * (PAD + BW), TOP, i === 0
    ? 'Level 1 bank shot, walls intact'
    : 'Level 1 bank shot, every destructible destroyed', [
    `bankShot(spawn, brown, walls, 1) = ${p.angle.toFixed(4)} rad; lineOfSight(spawn, brown) = ${p.directLine}.`,
    `Bounce (${p.bounce.x.toFixed(3)}, ${p.bounce.y.toFixed(3)}) on the ${p.face} of the ${p.reflector} (outlined).`,
    `Legs ${p.legs[0].toFixed(2)} + ${p.legs[1].toFixed(2)} = ${(p.legs[0] + p.legs[1]).toFixed(2)} units. Shaded cells: renderBoard marks`,
    `(${p.legCells[0]} leg-1 'o', ${p.legCells[1]} leg-2 '+', 1 bounce 'X'). Blue: leg 1; yellow: leg 2; white dot: bounce.`,
    'Red dashes: the direct line from the spawn to the brown, which lineOfSight reports blocked.',
    ...(i === 1 ? ['Dashed outlines: destroyed destructible blocks.'] : []),
  ], pathBody(p, i === 1))).join(''));

const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const browser = await chromium.launch();
try {
  for (const [name, svg, w, h] of [
    ['board-before-after.png', ba, figW, figH],
    ['bank-path.png', pathFig, figW, figH + 18],
  ] as const) {
    writeFileSync(join(OUT, name.replace('.png', '.svg')), svg);
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#0e0e0e">${svg}</body></html>`);
    await page.screenshot({ path: join(OUT, name), clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
    console.log(`wrote ${join(OUT, name)} (${w}x${h})`);
  }
} finally {
  await browser.close();
}
