/**
 * Compare two PNGs pixel-for-pixel: how many differ, where, and (optionally) the exact
 * byte difference inside a rectangle. Decodes via ffmpeg so it needs no image library.
 *
 *   node tools/uvdiff.mjs a.png b.png [W] [H] [--rect X,Y,W,H]
 */
import { execFileSync } from 'node:child_process';

function raw(file, w, h) {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-'],
    { maxBuffer: 1 << 30 },
  );
}

const [, , fileA, fileB, wArg, hArg, ...rest] = process.argv;
const W = Number(wArg ?? 900);
const H = Number(hArg ?? 700);
const a = raw(fileA, W, H);
const b = raw(fileB, W, H);

let differing = 0;
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const COLS = 60, ROWS = 30;
const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
    differing++;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    grid[Math.floor((y / H) * ROWS)][Math.floor((x / W) * COLS)]++;
  }
}
console.log(`${fileA}\n  vs ${fileB}`);
console.log(`  differing pixels: ${differing} of ${W * H} (${((differing / (W * H)) * 100).toFixed(2)}%)`);
if (differing) console.log(`  bbox: x ${minX}..${maxX}, y ${minY}..${maxY}`);
for (const row of grid) console.log('  |' + row.map((n) => (n === 0 ? '.' : n < 20 ? '-' : n < 100 ? '+' : '#')).join(''));

const rectArg = rest.find((s) => s.startsWith('--rect='));
if (rectArg) {
  const [rx, ry, rw, rh] = rectArg.slice(7).split(',').map(Number);
  let bytes = 0, px = 0;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * W + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(a[i + c] - b[i + c]);
      if (d) { px++; bytes += d; }
    }
  }
  console.log(`  rect ${rx},${ry} ${rw}x${rh}: ${px} differing pixels, total byte difference ${bytes}`);
  if (px > 0 && px <= 40) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = (y * W + x) * 4;
        if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
        console.log(`    (${x},${y}) ${a[i]},${a[i + 1]},${a[i + 2]} -> ${b[i]},${b[i + 1]},${b[i + 2]}`);
      }
    }
  }
  const RC = 70, RR = 26;
  const rg = Array.from({ length: RR }, () => new Array(RC).fill(0));
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const i = (y * W + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
      rg[Math.floor(((y - ry) / rh) * RR)][Math.floor(((x - rx) / rw) * RC)]++;
    }
  }
  for (const row of rg) console.log('  R|' + row.map((n) => (n === 0 ? '.' : n < 5 ? '-' : '#')).join(''));
}
