/**
 * Visual verification: measure what the game actually paints.
 *
 * WHY THE OBVIOUS APPROACH DOES NOT WORK. An earlier harness read the canvas by
 * drawImage()ing it into a 2D canvas and calling getImageData. A WebGL canvas
 * without `preserveDrawingBuffer` reads back ALL BLACK that way, so that harness
 * reported "the canvas paints 100% black" while the screenshots it saved
 * alongside showed the game rendering correctly. Every number it printed was
 * false.
 *
 * This reads Playwright's screenshot instead -- the compositor's output, which
 * is what a player actually sees -- and decodes it by handing the PNG back into
 * the page as an <img>. An <img> is same-origin and safe to read, so no
 * preserveDrawingBuffer and no PNG library are needed.
 *
 * Usage:
 *   node tools/visual/verify.mjs <dist-dir> [--label NAME] [--out DIR]
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

/**
 * Playwright is NOT a dependency of this repo: the package downloads browsers
 * on install, which would slow every CI run for a tool that is not wired into
 * CI. Resolve it from the environment instead, in order of preference.
 */
async function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/home/dev/.claude/jobs/17681316/tmp/pw/node_modules/playwright/index.mjs',
  ].filter(Boolean);
  const tried = [];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      if (mod.chromium) return mod.chromium;
      tried.push(`${spec}: no chromium export`);
    } catch (e) {
      tried.push(`${spec}: ${e.code ?? e.message}`);
    }
  }
  throw new Error(
    `playwright not found. Set PLAYWRIGHT_MODULE, or npm i -D playwright.\nTried:\n  ${tried.join('\n  ')}`,
  );
}

/** scene.ts: renderer.setClearColor(0x14161c, 1) */
export const CLEAR = { r: 0x14, g: 0x16, b: 0x1c };
/** Channel distance under which a pixel counts as untouched background. */
const BG_TOLERANCE = 10;

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '390x844-phone', width: 390, height: 844 },
  { name: '1560x520-ultrawide', width: 1560, height: 520 },
];

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function serve(root) {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(root, url === '/' ? 'index.html' : url);
    if (!path.startsWith(root) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(500).end('error');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/**
 * Decode a PNG inside the page and measure it.
 *
 * Everything here is computed from the SCREENSHOT, never from the live WebGL
 * canvas, which is the whole point.
 */
const MEASURE = ([dataUri, clear, tol]) =>
  new Promise((done, fail) => {
    const img = new Image();
    img.onerror = () => fail(new Error('screenshot failed to decode'));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);

      const isBg = (i) =>
        Math.abs(data[i] - clear.r) <= tol &&
        Math.abs(data[i + 1] - clear.g) <= tol &&
        Math.abs(data[i + 2] - clear.b) <= tol;

      let bg = 0;
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      const colours = new Set();
      // Rows that contain any non-background pixel, for the detached-band check.
      const rowHasContent = new Uint8Array(height);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (isBg(i)) {
            bg++;
            continue;
          }
          rowHasContent[y] = 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (colours.size < 4096) {
            colours.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
          }
        }
      }

      const total = width * height;
      const painted = total - bg;

      // A detached band: content, then a run of empty rows, then content again.
      // This is the shape of the floating ground sliver that shipped -- a strip
      // of felt separated from the board by clear colour.
      // Report the raw runs and let the caller pick a threshold; a fixed one
      // silently merged the shipped ground sliver into the board, because the
      // gap between them is only a couple of rows.
      const runs = [];
      let runStart = -1;
      for (let y = 0; y <= height; y++) {
        const has = y < height && rowHasContent[y] === 1;
        if (has && runStart < 0) runStart = y;
        if (!has && runStart >= 0) {
          runs.push([runStart, y - 1]);
          runStart = -1;
        }
      }
      const gaps = [];
      for (let i = 1; i < runs.length; i++) gaps.push(runs[i][0] - runs[i - 1][1] - 1);
      const bands = runs.length;

      // The shipped ground sliver is NOT separable by row occupancy: the
      // platform's bottom edge slopes, so its rows overlap the sliver's and the
      // two read as one continuous run. What does separate them is WIDTH. The
      // board tapers to a point at its lowest rows; a detached strip of felt
      // spans nearly the whole board again underneath it. So: walk up from the
      // bottom of the bounding box and report the row widths. A re-widening
      // after a taper is the sliver's signature.
      const rowWidth = new Int32Array(height);
      for (let y = 0; y < height; y++) {
        let lo = -1;
        let hi = -1;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (!isBg(i)) {
            if (lo < 0) lo = x;
            hi = x;
          }
        }
        rowWidth[y] = lo < 0 ? 0 : hi - lo + 1;
      }
      // Widest row in the bottom eighth of the board, over the board's own width.
      // NOTE: with a tilted camera the platform's NEAR edge is its widest part,
      // so there is no taper here to re-widen from -- this reads ~100% whether
      // or not a sliver is present. Kept as a diagnostic, not as a detector.
      let reWiden = 0;
      let taperMin = Infinity;
      if (maxY >= 0) {
        const boardH = maxY - minY + 1;
        const boardW = Math.max(1, maxX - minX + 1);
        const from = maxY - Math.max(2, Math.floor(boardH / 8));
        for (let y = from; y <= maxY; y++) {
          taperMin = Math.min(taperMin, rowWidth[y] / boardW);
          reWiden = Math.max(reWiden, rowWidth[y] / boardW);
        }
      }

      // What DOES separate them is colour order. The board's lowest rows are the
      // grey platform's near edge; a detached strip of felt puts GREEN below the
      // lowest grey. Measure the mean colour of the board's bottom rows and how
      // far green persists past the last grey row.
      const isGreenish = (i) => data[i + 1] > data[i] + 8 && data[i + 1] > data[i + 2] + 8;
      const isGreyish = (i) =>
        Math.abs(data[i] - data[i + 1]) <= 12 &&
        Math.abs(data[i + 1] - data[i + 2]) <= 18 &&
        data[i] + data[i + 1] + data[i + 2] > 90;
      let lowestGreen = -1;
      let lowestGrey = -1;
      let bottomR = 0;
      let bottomG = 0;
      let bottomB = 0;
      let bottomN = 0;
      const bottomFrom = maxY >= 0 ? maxY - Math.max(1, Math.floor((maxY - minY + 1) * 0.02)) : 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (isBg(i)) continue;
          if (isGreenish(i) && y > lowestGreen) lowestGreen = y;
          if (isGreyish(i) && y > lowestGrey) lowestGrey = y;
          if (y >= bottomFrom && y <= maxY) {
            bottomR += data[i];
            bottomG += data[i + 1];
            bottomB += data[i + 2];
            bottomN++;
          }
        }
      }
      const greenBelowGrey = lowestGreen >= 0 && lowestGrey >= 0 ? lowestGreen - lowestGrey : 0;

      done({
        width,
        height,
        paintedFraction: painted / total,
        backgroundFraction: bg / total,
        distinctColours: colours.size,
        boardWidthFraction: maxX >= 0 ? (maxX - minX + 1) / width : 0,
        boardHeightFraction: maxY >= 0 ? (maxY - minY + 1) / height : 0,
        boardBox: { minX, maxX, minY, maxY },
        contentBands: bands,
        contentRuns: runs,
        contentGaps: gaps,
        bottomEighthWidestFraction: reWiden,
        bottomEighthNarrowestFraction: taperMin === Infinity ? 0 : taperMin,
        greenBelowGreyRows: greenBelowGrey,
        bottomStripMeanColour: bottomN
          ? {
              r: Math.round(bottomR / bottomN),
              g: Math.round(bottomG / bottomN),
              b: Math.round(bottomB / bottomN),
            }
          : null,
      });
    };
    img.src = dataUri;
  });

async function measureScreenshot(page, buffer) {
  const dataUri = `data:image/png;base64,${buffer.toString('base64')}`;
  return page.evaluate(MEASURE, [dataUri, CLEAR, BG_TOLERANCE]);
}


/**
 * Thresholds. Every one is placed between a MEASURED good value and a MEASURED
 * bad value, taken from the build before and after the camera-fit fix -- not
 * guessed. `node tools/visual/verify.mjs <dist> --check` exits non-zero if any
 * fails, which is what makes this a gate rather than a report.
 */
const BOARD_WIDTH_FLOOR = {
  '1280x800': 0.86,
  '1920x1080': 0.78,
  '1560x520-ultrawide': 0.46,
};

const CHECKS = [
  {
    name: 'canvas has a live GL context',
    // A lost or missing context is the failure the old harness THOUGHT it saw.
    ok: (r) => r.gl.canvas && r.gl.hasContext && r.gl.contextLost === false,
    detail: (r) => JSON.stringify(r.gl),
  },
  {
    name: 'page raised no errors',
    ok: (r) => r.errors.length === 0,
    detail: (r) => r.errors.join('; ') || 'none',
  },
  {
    name: 'something is actually painted',
    // The old harness reported 0%. Measured: 22-52% across viewports.
    ok: (r) => r.paintedFraction > 0.1,
    detail: (r) => `${(r.paintedFraction * 100).toFixed(1)}% painted`,
  },
  {
    name: 'the frame is not a flat fill',
    ok: (r) => r.distinctColours > 20,
    detail: (r) => `${r.distinctColours} distinct colours`,
  },
  {
    name: 'the board fills the viewport as well as the fit allows',
    // Per-viewport, because the fit binds on a different axis as the viewport
    // changes shape and one global threshold does not hold. Each number sits
    // between the MEASURED before/after pair for that viewport:
    //   1280x800   79.1 -> 93.1
    //   1920x1080  71.3 -> 83.8
    //   1560x520   42.2 -> 49.6
    // 390x844 phone is deliberately absent: it measures 100.0 before and 95.4
    // after, so it does NOT separate the two and any threshold there would be
    // decoration. Stated rather than quietly dropped.
    applies: (vp) => BOARD_WIDTH_FLOOR[vp.name] !== undefined,
    ok: (r, vp) => r.board.widthFraction > BOARD_WIDTH_FLOOR[vp.name],
    detail: (r) => `board is ${(r.board.widthFraction * 100).toFixed(1)}% of width`,
  },
  {
    name: 'no detached felt below the board',
    // The shipped sliver made the board's bottom rows green. Measured mean:
    // (21,42,33) with it, (30,33,38) without. Row-occupancy and row-width both
    // FAIL to see this -- the platform's sloping near edge overlaps the
    // sliver's rows and is also its widest part. Colour is what separates them.
    ok: (r) => {
      const c = r.board.bottomStripMeanColour;
      return !c || c.g - Math.max(c.r, c.b) < 5;
    },
    detail: (r) => {
      const c = r.board.bottomStripMeanColour;
      return c ? `bottom strip mean rgb(${c.r},${c.g},${c.b})` : 'n/a';
    },
  },
];

function runChecks(results) {
  let failed = 0;
  for (const r of results) {
    const vp = VIEWPORTS.find((v) => v.name === r.viewport);
    for (const c of CHECKS) {
      if (c.applies && !c.applies(vp)) {
        console.log(`  SKIP  ${r.viewport.padEnd(20)} ${c.name} -- does not discriminate here`);
        continue;
      }
      const pass = c.ok(r, vp);
      if (!pass) failed++;
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${r.viewport.padEnd(20)} ${c.name} -- ${c.detail(r)}`);
    }
  }
  return failed;
}

async function main() {
  const [distArg, ...rest] = process.argv.slice(2);
  if (!distArg) {
    console.error('usage: node tools/visual/verify.mjs <dist-dir> [--label NAME] [--out DIR]');
    process.exit(2);
  }
  const dist = resolve(distArg);
  const label = rest.includes('--label') ? rest[rest.indexOf('--label') + 1] : 'run';
  const outDir = resolve(rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : `visual-out/${label}`);
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`no index.html in ${dist} -- build first`);
    process.exit(2);
  }
  await mkdir(outDir, { recursive: true });

  const chromium = await loadChromium();
  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;

  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });

  const results = [];
  try {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(base, { waitUntil: 'load' });
      // Let the first frames render; the title screen is a static pose.
      await page.waitForTimeout(700);

      const gl = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        if (!c) return { canvas: false };
        const ctx = c.getContext('webgl2') ?? c.getContext('webgl');
        return {
          canvas: true,
          bufferWidth: c.width,
          bufferHeight: c.height,
          hasContext: !!ctx,
          contextLost: ctx ? ctx.isContextLost() : null,
        };
      });

      const shot = await page.screenshot({ type: 'png' });
      await writeFile(join(outDir, `${vp.name}.png`), shot);
      const metrics = await measureScreenshot(page, shot);

      // The HUD is DOM drawn over the canvas, so it lands in the screenshot and
      // widens the bounding box to the viewport edge -- which made
      // boardWidthFraction read ~97% for both a well-framed and a badly-framed
      // board. Hide everything in the root except the canvas and measure again;
      // THAT number is the board.
      const hidden = await page.evaluate(() => {
        const root = document.getElementById('app');
        if (!root) return 0;
        let n = 0;
        for (const el of Array.from(root.children)) {
          if (el.tagName !== 'CANVAS') {
            el.setAttribute('data-vis-hidden', '1');
            el.style.display = 'none';
            n++;
          }
        }
        return n;
      });
      const boardShot = await page.screenshot({ type: 'png' });
      await writeFile(join(outDir, `${vp.name}-board-only.png`), boardShot);
      const boardMetrics = await measureScreenshot(page, boardShot);

      results.push({
        viewport: vp.name,
        gl,
        errors,
        hudElementsHidden: hidden,
        ...metrics,
        board: {
          widthFraction: boardMetrics.boardWidthFraction,
          heightFraction: boardMetrics.boardHeightFraction,
          paintedFraction: boardMetrics.paintedFraction,
          contentBands: boardMetrics.contentBands,
          contentRuns: boardMetrics.contentRuns,
          contentGaps: boardMetrics.contentGaps,
          bottomEighthWidestFraction: boardMetrics.bottomEighthWidestFraction,
          bottomEighthNarrowestFraction: boardMetrics.bottomEighthNarrowestFraction,
          greenBelowGreyRows: boardMetrics.greenBelowGreyRows,
          bottomStripMeanColour: boardMetrics.bottomStripMeanColour,
          box: boardMetrics.boardBox,
        },
      });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const report = { label, dist, generatedFrom: 'playwright screenshot buffer', results };
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  for (const r of results) {
    console.log(
      `${r.viewport.padEnd(20)} painted=${(r.paintedFraction * 100).toFixed(1)}%` +
        ` boardW=${(r.board.widthFraction * 100).toFixed(1)}%` +
        ` boardH=${(r.board.heightFraction * 100).toFixed(1)}%` +
        ` colours=${r.distinctColours}` +
        ` greenBelowGrey=${r.board.greenBelowGreyRows}px bottomRGB=${r.board.bottomStripMeanColour ? Object.values(r.board.bottomStripMeanColour).join(',') : 'n/a'}` +
        ` errors=${r.errors.length}`,
    );
  }
  console.log(`\nreport + screenshots: ${outDir}`);

  if (rest.includes('--check')) {
    console.log('\nchecks:');
    const failed = runChecks(results);
    console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
