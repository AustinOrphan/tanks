/**
 * Issue #1055 evidence, second half: pixel-compare every before/after pair `capture.mjs` wrote
 * and lay the pairs out on labelled comparison sheets.
 *
 *   node sheets.mjs <worktree> <out-dir> <before-sha> <after-sha>
 *
 * Reads <out-dir>/readings.json; writes <out-dir>/diff.json and <out-dir>/sheet-*.png. The
 * comparison decodes both PNGs in Chromium and counts pixels whose RGBA differs at all, so
 * "0 px differ" means the two crops are pixel-identical, not merely similar.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [WORKTREE, OUT, BEFORE_SHA, AFTER_SHA] = process.argv.slice(2);
if (!WORKTREE || !OUT || !BEFORE_SHA || !AFTER_SHA) {
  console.error('usage: node sheets.mjs <worktree> <out-dir> <before-sha> <after-sha>');
  process.exit(2);
}
const { loadChromium } = await import(pathToFileURL(join(WORKTREE, 'tools/shared/playwright.mjs')).href);
const R = JSON.parse(readFileSync(join(OUT, 'readings.json'), 'utf8'));
const B = R.trees.before;
const A = R.trees.after;
/** HEAD's tree captured a second time: the noise floor every before/after verdict sits on. */
const RP = R.trees.repeat;
const short = (s) => s.slice(0, 8);
const BEFORE_LABEL = `BEFORE: merge base ${short(BEFORE_SHA)} (hud.css identical on origin/main)`;
const AFTER_LABEL = `AFTER: HEAD ${short(AFTER_SHA)}`;

const uri = (file) => `data:image/png;base64,${readFileSync(join(OUT, file)).toString('base64')}`;

const chromium = await loadChromium();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

  /** Pixels whose RGBA differs between two PNGs, or a size mismatch. */
  async function differ(fileA, fileB) {
    return page.evaluate(async ([a, b]) => {
      const load = async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return { w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data };
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.w !== y.w || x.h !== y.h) return { size: `${x.w}x${x.h} vs ${y.w}x${y.h}`, pixels: null, of: null };
      let n = 0;
      for (let i = 0; i < x.d.length; i += 4) {
        if (x.d[i] !== y.d[i] || x.d[i + 1] !== y.d[i + 1] || x.d[i + 2] !== y.d[i + 2] || x.d[i + 3] !== y.d[i + 3]) n += 1;
      }
      return { size: `${x.w}x${x.h}`, pixels: n, of: x.w * x.h };
    }, [uri(fileA), uri(fileB)]);
  }

  const diff = { rest: [], cue: [] };
  for (let i = 0; i < B.rest.length; i++) {
    const b = B.rest[i];
    const a = A.rest[i];
    diff.rest.push({
      config: `${b.players}x${b.stocks}`, before: b.file, after: a.file, ...(await differ(b.file, a.file)),
      noise: (await differ(a.file, RP.rest[i].file)).pixels,
    });
  }
  for (let i = 0; i < B.cue.length; i++) {
    const b = B.cue[i];
    const a = A.cue[i];
    const rp = RP.cue[i];
    const frames = [];
    for (let f = 0; f < b.frames.length; f++) {
      frames.push({
        ms: b.frames[f].ms, ...(await differ(b.frames[f].file, a.frames[f].file)),
        noise: (await differ(a.frames[f].file, rp.frames[f].file)).pixels,
      });
    }
    diff.cue.push({
      id: b.id, motion: b.motion, frames,
      heldTopbar: { ...(await differ(b.held.topbar, a.held.topbar)), noise: (await differ(a.held.topbar, rp.held.topbar)).pixels },
      heldEntry: { ...(await differ(b.held.entry, a.held.entry)), noise: (await differ(a.held.entry, rp.held.entry)).pixels },
    });
  }
  const noises = [
    ...diff.rest.map((d) => d.noise),
    ...diff.cue.flatMap((d) => [...d.frames.map((f) => f.noise), d.heldTopbar.noise, d.heldEntry.noise]),
  ];
  diff.noiseFloor = { crops: noises.length, maxPixels: Math.max(...noises), nonZero: noises.filter((n) => n !== 0).length };
  writeFileSync(join(OUT, 'diff.json'), `${JSON.stringify(diff, null, 2)}\n`);
  const NOISE = `Noise floor: HEAD's tree captured twice differs by at most ${diff.noiseFloor.maxPixels} px `
    + `(${diff.noiseFloor.nonZero} of ${diff.noiseFloor.crops} crops non-zero).`;

  const CSS = `
    body { margin: 0; background: #101010; color: #e8e8e8; font: 15px/1.4 -apple-system, system-ui, sans-serif; }
    .sheet { padding: 20px 24px; display: inline-block; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #aaa; margin: 0 0 16px; font-size: 13px; }
    h2 { font-size: 15px; margin: 18px 0 6px; }
    table { border-collapse: collapse; }
    td, th { padding: 4px 8px; vertical-align: middle; text-align: left; }
    th { font-size: 12px; color: #bbb; font-weight: 600; }
    th.b, td.b { border-left: 3px solid #d08a2c; }
    th.a, td.a { border-left: 3px solid #3fa66b; }
    .lbl { font-size: 13px; white-space: nowrap; }
    .cap { font-size: 12px; color: #bbb; }
    .same { color: #8fd18f; }
    .diff { color: #ffb15c; font-weight: 600; }
    .wrap { position: relative; display: inline-block; line-height: 0; }
    .edge { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px dashed #4fc3f7; }
    img { display: block; }
  `;
  const verdict = (d) => (d.pixels === null ? `<span class="diff">size ${d.size}</span>`
    : d.pixels === 0 ? '<span class="same">identical (0 px differ)</span>'
      : `<span class="diff">${d.pixels} px differ</span>`);
  /** A topbar crop at half its 3x natural size (1.5x CSS), with the 380px content edge dashed. */
  const topbarImg = (file) => `<div class="wrap"><img src="${uri(file)}" width="585">`
    + '<div class="edge" style="left:570px"></div></div>';
  async function shoot(html, file) {
    const body = html.replace('</p>', ` ${NOISE}</p>`);
    await page.setContent(`<!doctype html><style>${CSS}</style><div class="sheet">${body}</div>`);
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$('.sheet');
    await el.screenshot({ path: join(OUT, file) });
  }

  // 1. Every teams configuration at rest.
  {
    let rows = '';
    for (let i = 0; i < B.rest.length; i++) {
      const b = B.rest[i];
      const a = A.rest[i];
      rows += `<tr><td class="lbl">${b.players} players x ${b.stocks} stocks<br>`
        + `<span class="cap">rung ${a.layout} | strip ${a.width}px | spare ${a.spare}px</span><br>`
        + `<span class="cap">${verdict(diff.rest[i])}</span></td>`
        + `<td class="b">${topbarImg(b.file)}</td><td class="a">${topbarImg(a.file)}</td></tr>`;
    }
    await shoot(
      '<h1>Issue #1055: the teams stock strip at rest, all 10 configurations</h1>'
      + '<p class="sub">390x844 viewport, UI scale 100%, `marks` arm (a teams entry draws `pips`; the markup was '
      + 'checked identical under `pips` for every row). Lettered A, B, A, B. Mounted by HEAD\'s '
      + '<code>tools/hud/strip-width-page.ts</code> in each tree. Dashed line: the topbar content edge at 380px. '
      + 'Rung "10+n" is the one-pip fallback (one 10px pip plus the count).</p>'
      + `<table><tr><th></th><th class="b">${BEFORE_LABEL}</th><th class="a">${AFTER_LABEL}</th></tr>${rows}</table>`,
      'sheet-1-rest-teams-all-10.png',
    );
  }

  // 2. The held frame, 1.5s after the loss, per scenario and motion.
  const pipCap = (p) => `border ${p.borderTopWidth}, opacity ${p.opacity}`;
  const held = (scenarios, file, title, sub) => {
    let body = '';
    for (const s of scenarios) {
      body += `<h2>${s.title}</h2><table><tr><th></th><th class="b">${BEFORE_LABEL}</th><th class="a">${AFTER_LABEL}</th></tr>`;
      for (const motion of ['full', 'reduced']) {
        const i = B.cue.findIndex((c) => c.id === s.id && c.motion === motion);
        const b = B.cue[i];
        const a = A.cue[i];
        body += `<tr><td class="lbl">${motion} motion<br><span class="cap">${verdict(diff.cue[i].heldTopbar)}</span></td>`
          + `<td class="b">${topbarImg(b.held.topbar)}<div class="cap">P1 pip held: ${pipCap(b.held.pip)}</div></td>`
          + `<td class="a">${topbarImg(a.held.topbar)}<div class="cap">P1 pip held: ${pipCap(a.held.pip)}</div></td></tr>`;
      }
      body += '</table>';
    }
    return shoot(`<h1>${title}</h1><p class="sub">${sub}</p>${body}`, file);
  };
  const changed = R.scenarios.filter((s) => s.changed && s.id.startsWith('teams'));
  const controls = R.scenarios.filter((s) => !s.changed);
  const ffa = R.scenarios.filter((s) => s.id.startsWith('ffa'));
  await held(
    changed, 'sheet-2-held-after-loss-changed.png',
    'Issue #1055: the one-pip fallback 1.5s after a loss that leaves the player stock (CHANGED)',
    '390x844, UI scale 100%, `marks` arm, teams A, B, A, B. The strip was left alone for 1.5s of real time after '
    + 'the loss; nothing frozen. A filled 10px pip is a 5px border; a lost pip is a 2px ring. Before, the '
    + 'held pip ends hollow beside a non-zero count; after, it stays filled.',
  );
  await held(
    controls, 'sheet-3-held-after-loss-controls.png',
    'Issue #1055 controls: cues whose pip IS lost, which the new rule must not touch (UNCHANGED)',
    '390x844, UI scale 100%, `marks` arm, teams. 4x4 down to 0 (the fallback pip goes `--lost`) and 3x5 on a '
    + '9/2 row (a row cue pip is always `--lost`; the reading is that pip).',
  );
  await held(
    ffa, 'sheet-4-held-after-loss-ffa-supplementary.png',
    'Supplementary: FFA under `pips` takes the same one-pip fallback at 4 players x 4-5 stocks',
    'Not a teams strip; shown because the CSS rule is shared. 390x844, UI scale 100%, with the identity mark the page draws.',
  );

  // 3. Filmstrips: the cue frozen at fixed times, then the held frame.
  for (const s of R.scenarios) {
    let rows = `<tr><th></th>${R.framesMs.map((ms) => `<th>t = ${ms} ms</th>`).join('')}<th>held ${R.heldMs} ms (real time)</th></tr>`;
    for (const motion of ['full', 'reduced']) {
      const i = B.cue.findIndex((c) => c.id === s.id && c.motion === motion);
      for (const [side, t, cls, label] of [['before', B, 'b', BEFORE_LABEL], ['after', A, 'a', AFTER_LABEL]]) {
        const c = t.cue[i];
        rows += `<tr><td class="lbl ${cls}">${motion} motion<br><span class="cap">${label}</span></td>`
          + c.frames.map((f, k) => `<td class="${cls}"><img src="${uri(f.file)}" height="104"><div class="cap">${pipCap(f.pip)}`
            + `${side === 'after' ? `<br>${verdict(diff.cue[i].frames[k])}` : ''}</div></td>`).join('')
          + `<td class="${cls}"><img src="${uri(c.held.entry)}" height="104"><div class="cap">${pipCap(c.held.pip)}`
          + `${side === 'after' ? `<br>${verdict(diff.cue[i].heldEntry)}` : ''}</div></td></tr>`;
      }
    }
    await shoot(
      `<h1>${s.title}</h1><p class="sub">P1's entry, 2x CSS size. Animations paused at each time with the Web `
      + 'Animations API (pip and its burst ring alike); the last column is a separate run left alone for 1.5s. '
      + 'Verdicts compare each after frame with the before frame above it.</p>'
      + `<table>${rows}</table>`,
      `sheet-5-frames-${s.id}.png`,
    );
  }
  console.log(JSON.stringify({
    rest: diff.rest.map((d) => `${d.config}:${d.pixels}`).join(' '),
    cue: diff.cue.map((d) => `${d.id}/${d.motion}: frames ${d.frames.map((f) => f.pixels).join(',')} held ${d.heldTopbar.pixels}/${d.heldEntry.pixels}`),
    noiseFloor: diff.noiseFloor,
  }, null, 2));
} finally {
  await browser.close();
}
