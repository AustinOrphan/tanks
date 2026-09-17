/**
 * The pure half of the screen-state layout sweep (issue #766): which layouts, where each capture
 * goes, what the manifest says, and how two sweeps compare.
 *
 * WHY A KEPT TOOL. A refactor that touches every surface has to show that nothing a player sees
 * changed. #551 showed it with a throwaway script at five widths. #755 showed it with a throwaway
 * DOM serialisation, and this directory's README counts four earlier throwaways. #556 splits
 * `hud.ts` pane by pane, and each of those PRs needs the same proof. So the proof is a command.
 *
 * NOT A GATE, and not #326's regression suite. Nothing here commits a baseline. A sweep is taken
 * on a base build and on a head build, and the two directories are compared.
 *
 * Nothing here launches a browser. `sweep.mjs` does, and `compare.mjs` reads files.
 */
import { join } from 'node:path';

/**
 * The layout matrix. Each layout names the distinct risk it protects, following #326's rule
 * against visually equivalent duplicates.
 *
 * The media queries a layout meets are derived from `hud.css` by `mediaSignature`. When layouts
 * meet the same queries, every one but one of them names another in `sameQueriesAs`, and its
 * `risk` says what still tells them apart. Today that is `hud.css`'s viewport-relative sizes
 * (`vmin`, `vw`, `vh`), for phone landscape, laptop and TV.
 */
export const LAYOUTS = Object.freeze([
  Object.freeze({
    name: '320x568',
    width: 320, height: 568, dpr: 2,
    risk: 'The smallest supported phone, and the only layout under the 340px query.',
  }),
  Object.freeze({
    name: '360x640',
    width: 360, height: 640, dpr: 2,
    risk: 'A common small phone at the 360px query, above the 340px one.',
  }),
  Object.freeze({
    name: '390x844',
    width: 390, height: 844, dpr: 2,
    risk: 'A modern phone in portrait: under 760px, above both narrow queries.',
  }),
  Object.freeze({
    name: '844x390',
    width: 844, height: 390, dpr: 2,
    risk: 'The same phone in landscape. It meets the same queries as 1280x800, but at 390px it is the shortest page in the matrix: `vh` and `vmin` sizes shrink, and a pane that fits a laptop has to scroll here.',
    sameQueriesAs: '1280x800',
  }),
  Object.freeze({
    name: '768x1024',
    width: 768, height: 1024, dpr: 2,
    risk: 'A tablet in portrait: just wider than 760px, and not landscape.',
  }),
  Object.freeze({
    name: '1280x800@200%',
    width: 640, height: 400, dpr: 2,
    risk: 'A 1280x800 laptop at 200% zoom: a 640x400 CSS page, the tightest landscape a desktop player can produce, and the stand-in #551 used.',
  }),
  Object.freeze({
    name: '1280x800',
    width: 1280, height: 800, dpr: 1,
    risk: 'A laptop, the default capture viewport.',
  }),
  Object.freeze({
    name: '1920x1080',
    width: 1920, height: 1080, dpr: 1,
    risk: 'Desktop and TV. It meets the same queries as 1280x800, but its viewport-relative sizes differ: the title\'s `20vmin` is 216px here and 160px there.',
    sameQueriesAs: '1280x800',
  }),
]);

/**
 * The width and orientation queries in a stylesheet, in the order they appear, deduplicated.
 * Only `max-width`, `min-width`, `max-height`, `min-height` and `orientation` are read: those are
 * the queries a viewport alone decides.
 * @param {string} css
 * @returns {string[]}
 */
export function viewportQueries(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  for (const m of withoutComments.matchAll(/@media\s*\(\s*((?:max|min)-(?:width|height)\s*:\s*\d+px|orientation\s*:\s*(?:landscape|portrait))\s*\)/g)) {
    const query = m[1].replace(/\s+/g, '');
    if (!found.includes(query)) found.push(query);
  }
  return found;
}

/**
 * Which of `queries` a layout meets, as a string. CSS pixels are the layout's width and height;
 * the device pixel ratio does not enter a width query.
 * @param {{ width: number, height: number }} layout @param {readonly string[]} queries
 */
export function mediaSignature(layout, queries) {
  return queries.map((q) => {
    const [feature, value] = q.split(':');
    const px = Number.parseInt(value, 10);
    let meets;
    if (feature === 'max-width') meets = layout.width <= px;
    else if (feature === 'min-width') meets = layout.width >= px;
    else if (feature === 'max-height') meets = layout.height <= px;
    else if (feature === 'min-height') meets = layout.height >= px;
    else meets = (value === 'landscape') === (layout.width > layout.height);
    return `${q}=${meets ? 1 : 0}`;
  }).join(' ');
}

/**
 * Pick states and layouts by id. An unknown id is an error that names it, never a silently
 * smaller sweep.
 * @template {{ id?: string, name?: string }} T
 * @param {readonly T[]} all @param {string | undefined} list comma-separated @param {(t: T) => string} key @param {string} what
 * @returns {T[]}
 */
export function select(all, list, key, what) {
  if (list === undefined || list.trim() === '') return [...all];
  const wanted = list.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.some((t) => key(t) === w));
  if (unknown.length > 0) throw new Error(`unknown ${what}: ${unknown.join(', ')}`);
  return all.filter((t) => wanted.includes(key(t)));
}

/** Where one capture's frame and report go inside a sweep directory. */
export function capturePaths(/** @type {string} */ out, /** @type {string} */ stateId, /** @type {string} */ layoutName) {
  return {
    png: join(out, stateId, `${layoutName}.png`),
    report: join(out, stateId, `${layoutName}.json`),
  };
}

/** The manifest's file name inside a sweep directory. */
export const MANIFEST = 'manifest.json';

/**
 * The manifest a sweep writes: what was built, what was asked for, and every capture's result.
 * `complete` is false until the sweep has attempted every state and layout it was asked for.
 * @param {{ dist: string, source: string, options: { hideGame: boolean }, states: readonly { id: string }[], layouts: readonly { name: string, width: number, height: number, dpr: number }[], results: readonly { state: string, layout: string, ok: boolean, error?: string, pageErrors?: number, sha256?: string, measurementsSha256?: string }[], complete: boolean }} sweep
 */
export function sweepManifest(sweep) {
  return {
    tool: 'tools/screens/sweep.mjs',
    complete: sweep.complete,
    dist: sweep.dist,
    source: sweep.source,
    options: { hideGame: sweep.options.hideGame },
    states: sweep.states.map((s) => s.id),
    layouts: sweep.layouts.map(({ name, width, height, dpr }) => ({ name, width, height, dpr })),
    captures: sweep.results.length,
    failed: sweep.results.filter((r) => !r.ok).length,
    results: sweep.results,
  };
}

/**
 * How one state and layout compares across sweeps.
 *
 *  - `missing`: absent, or failed to capture, on either side. Never read as identical.
 *  - `unstable`: a control sweep of the same build as either side differs from that side. The
 *    pair cannot say anything about the change, so it is not called a regression.
 *  - `different`: base and head differ, and the pair was stable.
 *  - `identical`: base and head are byte-identical, and the pair was stable.
 *
 * Each argument is the capture's SHA-256, or null when it is missing or failed. A control that
 * was not taken is `undefined`, which is not the same as a control that failed.
 * @param {{ base: string | null, head: string | null, baseControl?: string | null, headControl?: string | null }} hashes
 * @returns {'identical' | 'different' | 'missing' | 'unstable'}
 */
export function classifyPair({ base, head, baseControl, headControl }) {
  if (base === null || head === null) return 'missing';
  if (baseControl !== undefined && baseControl !== base) return 'unstable';
  if (headControl !== undefined && headControl !== head) return 'unstable';
  return base === head ? 'identical' : 'different';
}

/**
 * Compare manifests. Every state and layout named by either side is classified, so a capture
 * one side forgot shows up as missing.
 *
 * Each pair also says whether the MEASUREMENTS agree: the boxes, text and watched styles the
 * state names. That is secondary evidence. It can show that the layout held for a pair whose
 * pixels are unstable, but it never turns an unstable or different pair into an identical one.
 *
 * A sweep that did not finish cannot be compared either: its manifest is written as it goes, and
 * says `complete: true` only at the end.
 *
 * Sweeps taken with different options cannot be compared, and asking to is an error. A sweep
 * with the game canvas hidden against one without it would differ in every state that shows a
 * match.
 * @param {{ base: any, head: any, baseControl?: any, headControl?: any }} manifests
 */
export function compareManifests({ base, head, baseControl, headControl }) {
  const sweeps = [['base', base], ['head', head], ['base control', baseControl], ['head control', headControl]]
    .filter(([, m]) => m !== undefined);
  for (const [name, m] of sweeps) {
    if (m?.complete !== true) throw new Error(`the ${name} sweep did not finish: its manifest says complete is ${JSON.stringify(m?.complete)}`);
  }
  const optionsOf = (/** @type {any} */ m) => JSON.stringify({ hideGame: m?.options?.hideGame === true });
  const reference = optionsOf(base);
  for (const [name, m] of sweeps) {
    if (optionsOf(m) !== reference) throw new Error(`the ${name} sweep was taken with ${optionsOf(m)}, the base with ${reference}`);
  }
  const index = (/** @type {any} */ manifest) => {
    const map = new Map();
    for (const r of manifest?.results ?? []) map.set(`${r.state}\u0000${r.layout}`, r.ok ? r : null);
    return map;
  };
  const b = index(base);
  const h = index(head);
  const bc = baseControl === undefined ? null : index(baseControl);
  const hc = headControl === undefined ? null : index(headControl);
  const keys = [...new Set([...b.keys(), ...h.keys()])].sort();
  const pairs = keys.map((key) => {
    const [state, layout] = key.split('\u0000');
    const rb = b.get(key) ?? null;
    const rh = h.get(key) ?? null;
    const control = (/** @type {Map<string, any> | null} */ map) => (map === null ? undefined : (map.get(key)?.sha256 ?? null));
    const outcome = classifyPair({
      base: rb?.sha256 ?? null,
      head: rh?.sha256 ?? null,
      baseControl: control(bc),
      headControl: control(hc),
    });
    const measurements = rb?.measurementsSha256 === undefined || rh?.measurementsSha256 === undefined
      ? 'missing'
      : rb.measurementsSha256 === rh.measurementsSha256 ? 'identical' : 'different';
    return { state, layout, outcome, measurements };
  });
  const count = (/** @type {string} */ o) => pairs.filter((p) => p.outcome === o).length;
  return {
    pairs,
    totals: {
      pairs: pairs.length,
      identical: count('identical'),
      different: count('different'),
      missing: count('missing'),
      unstable: count('unstable'),
      measurementsIdentical: pairs.filter((p) => p.measurements === 'identical').length,
    },
    controls: { base: baseControl !== undefined, head: headControl !== undefined },
    options: JSON.parse(reference),
  };
}

/** The exit code a comparison earns: 0 only when every pair is identical. */
export function compareExitCode(/** @type {ReturnType<typeof compareManifests>} */ result) {
  return result.totals.pairs > 0 && result.totals.identical === result.totals.pairs ? 0 : 1;
}
