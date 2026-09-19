import { writeFileSync, mkdirSync } from 'node:fs';
import { hullPlan, HULL_LEN, BODY_WIDTH, HULL_CORNER } from '../../src/render/tank-model';
import { encodePng } from '../icons/render.mjs';

/**
 * If the corner can only go DOWN from shipped, what do the states look like going that way?
 *
 * The clamp is min(round, halfW * 0.9, halfL * 0.45) = min(round, 0.394, 0.225), so the shipped
 * 0.3 already sits at 0.225 and nothing can be rounder. Every candidate below is at or under it.
 */
const CANDS = [
  { id: 'shipped', nose: 1, corner: HULL_CORNER, label: 'shipped' },
  { id: 'square', nose: 1, corner: 0.06, label: 'nose 1, corner 0.06' },
  { id: 'half', nose: 1, corner: 0.14, label: 'nose 1, corner 0.14' },
  { id: 'wedge', nose: 0.62, corner: 0.225, label: 'nose 0.62, corner round' },
  { id: 'wedge-square', nose: 0.62, corner: 0.06, label: 'nose 0.62, corner 0.06' },
  { id: 'taper-mid', nose: 0.8, corner: 0.14, label: 'nose 0.8, corner 0.14' },
];

const outline = (c) => hullPlan(HULL_LEN, BODY_WIDTH, c.corner, c.nose).getPoints(240);
const key = (c) => outline(c).map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join(' ');

console.log('pairwise distinctness (a geometry equal to another is a state that reads as it):');
const keys = CANDS.map((c) => ({ c, k: key(c) }));
let collisions = 0;
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    if (keys[i].k === keys[j].k) { collisions++; console.log(`  IDENTICAL: ${keys[i].c.id} == ${keys[j].c.id}`); }
  }
}
console.log(collisions ? `  ${collisions} collision(s)` : '  all distinct');

// How far each sits from the shipped outline, in world units at the worst vertex.
const base = outline(CANDS[0]);
console.log('\nmax vertex displacement from shipped, world units:');
for (const c of CANDS) {
  const pts = outline(c);
  let max = 0;
  for (let i = 0; i < pts.length; i++) {
    max = Math.max(max, Math.hypot(pts[i].x - base[i].x, pts[i].y - base[i].y));
  }
  console.log(`  ${c.id.padEnd(13)} ${max.toFixed(4)}  (${(max / BODY_WIDTH * 100).toFixed(1)}% of hull width)`);
}

// ---- draw them ----
const COLS = 3, ROWS = 2, CW = 300, CH = 250, SCALE = 200;
const W = COLS * CW, H = ROWS * CH;
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) rgba.set([22, 24, 26, 255], i * 4);
const disc = (x, y, r, col) => {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    const px = Math.round(x + dx), py = Math.round(y + dy);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    rgba.set(col, (py * W + px) * 4);
  }
};
const draw = (cx, cy, c, col, thick) => {
  const pts = outline(c);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let s = 0; s <= 40; s++) {
      const t = s / 40;
      disc(cx + (a.x + (b.x - a.x) * t) * SCALE, cy - (a.y + (b.y - a.y) * t) * SCALE, thick, col);
    }
  }
};
const GHOST = [70, 78, 70, 255];
const INK = [232, 196, 84, 255];
CANDS.forEach((c, i) => {
  const cx = (i % COLS) * CW + CW / 2;
  const cy = Math.floor(i / COLS) * CH + CH / 2;
  if (c.id !== 'shipped') draw(cx, cy, CANDS[0], GHOST, 1);   // shipped underneath, for reference
  draw(cx, cy, c, c.id === 'shipped' ? [125, 138, 120, 255] : INK, 2);
});
mkdirSync('/home/dev/.claude/jobs/5ecc62fa/tmp/plans', { recursive: true });
writeFileSync('/home/dev/.claude/jobs/5ecc62fa/tmp/plans/corner-downward.png', encodePng({ width: W, height: H, rgba }));
console.log('\nwrote corner-downward.png  (order: ' + CANDS.map((c) => c.label).join(' | ') + ')');
