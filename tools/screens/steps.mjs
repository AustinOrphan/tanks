/**
 * Driving a built page through a screen state's declarative steps (issues #561, #710).
 *
 * MOVED OUT OF `run.mjs`, unchanged in behaviour. `run.mjs` calls `main()` at the top level,
 * so nothing else could import its step runner, and `tools/visual/verify.mjs`'s hit-target
 * sweep (issue #710) drives the same catalogue. Copying the runner would have meant two
 * definitions of what `{ click }` waits for, drifting apart the first time one changed.
 *
 * Nothing here launches a browser: every function takes the Playwright `page` it acts on.
 */
import { STEP_KINDS, WEBGL_MODES } from './states.mjs';

/**
 * The page-side WebGL override, as a source string for `addInitScript`.
 *
 * Patches `HTMLCanvasElement.prototype.getContext` rather than stubbing a module, so the
 * REAL probe in `render-capability.ts` runs and takes its real branch -- returning null is
 * `no-webgl2`, throwing is `probe-failed`, and those select two different branded screens.
 * A capture that injected the screen's markup instead would evidence nothing.
 *
 * Only `webgl2` is intercepted. The HUD's Customize preview and the 2D contexts the page
 * uses elsewhere keep working, so a failure state still renders the rest of the page the
 * way a player would meet it.
 */
export function webglOverrideSource(mode) {
  if (!WEBGL_MODES.includes(mode)) throw new Error(`unknown webgl mode '${mode}'`);
  return `(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (id, ...rest) {
      if (String(id).toLowerCase() !== 'webgl2') return real.call(this, id, ...rest);
      ${mode === 'probe-blocked'
        ? "throw new Error('capture: webgl2 blocked');"
        : 'return null;'}
    };
  })()`;
}

/**
 * The synthetic pads `{ fakeGamepads }` installs (issue #599).
 *
 * A headless browser has no controller, and a browser reports no pad until one has been
 * ACTUATED, so without this the controller self-test photographs its empty state on every
 * capture machine -- true, and evidence for nothing the pane does.
 *
 * Overriding `navigator.getGamepads` is not a back door: it is the SAME seam production
 * reads through (`readNavigatorGamepads` in src/input/gamepad.ts) and the same one every
 * unit test in that directory injects. Nothing downstream can tell these from real pads,
 * which is exactly what makes the picture evidence.
 *
 * The two disagree about mapping, axis count, button count and which button is down, so
 * one frame carries both rendering paths and a filled bar rather than seventeen zeroes.
 */
const GAMEPAD_FIXTURE_PADS = {
  none: null,
  mixed: [
    {
      index: 0,
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
      mapping: 'standard',
      axes: [0.62, -0.41, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({
        pressed: i === 7,
        value: i === 7 ? 1 : i === 6 ? 0.35 : 0,
      })),
    },
    {
      index: 1,
      id: 'HuiJia  USB GamePad',
      mapping: '',
      axes: [0.05, -0.98, 0, 0, 1, -1],
      buttons: Array.from({ length: 12 }, (_, i) => ({ pressed: i === 3, value: i === 3 ? 1 : 0 })),
    },
  ],
};

function gamepadOverrideSource(fixture) {
  const pads = GAMEPAD_FIXTURE_PADS[fixture];
  if (pads === undefined) throw new Error(`unknown gamepad fixture '${fixture}'`);
  if (pads === null) return '(() => {})()';
  return `(() => {
    const pads = ${JSON.stringify(pads)};
    navigator.getGamepads = () => pads;
  })()`;
}

const visibleIn = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (el === null) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
})()`;

const goneIn = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (el === null) return true;
  return getComputedStyle(el).display === 'none' || el.classList.contains('hud-splash--hidden');
})()`;

/** Run one declarative step. An unknown kind is an error, never a skipped line. */
export async function runStep(page, step, timeout) {
  const kinds = Object.keys(step).filter((k) => STEP_KINDS.includes(k));
  if (kinds.length !== 1) {
    throw new Error(`each step needs exactly one known key, got ${JSON.stringify(step)}`);
  }
  const [kind] = kinds;
  if (kind === 'press') return void (await page.keyboard.press(step.press));
  if (kind === 'waitVisible') return void (await page.waitForFunction(visibleIn(step.waitVisible), undefined, { timeout }));
  if (kind === 'waitHidden') return void (await page.waitForFunction(goneIn(step.waitHidden), undefined, { timeout }));
  if (kind === 'breakWebgl') {
    // Applied to the LIVE page, not as an init script: the point of this step is that boot
    // already succeeded. `addInitScript` would run before the probe and produce a boot
    // failure instead, which is a different screen.
    return void (await page.evaluate(webglOverrideSource(step.breakWebgl)));
  }
  if (kind === 'scroll') {
    const { selector, to } = step.scroll;
    await page.waitForFunction(visibleIn(to), undefined, { timeout });
    // `scrollIntoView` on the TARGET rather than a pixel offset on the container: a pixel
    // offset is a number that goes stale the moment anything above it changes height, and
    // this pane's height is a property of the flag registry.
    await page.evaluate(
      ([containerSel, targetSel]) => {
        const container = document.querySelector(containerSel);
        const target = document.querySelector(targetSel);
        if (!container || !target) throw new Error(`scroll: ${containerSel} -> ${targetSel}`);
        container.scrollTop =
          target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      },
      [selector, to],
    );
    return;
  }
  if (kind === 'fakeGamepads') {
    // Applied to the LIVE page like `breakWebgl`, not as an init script: the self-test
    // reads `navigator.getGamepads` on every frame while its pane is open, so the override
    // only has to be in place before the pane is, and boot must be left alone.
    return void (await page.evaluate(gamepadOverrideSource(step.fakeGamepads)));
  }
  await page.waitForFunction(
    `(() => {
      const el = document.querySelector(${JSON.stringify(step.click)});
      if (el === null || el.disabled) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && el.getBoundingClientRect().width > 0;
    })()`,
    undefined,
    { timeout },
  );
  await page.click(step.click);
}
