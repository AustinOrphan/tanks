/**
 * What `forced-colors: active` actually does to the shipped primitives (issue #368).
 *
 *   node tools/uikit/forced-colors.mjs dist --out fc-out
 *
 * A MEASUREMENT, not a screenshot set. The forced-colors contract is a set of claims
 * about which authored properties the user agent replaces -- "box-shadow is suppressed",
 * "opacity still applies", "transparent survives" -- and every one of those is a fact
 * about the browser rather than about this stylesheet. Writing the CSS from recalled
 * rules and then photographing the result would evidence the photograph, not the claim.
 * So this reads the same computed properties in all four combinations of
 * `forced-colors` x `prefers-color-scheme` and reports the deltas.
 *
 * Both colour schemes, because the forced palette differs between them and the failure
 * that matters most is scheme-specific: a control whose only remaining signal is a light
 * colour is invisible on a light high-contrast theme and fine on a dark one.
 *
 * The two questions it exists to answer, which no jsdom suite can:
 *
 *   1. WHICH CONTROLS COLLAPSE INTO EACH OTHER. `.ui-btn--primary` is distinguished from
 *      `.ui-btn` by a green fill, a dark text colour and a raised `box-shadow`. If the UA
 *      replaces all three, "one primary per decision region" stops being visible at all,
 *      and the fix is a non-colour channel rather than a different colour.
 *   2. WHICH EXISTING NON-COLOUR CHANNELS SURVIVE. `.ui-btn:disabled` deliberately carries
 *      three (opacity, a flattened shadow, cursor). If the shadow is suppressed it is down
 *      to two before this issue changes anything, and the report says so rather than the
 *      comment continuing to claim three.
 *
 * Reported as JSON plus a readable summary. Nothing in CI runs it.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
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
  throw new Error(`playwright not found. Set PLAYWRIGHT_MODULE.\nTried:\n  ${tried.join('\n  ')}`);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

function serve(root) {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(root, url === '/' ? 'index.html' : url);
    if (!path.startsWith(root) || !existsSync(path)) return void res.writeHead(404).end('not found');
    try {
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(await readFile(path));
    } catch {
      res.writeHead(500).end('error');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

/**
 * Every property the contract makes a claim about.
 *
 * `border-style` and `border-width` are here alongside the colours precisely because they
 * are the channels that SURVIVE forcing -- the report needs to show what is still
 * available, not only what was taken away.
 */
const WATCHED = [
  'background-color', 'background-image', 'color',
  'border-top-color', 'border-top-width', 'border-top-style',
  'outline-color', 'outline-width', 'outline-style',
  'box-shadow', 'opacity', 'filter', 'text-decoration-line', 'forced-color-adjust',
];

/** The shipped controls this contract has to cover, with the surface each lives on. */
const CONTROLS = [
  { id: 'primary-action', sel: '.hud-new-game', surface: 'main menu' },
  { id: 'quiet-slab', sel: '.hud-records-open', surface: 'main menu' },
  { id: 'small-quiet', sel: '.hud-about-open', surface: 'main menu' },
  { id: 'hint', sel: '.ui-hint', surface: 'any' },
  { id: 'locked-level', sel: '.hud-level-btn--locked', surface: 'level select' },
  { id: 'selectable-on', sel: '[data-fc="selected"]', surface: 'customize' },
  { id: 'selectable-off', sel: '[data-fc="unselected"]', surface: 'customize' },
  { id: 'destructive', sel: '.hud-reset-progress', surface: 'settings' },
];

async function readStyle(page, selector) {
  return page.evaluate(
    ([sel, props]) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const out = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    },
    [selector, WATCHED],
  );
}

const diff = (a, b) =>
  a && b
    ? Object.fromEntries(Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => [k, `${a[k]} -> ${b[k]}`]))
    : {};

async function main() {
  const [distArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const outIdx = process.argv.indexOf('--out');
  const outDir = resolve(outIdx > -1 ? process.argv[outIdx + 1] : 'fc-out');
  const root = resolve(distArg ?? 'dist');
  if (!existsSync(join(root, 'index.html'))) throw new Error(`no index.html under ${root}`);
  await mkdir(outDir, { recursive: true });

  const chromium = await loadChromium();
  const { server, port } = await serve(root);
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });

  /** One full pass over every control, under one (scheme, forced) combination. */
  async function pass(colorScheme, forcedColors) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await page.emulateMedia({ colorScheme, forcedColors });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('.hud-panel'), undefined, { timeout: 20000 });
    if (await page.evaluate(() => !document.querySelector('.hud-splash')?.classList.contains('hud-splash--hidden'))) {
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('.hud-splash')?.classList.contains('hud-splash--hidden'));
    }

    const out = {};
    // Main-menu controls first, before any panel is opened over them.
    for (const c of CONTROLS.filter((c) => c.surface === 'main menu' || c.surface === 'any')) {
      out[c.id] = await readStyle(page, c.sel);
    }

    // Level select: the locked button is the shipped example of a refused control.
    const levelsShown = await (async () => {
      await page.click('.hud-levelselect-open', { timeout: 15000 }).catch(() => {});
      return page.waitForSelector('.hud-levelselect:not(.hud-levelselect--hidden)', { state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    })();
    out.__levelSelectOpened = levelsShown;
    out['locked-level'] = await readStyle(page, '.hud-level-btn--locked');
    // Closed by its OWN named Back control, not Escape. `tools/uikit/README.md` records
    // this as a sharp edge and it bit here too: Escape left the level panel open over the
    // menu, so every later `click` landed on an obscured element and timed out. The
    // surface flags below are what turned that from four mislabelled screenshots into a
    // visible `customize:false`.
    await page.click('.hud-levelselect-back', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.hud-levelselect', { state: 'hidden', timeout: 8000 }).catch(() => {});

    /**
     * Open a panel and REPORT whether it actually became visible.
     *
     * Not a convenience. `hud.ts` builds several panels at mount and merely hides them, so
     * `querySelector` finds their controls and `getComputedStyle` returns real values for
     * them whether or not the panel ever opened -- the measurements stay valid while the
     * SCREENSHOT quietly captures whatever screen is actually up. That happened here: the
     * two light-scheme passes timed out on their clicks and wrote menu screenshots labelled
     * `customize` and `stats`, byte-identical to each other, while their computed readings
     * were correct. A capture that cannot fail loudly is not evidence, so every surface now
     * records whether it opened and the summary prints it beside the readings.
     */
    async function openPanel(openSel, panelSel) {
      await page.click(openSel, { timeout: 15000 }).catch(() => {});
      const shown = await page
        .waitForSelector(panelSel, { state: 'visible', timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(150);
      return shown;
    }

    // Customize: tag one selected and one unselected swatch so the pair can be compared.
    // The SELECTED one is found by class rather than assumed to be first -- the stored
    // choice decides which it is, and a fixture that assumed index 0 would silently
    // compare two unselected swatches and report the ring as working.
    out.__surfaces = { customize: await openPanel('.hud-customize-open', '.hud-customize:not(.hud-customize--hidden)') };
    const tagged = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.hud-swatch')];
      const on = all.find((b) => b.classList.contains('ui-selectable--on'));
      const off = all.find((b) => !b.classList.contains('ui-selectable--on'));
      on?.setAttribute('data-fc', 'selected');
      off?.setAttribute('data-fc', 'unselected');
      return { total: all.length, foundOn: !!on, foundOff: !!off };
    });
    out.__swatches = tagged;
    out['selectable-on'] = await readStyle(page, '[data-fc="selected"]');
    out['selectable-off'] = await readStyle(page, '[data-fc="unselected"]');

    // The keyboard focus ring. TAB-WALKED, not `.focus()`d: hud.ts installs `blurIfPointer`
    // on its controls, so a programmatic focus landing right after the click that opened
    // this panel is dropped again -- the first draft of this probe reported `engaged:false`
    // and a null outline for exactly that reason, which would have left criterion 1
    // unmeasured while looking like a finding. `:focus-visible` also needs a real keyboard
    // focus change to engage at all.
    let focusHops = 0;
    for (; focusHops < 25; focusHops++) {
      // eslint-disable-next-line no-await-in-loop
      const onSwatch = await page.evaluate(() => document.activeElement?.classList.contains('hud-swatch') ?? false);
      if (onSwatch) break;
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Tab');
    }
    out.__focus = {
      engaged: await page.evaluate(() => document.activeElement?.classList.contains('hud-swatch') ?? false),
      hops: focusHops,
      // Read off the ACTIVE element itself, so this cannot silently measure a different
      // control that happens to match the selector.
      style: await page.evaluate((props) => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        const o = { __matchesFocusVisible: el.matches(':focus-visible') };
        for (const p of props) o[p] = cs.getPropertyValue(p);
        return o;
      }, WATCHED),
    };

    await page.screenshot({ path: join(outDir, `customize--${colorScheme}--${forcedColors}.png`), fullPage: false });

    // ---- Settings -> Data: the destructive control ----
    // In Settings since issue #226, which moved both resets out of Records ("destructive
    // reset/import actions live under Data, not Records").
    await page.click('.hud-customize-back', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('.hud-customize', { state: 'hidden', timeout: 8000 }).catch(() => {});
    out.__surfaces.settings = await openPanel('.hud-settings-open', '.hud-settings:not(.hud-settings--hidden)');
    out.destructive = await readStyle(page, '.hud-reset-progress');
    await page.screenshot({ path: join(outDir, `settings--${colorScheme}--${forcedColors}.png`), fullPage: false });

    await page.close();
    return out;
  }

  const report = {};
  try {
    for (const scheme of ['dark', 'light']) {
      for (const forced of ['none', 'active']) {
        process.stdout.write(`pass: ${scheme} / forced-colors:${forced}\n`);
        report[`${scheme}:${forced}`] = await pass(scheme, forced);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  await writeFile(join(outDir, 'forced-colors.json'), JSON.stringify(report, null, 2));

  // The readable half: for each scheme, what forcing MOVED on each control, and then the
  // question the whole probe exists for -- which controls became indistinguishable.
  const lines = [];
  for (const scheme of ['dark', 'light']) {
    const off = report[`${scheme}:none`];
    const on = report[`${scheme}:active`];
    lines.push(`\n=== ${scheme} ===`);
    lines.push(`surfaces opened: ${JSON.stringify(on.__surfaces)} levelSelect=${on.__levelSelectOpened}`);
    lines.push(`swatches: ${JSON.stringify(on.__swatches)}  focus: ${JSON.stringify(on.__focus?.engaged)}`);
    for (const c of CONTROLS) {
      const moved = diff(off[c.id], on[c.id]);
      lines.push(`  ${c.id}: ${off[c.id] ? (Object.keys(moved).length ? JSON.stringify(moved, null, 1).replace(/\n\s*/g, ' ') : 'UNCHANGED by forcing') : 'NOT FOUND'}`);
    }
    // The collapse checks, stated as explicit pairs rather than left to a reader.
    const same = (a, b, prop) => on[a] && on[b] && on[a][prop] === on[b][prop];
    // Compared across the WHOLE border triple, not colour alone. Colour is expected to
    // match once forcing has run -- that is the point of forcing -- so a check that read
    // only `border-top-color` would report a collapse for a pair whose width or style
    // distinguishes them perfectly well, which is exactly how this contract draws
    // hierarchy. `indistinguishable` is true only when every channel matches.
    const collapse = (a, b) => {
      const props = ['background-color', 'color', 'border-top-color', 'border-top-width', 'border-top-style'];
      const matching = props.filter((p) => same(a, b, p));
      return `matching=[${matching.join(',')}] indistinguishable=${matching.length === props.length}`;
    };
    lines.push(`  COLLAPSE primary-vs-quiet: ${collapse('primary-action', 'quiet-slab')}`);
    lines.push(`  COLLAPSE destructive-vs-quiet: ${collapse('destructive', 'quiet-slab')}`);
    lines.push(`  COLLAPSE selected-vs-unselected: ${collapse('selectable-on', 'selectable-off')}`);
    lines.push(`  focus outline under forcing: ${JSON.stringify(on.__focus?.style)}`);
  }
  const summary = lines.join('\n');
  await writeFile(join(outDir, 'summary.txt'), summary);
  console.log(summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
