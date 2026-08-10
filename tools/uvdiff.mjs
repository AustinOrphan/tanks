/**
 * Compare two rendered frames pixel-for-pixel: how many differ, where, and the exact
 * byte difference inside a rectangle. This is the tool the PR's turret-unchanged
 * evidence comes from, so it is kept rather than being a scratch script -- a number
 * nobody can re-derive is not evidence.
 *
 *   node tools/uvdiff.mjs a.png b.png [W] [H] [--rect=X,Y,W,H]
 *
 * PNG decoding shells out to `ffmpeg`, which is why the CLI half is separated from the
 * comparison half: `compare()` below is pure, takes raw RGBA buffers, and is what
 * `uvdiff.test.ts` exercises. Nothing in `tools/` is typechecked (see CLAUDE.md), so the
 * test is the only thing standing behind this file.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Compare two RGBA buffers. Alpha is deliberately ignored: these frames are opaque and a
 * difference that is alpha-only is not something a viewer can see.
 *
 * Returns the differing-pixel count, the bounding box of the differences, and -- when a
 * rect is given -- the count and summed absolute channel difference inside it.
 */
export function compare(a, b, W, H, rect = null) {
  let differing = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const differs = (i) => a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!differs((y * W + x) * 4)) continue;
      differing++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const out = { total: W * H, differing, bbox: differing ? { minX, minY, maxX, maxY } : null };
  if (rect) {
    const [rx, ry, rw, rh] = rect;
    let px = 0;
    let bytes = 0;
    const coords = [];
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = (y * W + x) * 4;
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (!d) continue;
        px++;
        bytes += d;
        if (coords.length < 40) coords.push([x, y]);
      }
    }
    out.rect = { pixels: px, bytes, coords };
  }
  return out;
}

/** An ASCII heat map of where the differences are, for eyeballing a whole frame. */
export function heatMap(a, b, W, H, cols = 60, rows = 30) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
      grid[Math.floor((y / H) * rows)][Math.floor((x / W) * cols)]++;
    }
  }
  return grid.map((row) => row.map((n) => (n === 0 ? '.' : n < 20 ? '-' : n < 100 ? '+' : '#')).join(''));
}

function raw(file, w, h) {
  return execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-'],
    { maxBuffer: 1 << 30 },
  );
}

// CLI only when run directly, so the test can import the pure half without shelling out.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , fileA, fileB, wArg, hArg, ...rest] = process.argv;
  const W = Number(wArg ?? 900);
  const H = Number(hArg ?? 700);
  const a = raw(fileA, W, H);
  const b = raw(fileB, W, H);
  const rectArg = rest.find((s) => s.startsWith('--rect='));
  const rect = rectArg ? rectArg.slice(7).split(',').map(Number) : null;
  const r = compare(a, b, W, H, rect);
  console.log(`${fileA}\n  vs ${fileB}`);
  console.log(`  differing pixels: ${r.differing} of ${r.total} (${((r.differing / r.total) * 100).toFixed(2)}%)`);
  if (r.bbox) console.log(`  bbox: x ${r.bbox.minX}..${r.bbox.maxX}, y ${r.bbox.minY}..${r.bbox.maxY}`);
  for (const row of heatMap(a, b, W, H)) console.log('  |' + row);
  if (r.rect) {
    console.log(`  rect ${rect.join(',')}: ${r.rect.pixels} differing pixels, total byte difference ${r.rect.bytes}`);
    for (const [x, y] of r.rect.coords) console.log(`    (${x},${y})`);
  }
}
