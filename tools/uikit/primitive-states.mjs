/**
 * Dark-surface state captures for the UI kit's primitives (issue #321).
 *
 * The kit's closeout asks for "a small, reproducible dark-only primitive-state evidence
 * set so the shipped kit's hierarchy and interaction states can be reviewed directly".
 * This produces it from the BUILT bundle in a real browser, against controls the shipped
 * HUD actually renders -- never against markup written here, which would evidence CSS
 * nobody consumes.
 *
 *   node tools/uikit/primitive-states.mjs dist --out uikit-out
 *
 * Deliberately NOT a `screen.*` recipe and it writes no committed baseline: durable
 * recipes, baselines and the broader screen-state matrix are issue #326's. This is a
 * one-shot evidence producer for a PR.
 *
 * WHY A REAL BROWSER, and not the jsdom suites. jsdom does no layout and applies no
 * pseudo-classes, so `:hover`, `:focus-visible` and `:active` are unobservable there --
 * exactly the states this set exists to show. hud.css.test.ts already pins what it can.
 *
 * WHY EVERY SHOT IS MEASURED, not just saved. A screenshot named "hover" proves nothing
 * about whether the hover rule applied; a state that silently failed to engage would
 * produce a picture identical to `normal` and a reviewer would have to eyeball the
 * difference. Each state therefore records the computed properties that changed against
 * that control's own `normal` reading, and a state whose property set comes back EMPTY is
 * reported as `unstyled` rather than presented as evidence. That is also how the set
 * answers "hover where styled" honestly: the report says which controls style it.
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

/** The properties a primitive's states are allowed to move, read on every capture. */
const WATCHED = [
  'background-color', 'background-image', 'color', 'border-color', 'border-width',
  'outline-color', 'outline-width', 'outline-style', 'box-shadow', 'opacity',
  'transform', 'filter', 'cursor',
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
  a && b ? Object.fromEntries(Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => [k, `${a[k]} -> ${b[k]}`])) : {};

/**
 * Focus the way a KEYBOARD user does, because `:focus-visible` is the point.
 *
 * `element.focus()` is a programmatic focus and Chromium does not always apply
 * `:focus-visible` to it; the ring would then be missing from a shot labelled "focus". So
 * focus programmatically, step OFF with Shift+Tab, and step back on with Tab -- the last
 * move is a real keyboard focus change. The caller checks the outline actually appeared.
 */
async function focusByKeyboard(page, selector) {
  await page.evaluate((sel) => document.querySelector(sel)?.focus(), selector);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  return page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector);
}

async function main() {
  const [distArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const outIdx = process.argv.indexOf('--out');
  const outDir = resolve(outIdx > -1 ? process.argv[outIdx + 1] : 'uikit-out');
  const root = resolve(distArg ?? 'dist');
  if (!existsSync(join(root, 'index.html'))) throw new Error(`no index.html under ${root}`);
  await mkdir(outDir, { recursive: true });

  const chromium = await loadChromium();
  const { server, port } = await serve(root);
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const report = [];
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('.hud-panel'), undefined, { timeout: 20000 });
    // The title screen sits over everything until a press dismisses it.
    if (await page.evaluate(() => !document.querySelector('.hud-splash')?.classList.contains('hud-splash--hidden'))) {
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('.hud-splash')?.classList.contains('hud-splash--hidden'));
    }

    /** Open a panel by clicking the shipped control that opens it, then wait for it. */
    async function open(openSel, panelSel) {
      if (openSel) await page.click(openSel);
      if (panelSel) await page.waitForSelector(panelSel, { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(120);
    }

    async function capture(id, selector, states, context) {
      const el = page.locator(selector).first();
      // Reported, never thrown. A control the shipped HUD does not show on this surface is
      // a fact about the kit's reach and belongs in the report; letting Playwright block
      // for its full timeout on an invisible element would lose every later capture too.
      if ((await el.count()) === 0 || !(await el.isVisible())) {
        report.push({ id, selector, context, error: (await el.count()) === 0 ? 'not present' : 'not visible' });
        console.log(`  skip ${id} (${selector}): not reachable on this surface`);
        return;
      }
      console.log(`  capture ${id} (${selector})`);
      const normal = await readStyle(page, selector);
      // A FIXED clip, computed once at rest and padded, rather than `el.screenshot()`.
      // Element screenshots clip to the element's own box, and that box MOVES with the
      // control: `.ui-btn--primary:active` translates 3px down and shrinks its drop shadow,
      // both of which then fall outside the crop. The pressed shot came back visually
      // identical to normal while the measurement showed box-shadow and transform had both
      // changed -- a picture contradicting its own caption. One padded region per control
      // also makes the states flippable side by side, which is the point of a state set.
      const box = await el.boundingBox();
      const PAD = 16;
      const clip = {
        x: Math.max(0, box.x - PAD), y: Math.max(0, box.y - PAD),
        width: box.width + PAD * 2, height: box.height + PAD * 2,
      };
      const shoot = (name) => page.screenshot({ path: join(outDir, `${id}--${name}.png`), clip });
      await shoot('normal');
      // The rest reading is kept, not just diffed against: the hierarchy comparison below
      // is a difference BETWEEN controls, and it cannot be recovered from per-control deltas.
      const entry = { id, selector, context, rest: normal, states: {} };
      for (const state of states) {
        let engaged = true;
        if (state === 'hover') await el.hover();
        else if (state === 'focus-visible') engaged = await focusByKeyboard(page, selector);
        else if (state === 'pressed') {
          const box = await el.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
        }
        await page.waitForTimeout(90);
        // `engaged` is MEASURED for every state, never assumed. Without this, a hover that
        // silently failed to land and a control with no hover rule produce the identical
        // report line -- "unstyled" -- and the set would be claiming an absence it had not
        // established. The pseudo-class is asked of the element itself.
        if (state === 'hover' || state === 'pressed') {
          const pseudo = state === 'hover' ? ':hover' : ':active';
          engaged = await page.evaluate(
            ([sel, p]) => document.querySelector(sel)?.matches(p) ?? false,
            [selector, pseudo],
          );
        }
        const now = await readStyle(page, selector);
        const moved = diff(normal, now);
        await shoot(state);
        entry.states[state] = {
          engaged,
          changed: Object.keys(moved).length === 0 ? 'unstyled' : moved,
        };
        // Release OFF the control, never on it. A `mouse.down()` followed by a `mouse.up()`
        // in place is a CLICK: capturing `pressed` on New Game started a game and every
        // later capture then reported the main menu's controls as "not visible", which is
        // how this was found. Moving the pointer away first means mouseup lands elsewhere
        // and the control is never activated.
        if (state === 'pressed') {
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
        // Return to rest so the next state measures against a clean baseline.
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.activeElement?.blur?.());
        await page.waitForTimeout(90);
      }
      report.push(entry);
    }

    // ---- Main menu: hierarchy (primary vs quiet slab) and the small settings row ----
    // `.hud-new-game`, not `.hud-action`: the action button is Continue/Resume/Play Again
    // and is hidden on a title screen with no run to resume, so a capture aimed at it
    // would sit waiting on an invisible element. New Game is the primary the menu shows.
    await capture('primary-action', '.hud-new-game', ['hover', 'focus-visible', 'pressed'], 'main menu');
    // `.hud-records-open` since issue #226: Records is the utility slab that replaced the
    // Stats and Achievements pair, and `.hud-panel-mute` is gone with the panel settings
    // row it sat in. The small quiet control the menu still shows is the About & Legal
    // footer entry, which is `--sm` for exactly the reason this capture is taken: it must
    // read as quieter than the utility slabs above it.
    await capture('quiet-slab', '.hud-records-open', ['hover', 'focus-visible', 'pressed'], 'main menu');
    await capture('small-quiet', '.hud-about-open', ['hover', 'focus-visible', 'pressed'], 'main menu footer');
    await page.screenshot({ path: join(outDir, 'surface--main-menu.png') });

    // ---- Level select ----
    //
    // This step used to capture `locked-level` -- the shipped example of a refused control
    // -- and the aria association between it and the line saying why it was refused. Issue
    // #555 removed both: the grid draws only levels the player has CLEARED, so there is no
    // dimmed tile to photograph and nothing for the note to explain. The strongest form of
    // "say why this is refused" turned out to be not offering it.
    //
    // COVERAGE THIS SET NO LONGER HAS, said plainly rather than quietly dropped: no
    // refused control is photographed here any more. `hud.css.test.ts`'s `draws a refused
    // button as refused, on more channels than colour alone (issue #260)` still gates the
    // treatment itself, and the other shipped refusals -- unofferable versus modes,
    // unavailable controller sources -- are on panes this one-shot does not visit. Adding
    // one is issue #326's durable-recipe work, not a patch here.
    //
    // The pane needs cleared levels to open at all now, so the harness seeds them the same
    // way `tools/visual/roundtrip.mjs` does.
    await page.evaluate(() =>
      localStorage.setItem('tanks.progress.v1', JSON.stringify({ levelId: 'level-02' })),
    );
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('.hud-panel'), undefined, { timeout: 20000 });
    if (await page.evaluate(() => !document.querySelector('.hud-splash')?.classList.contains('hud-splash--hidden'))) {
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.querySelector('.hud-splash')?.classList.contains('hud-splash--hidden'));
    }
    await open('.hud-levelselect-open', '.hud-levelselect:not(.hud-levelselect--hidden)');
    const reason = await page.evaluate(() => {
      const note = document.querySelector('.hud-levels-note');
      return { noteVisible: !!note, noteText: note?.textContent ?? null };
    });
    report.push({ id: 'level-select-note', context: 'level select', ...reason });
    await page.locator('.hud-levelselect').screenshot({ path: join(outDir, 'surface--level-select.png') });

    // ---- Customize: the selectable pair, on and off, and what carries the state ----
    // Each panel has its own named Back control; a generic "first button in the panel"
    // selector picks a LEVEL button here and leaves the panel open over the menu, which is
    // how the customize step below first failed with "element is not visible".
    await page.click('.hud-levelselect-back');
    await page.waitForSelector('.hud-levelselect', { state: 'hidden' });
    await open('.hud-customize-open', '.hud-customize:not(.hud-customize--hidden)');
    // Scoped to the OPEN panel. Unscoped, `document.querySelector('.ui-selectable--on')`
    // matches a control in the versus pane or the controller panel -- both built at mount
    // and merely hidden -- so the aria read succeeded while the screenshot reported "not
    // visible", which is precisely the mismatch the visibility check exists to surface.
    const sel = await page.evaluate(() => {
      const panel = document.querySelector('.hud-customize');
      const on = panel.querySelector('.ui-selectable--on');
      const off = Array.from(panel.querySelectorAll('.ui-selectable')).find((e) => e !== on);
      const mark = (e, n) => { if (e) e.setAttribute('data-uikit', n); };
      mark(on, 'selected'); mark(off, 'unselected');
      return {
        selectedAria: on?.getAttribute('aria-pressed') ?? null,
        unselectedAria: off?.getAttribute('aria-pressed') ?? null,
      };
    });
    report.push({ id: 'selectable-aria', context: 'customize', ...sel });
    await capture('selectable-on', '[data-uikit="selected"]', ['hover', 'focus-visible'], 'customize');
    await capture('selectable-off', '[data-uikit="unselected"]', ['hover', 'focus-visible'], 'customize');
    // The kit's ONE hover treatment. Captured deliberately: without it the set reports
    // "hover: unstyled" seven times and reads as a harness that cannot see hover at all.
    // `.hud-rotate-btn` is the only `:hover` rule in hud.css (its touch-target size is
    // #352's, not this issue's).
    await capture('hover-styled-control', '.hud-rotate-btn', ['hover', 'focus-visible', 'pressed'], 'customize preview');

    // Selection has to be legible WITHOUT colour, so the on/off difference is measured
    // between the two controls rather than each against its own rest state -- which is
    // what every other entry does and what would have missed this entirely.
    const selectionDelta = diff(await readStyle(page, '[data-uikit="unselected"]'), await readStyle(page, '[data-uikit="selected"]'));
    report.push({ id: 'selection-difference', context: 'customize', unselectedVsSelected: selectionDelta });

    await page.locator('.hud-customize').screenshot({ path: join(outDir, 'surface--customize.png') });

    // ---- Records, and then Settings for the destructive hierarchy ----
    // The two reset buttons moved out of Records and into Settings -> Data with issue
    // #226 ("destructive reset/import actions live under Data, not Records"), so the
    // destructive capture follows them; Records is still photographed as a surface.
    await page.click('.hud-customize-back');
    await page.waitForSelector('.hud-customize', { state: 'hidden' });
    await open('.hud-records-open', '.hud-stats:not(.hud-stats--hidden)');
    await page.locator('.hud-stats').screenshot({ path: join(outDir, 'surface--records.png') });
    await page.click('.hud-stats-back');
    await page.waitForSelector('.hud-stats', { state: 'hidden' });
    await open('.hud-settings-open', '.hud-settings:not(.hud-settings--hidden)');
    await capture('destructive', '.hud-reset-progress', ['hover', 'focus-visible', 'pressed'], 'settings, Data section');
    await page.locator('.hud-settings').screenshot({ path: join(outDir, 'surface--settings.png') });
    // Hierarchy is a difference BETWEEN controls at rest, so it is measured that way rather
    // than left to the eye: "primary, quiet and destructive are distinguishable on the dark
    // surface" is a claim about how the three differ, and each control's own hover/pressed
    // deltas say nothing about it.
    const byId = Object.fromEntries(report.filter((e) => e.rest).map((e) => [e.id, e.rest]));
    report.push({
      id: 'hierarchy-difference',
      context: 'rest state, dark surface',
      quietVsPrimary: diff(byId['quiet-slab'], byId['primary-action']),
      quietVsDestructive: diff(byId['quiet-slab'], byId['destructive']),
      primaryVsDestructive: diff(byId['primary-action'], byId['destructive']),
    });
  } finally {
    await browser.close();
    server.close();
  }

  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\ncaptures + report: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
