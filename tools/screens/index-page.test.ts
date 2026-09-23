import { describe, expect, it } from 'vitest';

import { captureKey, escapeHtml, renderIndexPage, sweepGrid } from './index-page.mjs';

/**
 * Issue #936. A sweep is about 441 files; this is the page that presents them. The renderer is
 * pure, so every case here is a value in and a string out -- no sweep on disk, no browser.
 */

const LAYOUTS = [
  { name: '320x568', width: 320, height: 568, dpr: 2 },
  { name: '1280x800', width: 1280, height: 800, dpr: 1 },
];

const STATES = [
  { id: 'screen.main-menu', title: 'Main Menu', description: 'The menu a returning player meets.' },
  { id: 'screen.customize', title: 'Customize', description: 'The paint shop.' },
];

function manifest(results: unknown[], extra: Record<string, unknown> = {}) {
  return {
    states: STATES.map((s) => s.id),
    layouts: LAYOUTS,
    results,
    captures: results.length,
    failed: results.filter((r) => !(r as { ok?: boolean }).ok).length,
    source: 'abc1234',
    dist: 'dist',
    complete: true,
    ...extra,
  } as never;
}

const ok = (state: string, layout: string, pageErrors = 0) => ({
  state, layout, ok: true, sha256: 'x', measurementsSha256: 'y', pageErrors,
});

describe('sweepGrid: the sweep as a states-by-layouts grid', () => {
  it('gives every state a row and every layout a cell, in the manifest order', () => {
    const grid = sweepGrid(
      manifest(STATES.flatMap((s) => LAYOUTS.map((l) => ok(s.id, l.name)))),
      STATES,
    );
    expect(grid.rows.map((r) => r.id)).toEqual(['screen.main-menu', 'screen.customize']);
    for (const row of grid.rows) {
      expect(row.cells.map((c) => c.layout)).toEqual(['320x568', '1280x800']);
      expect(row.cells.every((c) => c.status === 'ok')).toBe(true);
    }
  });

  it('marks a missing capture absent rather than dropping the cell', () => {
    // The case this exists for: `--states`/`--layouts` and a stopped sweep both produce a
    // manifest whose `results` does not cover the grid. Negative control: returning only the
    // results that exist gives this row ONE cell, and the two layouts stop lining up down the
    // page -- which is the one thing a grid has to get right.
    const grid = sweepGrid(manifest([ok('screen.main-menu', '320x568')]), STATES);
    expect(grid.rows[0].cells.map((c) => c.status)).toEqual(['ok', 'absent']);
    expect(grid.rows[1].cells.map((c) => c.status)).toEqual(['absent', 'absent']);
  });

  it('keeps a failed capture as a cell, with its error', () => {
    const grid = sweepGrid(
      manifest([{ state: 'screen.main-menu', layout: '320x568', ok: false, error: 'timed out' }]),
      STATES,
    );
    expect(grid.rows[0].cells[0]).toMatchObject({ status: 'failed', error: 'timed out' });
  });

  it('falls back to the id when the catalogue has no entry for a swept state', () => {
    // A sweep taken on another build can name a state this checkout does not have. The row
    // still has to appear, or the grid silently loses a column of evidence.
    const grid = sweepGrid(manifest([ok('screen.gone', '320x568')], { states: ['screen.gone'] }), STATES);
    expect(grid.rows[0]).toMatchObject({ id: 'screen.gone', title: 'screen.gone', description: '' });
  });
});

describe('renderIndexPage: the page a reviewer opens', () => {
  const full = () =>
    sweepGrid(manifest(STATES.flatMap((s) => LAYOUTS.map((l) => ok(s.id, l.name)))), STATES, {
      [captureKey('screen.main-menu', '320x568')]: [
        { selector: '.hud-panel', present: true, box: { x: 0, y: 0, w: 288, h: 520 } },
        { selector: '.hud-title', present: false },
      ],
    });

  it('points every cell at the png the sweep wrote, lazily', () => {
    const html = renderIndexPage(full(), manifest([]));
    expect(html).toContain('src="screen.main-menu/320x568.png"');
    expect(html).toContain('src="screen.customize/1280x800.png"');
    // 441 eagerly-decoded PNGs is what makes a page like this unusable on the device it is
    // for. Negative control: dropping the attribute leaves this the only failing assertion.
    expect(html.match(/loading="lazy"/g)?.length).toBe(4);
  });

  it('captions a cell with the selectors that were measured and their size', () => {
    const html = renderIndexPage(full(), manifest([]));
    expect(html).toContain('.hud-panel 288x520');
    // A selector the state declared but the screen did not have has no box, and a caption
    // reading `.hud-title undefinedxundefined` is worse than no caption.
    expect(html).not.toContain('.hud-title');
  });

  it('declares one grid column per layout, plus the state column', () => {
    const html = renderIndexPage(full(), manifest([]));
    expect(html).toContain('repeat(2, minmax(0, 1fr))');
    for (const l of LAYOUTS) expect(html).toContain(`${l.width}x${l.height} @${l.dpr}x`);
  });

  it('says so on the page when the sweep did not finish or lost captures', () => {
    const grid = sweepGrid(manifest([]), STATES);
    const stopped = renderIndexPage(grid, manifest([], { complete: false, failed: 3 }));
    expect(stopped).toContain('This sweep did not finish.');
    expect(stopped).toContain('3 capture(s) failed.');
    // ...and does not invent a warning on a clean run.
    const clean = renderIndexPage(grid, manifest([], { complete: true, failed: 0 }));
    expect(clean).not.toContain('did not finish');
    expect(clean).not.toContain('capture(s) failed');
  });

  it('stops being a 9-column grid below TV width, and names the layout in the cell instead', () => {
    // MEASURED on the full 49x9 page, which is the only size where this bites. The wide
    // template gives a 92px cell at 1920 -- the TV case the issue is about -- but 20px at
    // 1280 and a sideways overflow at 390 (443 against a 390 viewport). After the fallback:
    // 157px at 1280 and 262px at 390, neither scrolling sideways. jsdom does no layout, so
    // this asserts the rules that produced those numbers rather than the numbers.
    const html = renderIndexPage(full(), manifest([]));
    expect(html, 'the narrow fallback is gone, so 1280 and below get a 20px cell')
      .toContain('@media (max-width: 1599px)');
    expect(html).toContain('grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));');
    // The fallback hides the header row, so the layout name has to travel into the cell or a
    // wrapped strip is thumbnails with nothing saying which layout each one is.
    expect(html).toContain('data-layout="320x568"');
    expect(html).toContain("content: attr(data-layout)");
    // ...and the wide template is still what the grid uses by default.
    expect(html).toContain('style="--cols: minmax(220px, 1fr) repeat(2, minmax(0, 1fr));"');
  });

  it('marks a capture that raised page errors', () => {
    const grid = sweepGrid(manifest([ok('screen.main-menu', '320x568', 2)]), STATES);
    expect(renderIndexPage(grid, manifest([]))).toContain('2 page error(s)');
  });

  it('escapes authored text rather than letting it open a tag', () => {
    const grid = sweepGrid(manifest([ok('s', '320x568')], { states: ['s'] }), [
      { id: 's', title: 'A <script>', description: 'x & "y"' },
    ]);
    const html = renderIndexPage(grid, manifest([]));
    expect(html).toContain('A &lt;script&gt;');
    expect(html).toContain('x &amp; &quot;y&quot;');
    expect(html).not.toContain('<script>');
  });

  it('escapes each of the four characters that matter', () => {
    // The ampersand FIRST, or every other replacement is double-escaped. Negative control:
    // moving that line below the others makes `&lt;` come back as `&amp;lt;`.
    expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
  });
});
