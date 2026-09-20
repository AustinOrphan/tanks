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
import { audioContextOverrideSource } from '../shared/audio-context.mjs';
import { runStep, applyEntryMode } from '../screens/steps.mjs';

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
  // shows, inside a required check.
  //
  // The reason used to say the pushed-outcome state of the same ending already sweeps that
  // panel, which was true of the campaign pair and is NOT true of issue #776's versus pair:
  // `loop.ts` has no pushed `vs-match-end` arm, so nothing else puts the versus results panel
  // in front of this sweep. The cost is the rule either way -- four played endings at tens of
  // seconds each, times four viewports, inside a required check -- and the versus panel's
  // three controls are measured by its own screen state instead.
  if (state.steps.some((step) => 'playUntil' in step)) return 'a played ending: too many seconds of software-GL play for a required check';
  // Issue #841. A state that declares no menu has nothing for this sweep to press, and the
  // sweep reports "no controls measured" as a failure -- correctly, since for every other
  // state that means the surface never opened. Keyed on the declaration rather than on ids
  // so a future state inherits it by saying what it is.
  if (state.menu === 'none') return 'a state with no menu: nothing here is a hit target';
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
    // What its clipping ancestors leave visible (issue #766): a control scrolled out of view
    // keeps its box, but a press there lands on whatever is drawn instead.
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const ar = a.getBoundingClientRect();
      left = Math.max(left, ar.left + a.clientLeft);
      top = Math.max(top, ar.top + a.clientTop);
      right = Math.min(right, ar.left + a.clientLeft + a.clientWidth);
      bottom = Math.min(bottom, ar.top + a.clientTop + a.clientHeight);
    }
    const clip = {
      x: +left.toFixed(1),
      y: +top.toFixed(1),
      w: +Math.max(0, right - left).toFixed(1),
      h: +Math.max(0, bottom - top).toFixed(1),
    };
    const classes = [...el.classList].filter((c) => !/--(on|hidden|active|selected|entering|leaving)$/.test(c));
    out.push({
      key: `${el.tagName.toLowerCase()}${el.tagName === 'INPUT' && el.type ? `[${el.type}]` : ''}${classes.length ? `.${classes.join('.')}` : ''}`,
      text: (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      clip,
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
  // The catalogue's touchscreen flag reaches this sweep too (issue #844), and it matters more
  // here than anywhere else: `control-relevance.ts` OMITS `touchScheme` and `fireMode` without
  // a touchscreen, so a touch state swept on a desktop context would measure a Settings pane
  // missing the two controls it exists to show -- and report a clean pass for having measured
  // the others. Hit targets are exactly what a touchscreen changes, so this is the one sweep
  // that must not photograph the wrong device.
  const touch = state.touch === true;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    hasTouch: touch,
    isMobile: touch,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  // Issue #877: every tool that boots the app removes the AudioContext constructor first.
  // THIS driver navigates for itself, separately from `verify.mjs`'s own two page paths,
  // which is the shape of bug issues #781 and #844 both hit here.
  await context.addInitScript(audioContextOverrideSource());
  const errors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    const url = `${base}${state.query ?? ''}`;
    // The catalogue's entry mode reaches this driver too (issue #781). Without it both
    // failure states boot normally here and time out waiting for a card that never appears --
    // which is exactly what the `visual` job reported, in all four viewports.
    await applyEntryMode(page, state.entry);
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
