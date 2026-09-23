/**
 * One page that presents a sweep, instead of a directory of it (issue #936).
 *
 * `sweep.mjs` writes `<state>/<layout>.png` with a report beside it. At 49 states and 9
 * layouts that is about 441 files plus a manifest, which no one reviews in a file browser.
 * This lays the same files out as the grid the sweep already is: one row per state, one
 * column per layout.
 *
 * PURE, and separate from the command that writes it, for the two reasons this directory has
 * learned the hard way. A renderer that reads the disk cannot be unit-tested without a sweep
 * on disk; and a module that runs a CLI at import time deadlocks anything that imports it
 * (issue #947 measured that: Node exits 13 with "unsettled top-level await" and no cause).
 * `index-page-run.mjs` does the reading and writing; everything here takes values.
 *
 * IT IS OPENED ON THE TV. That is the point of the issue, not a nicety: the couch-distance
 * pass in the manual accessibility protocol is otherwise a file browse from the sofa. So the
 * grid fits 9 columns inside 1920 px and the page scrolls in one axis only -- the rule
 * issue #327 criterion 5 states for the game applies to the tool a reviewer reads beside it.
 */

/** HTML-escape. Descriptions are authored text and a `<` in one must not open a tag. */
export function escapeHtml(/** @type {unknown} */ value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The key a capture is looked up by. One string rather than nested maps, because the callers
 * on both sides of this module iterate the manifest's flat `results` array.
 */
export function captureKey(/** @type {string} */ stateId, /** @type {string} */ layoutName) {
  return `${stateId}|${layoutName}`;
}

/**
 * The sweep as a grid, with every cell accounted for.
 *
 * A state and layout the manifest has no result for becomes a cell with `status: 'absent'`
 * rather than being dropped. A partial sweep (`--states`, or one stopped part-way) is the
 * normal case here, and a grid that silently omitted its gaps would read as a complete run.
 *
 * @param {{ states: string[], layouts: { name: string }[], results: any[] }} manifest
 * @param {{ id: string, title?: string, description?: string }[]} states
 * @param {Record<string, { selector: string, box?: { w: number, h: number } }[]>} [boxes]
 */
export function sweepGrid(manifest, states, boxes = {}) {
  const byId = new Map(states.map((s) => [s.id, s]));
  const results = new Map(manifest.results.map((r) => [captureKey(r.state, r.layout), r]));
  return {
    layouts: manifest.layouts,
    rows: manifest.states.map((id) => {
      const state = byId.get(id);
      return {
        id,
        title: state?.title ?? id,
        description: state?.description ?? '',
        cells: manifest.layouts.map((layout) => {
          const result = results.get(captureKey(id, layout.name));
          if (result === undefined) return { layout: layout.name, status: 'absent' };
          if (!result.ok) return { layout: layout.name, status: 'failed', error: result.error ?? '' };
          return {
            layout: layout.name,
            status: 'ok',
            png: `${id}/${layout.name}.png`,
            pageErrors: result.pageErrors ?? 0,
            measured: boxes[captureKey(id, layout.name)] ?? [],
          };
        }),
      };
    }),
  };
}

/** `.hud-panel 520x640`, or nothing when the state measured nothing at this layout. */
function measuredCaption(/** @type {{selector: string, box?: {w: number, h: number}}[]} */ measured) {
  const sized = measured.filter((m) => m.box !== undefined);
  if (sized.length === 0) return '';
  return sized.map((m) => `${m.selector} ${m.box.w}x${m.box.h}`).join(' · ');
}

const STYLE = `
:root { color-scheme: dark; --gap: 12px; --caption: 15px; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: #14171d; color: #e7ecf4;
  font: 16px/1.45 system-ui, sans-serif; }
h1 { font-size: 28px; margin: 0 0 4px; }
.meta { color: #aab3c0; font-size: var(--caption); margin: 0 0 24px; }
.meta code { color: #e7ecf4; }
.grid { display: grid; gap: var(--gap); align-items: start; }
.head, .state { position: sticky; }
.head { top: 0; z-index: 1; background: #14171d; padding: 4px 0;
  font-size: var(--caption); color: #aab3c0; }
.state { left: 0; }
.state h2 { font-size: 17px; margin: 0 0 2px; }
.state p { margin: 0; color: #aab3c0; font-size: var(--caption); }
.cell { background: #1d222b; border-radius: 8px; padding: 8px; }
.cell img { width: 100%; height: auto; display: block; border-radius: 4px; background: #0b0e14; }
.cell figcaption { font-size: 13px; color: #aab3c0; margin-top: 6px; word-break: break-word; }
.cell--failed { background: #3a1f22; }
.cell--absent { background: #23262c; color: #8891a0; font-size: 13px; }
.warn { color: #ffb86b; }
`;

/**
 * The page.
 *
 * `loading="lazy"` on every image and no JavaScript at all: 441 PNGs decoded eagerly is what
 * makes a page like this unusable on the device it exists for.
 *
 * @param {ReturnType<typeof sweepGrid>} grid
 * @param {{ source?: string, dist?: string, complete?: boolean, captures?: number, failed?: number }} manifest
 */
export function renderIndexPage(grid, manifest) {
  const cols = `minmax(220px, 1fr) repeat(${grid.layouts.length}, minmax(0, 1fr))`;
  const head = [
    '<div class="head"></div>',
    ...grid.layouts.map(
      (l) => `<div class="head">${escapeHtml(l.name)}<br>${l.width}x${l.height} @${l.dpr}x</div>`,
    ),
  ].join('\n      ');

  const rows = grid.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          if (cell.status === 'absent') {
            return `<div class="cell cell--absent">not in this sweep</div>`;
          }
          if (cell.status === 'failed') {
            return `<div class="cell cell--failed">capture failed<br><small>${escapeHtml(cell.error)}</small></div>`;
          }
          const caption = measuredCaption(cell.measured);
          const errors = cell.pageErrors > 0
            ? `<span class="warn">${cell.pageErrors} page error(s)</span>`
            : '';
          return [
            '<figure class="cell">',
            `<img src="${escapeHtml(cell.png)}" alt="${escapeHtml(row.id)} at ${escapeHtml(cell.layout)}" loading="lazy">`,
            `<figcaption>${escapeHtml(caption)}${caption && errors ? '<br>' : ''}${errors}</figcaption>`,
            '</figure>',
          ].join('');
        })
        .join('\n      ');
      return [
        `<div class="state"><h2>${escapeHtml(row.title)}</h2><p>${escapeHtml(row.description)}</p><p><code>${escapeHtml(row.id)}</code></p></div>`,
        cells,
      ].join('\n      ');
    })
    .join('\n      ');

  const incomplete = manifest.complete === false
    ? ' <span class="warn">This sweep did not finish.</span>'
    : '';
  const failed = (manifest.failed ?? 0) > 0
    ? ` <span class="warn">${manifest.failed} capture(s) failed.</span>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screen sweep</title>
<style>${STYLE}</style>
</head>
<body>
  <h1>Screen sweep</h1>
  <p class="meta">
    ${grid.rows.length} state(s) x ${grid.layouts.length} layout(s) ·
    ${manifest.captures ?? 0} capture(s) ·
    source <code>${escapeHtml(manifest.source ?? 'unknown')}</code> ·
    dist <code>${escapeHtml(manifest.dist ?? 'unknown')}</code>${incomplete}${failed}
  </p>
  <div class="grid" style="grid-template-columns: ${cols};">
      ${head}
      ${rows}
  </div>
</body>
</html>
`;
}
