/**
 * The menu hit-target sweep: which surfaces `verify.mjs` drives, at which viewports, and
 * what it reads off each (issue #710).
 *
 * `hit-targets.mjs` is the verdict (issue #686). Its input came from a scratch driver that
 * never entered the repository, so until this module nothing in CI measured a rendered
 * control, and a stylesheet change that shrank `.ui-btn` back to 27 px passed every
 * required check. `verify.mjs` now runs this sweep in the `visual` job.
 *
 * SEPARATE MODULE for the reason `clearance.mjs` and `serve-path.mjs` give: `verify.mjs`
 * runs `main()` on import, so which surfaces are swept is decided here, where a unit test
 * and a mutation entry can reach it. The collector runs in the page and is exercised only
 * by the gate itself.
 */
import { findScreenState, SCREEN_STATES } from '../screens/states.mjs';
import { runStep } from '../screens/steps.mjs';

/**
 * The four viewports #686 measured, and the reason each is here: the smallest supported
 * phone, a common modern phone, a laptop, and that laptop at 200% zoom -- where the page is
 * 640x400 CSS px, the tightest landscape a desktop player can produce.
 */
export const HIT_VIEWPORTS = Object.freeze([
  Object.freeze({ name: '320x568', width: 320, height: 568, dpr: 2 }),
  Object.freeze({ name: '390x844', width: 390, height: 844, dpr: 2 }),
  Object.freeze({ name: '1280x800', width: 1280, height: 800, dpr: 1 }),
  Object.freeze({ name: '1280x800@200%', width: 640, height: 400, dpr: 2 }),
]);

const PAST_SPLASH = [{ press: 'Space' }, { waitHidden: '.hud-splash' }];

/**
 * Player-facing surfaces no screen state reaches, in the catalogue's own shape.
 *
 *  - Settings with Reset stats ARMED. Not a dialog: the first press relabels the same button
 *    "Really reset?" for 4 s (`handleDangerClick` in hud.ts), and the longer label is the one
 *    a player presses a second time. It needs recorded stats, or Reset stats is disabled and
 *    never arms, so it borrows the mid-campaign save `screen.main-menu` seeds.
 *
 * The Controllers pane was an extra here until issue #766 added it to the catalogue as
 * `screen.controllers`, with the same steps. The catalogue half of the sweep now reaches it,
 * along with its two-pad variant.
 */
export const HIT_EXTRA_STATES = Object.freeze([
  Object.freeze({
    id: 'extra.settings.reset-armed',
    storage: findScreenState('screen.main-menu').storage,
    webgl: 'ok',
    javascript: 'on',
    query: '',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-settings-open' },
      { waitVisible: '.hud-settings' },
      { click: '.hud-reset-stats' },
      { waitVisible: '.hud-danger--armed' },
    ],
  }),
]);

/**
 * Why a catalogue state is not swept, or null when it is.
 *
 * Every rule removes at least one state no other rule does, so none is decoration. The
 * endings carry `?dev=1` in their query and ARE swept: the query is how the capture reaches
 * them, not who meets them -- every player meets an ending.
 */
export function hitSweepExclusion(state) {
  if (state.id.startsWith('screen.devtools')) return 'a developer pane, reached only behind ?dev=1';
  if (state.webgl !== 'ok') return 'a startup failure page, which has no menu to press';
  if (state.javascript === 'off') return 'the no-script page: the collector runs as page script';
  if (state.steps.some((step) => 'breakWebgl' in step)) return 'the match failure overlay, owned by its own capture';
  // Issue #617. A played ending is tens of seconds of software-GL play before its panel
  // shows, inside a required check. The panel it reaches is the one the pushed-outcome state
  // of the same ending already puts in front of this sweep, so sweeping it again buys no
  // new control to press.
  if (state.steps.some((step) => 'playUntil' in step)) return 'a played ending, whose panel its pushed-outcome state already sweeps';
  return null;
}

/** Every surface the sweep drives: the catalogue's player-facing states, then the extras. */
export function hitSweepStates(states = SCREEN_STATES) {
  return [...states.filter((state) => hitSweepExclusion(state) === null), ...HIT_EXTRA_STATES];
}

/**
 * Every visible interactive control, read in the page, in `hitTargetFailures`'s shape.
 *
 * `reachable`: inside a scroll container, the control's bottom edge in content space must be
 * within the container's `scrollHeight`, measured from its PADDING box, which is where
 * `scrollHeight` starts; with no container, the control must be inside the viewport.
 * `pinned` names the nearest sticky or fixed ancestor below the HUD root -- `.hud` is itself
 * `position: fixed`, so counting it would mark every control pinned. The on-screen driving
 * controls (`.hud-touch`) are left out: they are not menu targets, and `--hud-control-touch`
 * sizes them.
 */
export const COLLECT_CONTROLS = () => {
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=option], [tabindex="0"]';
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (el.closest('.hud-touch')) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    let scroller = el.parentElement;
    while (scroller && !(['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) {
      scroller = scroller.parentElement;
    }
    let reachable;
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      reachable = r.bottom - (sr.top + scroller.clientTop) + scroller.scrollTop <= scroller.scrollHeight + 1;
    } else {
      reachable = r.bottom <= window.innerHeight + 1 && r.top >= -1;
    }
    let pinned = null;
    for (let a = el; a && !a.classList.contains('hud'); a = a.parentElement) {
      const position = getComputedStyle(a).position;
      if (position === 'sticky' || position === 'fixed') {
        pinned = [...a.classList].join('.') || a.tagName;
        break;
      }
    }
    const classes = [...el.classList].filter((c) => !/--(on|hidden|active|selected|entering|leaving)$/.test(c));
    out.push({
      key: `${el.tagName.toLowerCase()}${el.tagName === 'INPUT' && el.type ? `[${el.type}]` : ''}${classes.length ? `.${classes.join('.')}` : ''}`,
      text: (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      reachable,
      pinned,
    });
  }
  return out;
};

/**
 * One reading: drive `state` at `viewport` in a fresh context and collect its controls.
 *
 * A state that fails to reach its surface is returned as `failed`, which the verdict turns
 * into a failure line rather than an empty pass.
 */
export async function measureHitTargets(browser, base, state, viewport, timeout = 20000) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  const errors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    const url = `${base}${state.query ?? ''}`;
    if (Object.keys(state.storage).length > 0) {
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate((entries) => {
        localStorage.clear();
        for (const [k, v] of entries) localStorage.setItem(k, v);
      }, Object.entries(state.storage));
    }
    await page.goto(url, { waitUntil: 'load' });
    for (const step of state.steps) await runStep(page, step, timeout);
    await page.waitForTimeout(250);
    const controls = await page.evaluate(COLLECT_CONTROLS);
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth > window.innerWidth }));
    return { state: state.id, viewport: viewport.name, controls, overflow, errors };
  } catch (e) {
    return { state: state.id, viewport: viewport.name, failed: String(e).split('\n')[0].slice(0, 200), errors };
  } finally {
    await context.close();
  }
}
