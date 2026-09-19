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
  if (mode === 'match-build-fails') {
    // The context is left alone, so the renderer is constructed and #669's typed context
    // failure never fires. The FIRST framebuffer allocation after it -- the environment map
    // `createScene` builds right after the renderer -- then throws an untyped Error, which
    // `classifyStartupFailure` reads as "we do not know" at the match boundary: the
    // recoverable overlay (issue #700). Measured before choosing it: createFramebuffer,
    // framebufferTexture2D, linkProgram and drawElements each reached `.hud-alert` with Retry
    // and Back to menu, and each was called exactly once. The earliest of the four is used.
    return `(() => {
    WebGL2RenderingContext.prototype.createFramebuffer = function () {
      throw new Error('capture: building the match failed after the context was created');
    };
  })()`;
  }
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

/**
 * One poll of a `{ playUntil }` step, read in the page: whether the target is visible, and
 * the current level's simulated tick count from the replay surface (`null` when that surface
 * is absent, which is a recipe error rather than a slow game).
 */
const playSampleIn = (sel, textSel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  const cs = el === null ? null : getComputedStyle(el);
  const visible = el !== null && cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
  const textEl = ${JSON.stringify(textSel ?? null)} === null ? null : document.querySelector(${JSON.stringify(textSel ?? '')});
  const text = textEl === null ? null : (textEl.textContent ?? '').trim();
  const replay = globalThis.__tanks && globalThis.__tanks.replay;
  if (typeof replay !== 'function') return { visible, text, ticks: null, truncated: false };
  const trace = replay();
  return { visible, text, ticks: trace.ticks.length, truncated: trace.truncated === true };
})()`;

/** A `{ playUntil }` step's running state before its first poll. */
export const PLAY_START = Object.freeze({ total: 0, last: 0, lastChangeMs: null });

/**
 * Advance a `{ playUntil }` step by one poll, and decide it (issue #617). Pure, so every way
 * a played capture can end is testable without a browser.
 *
 * TICKS ARE SUMMED ACROSS WORLD REBUILDS. The replay surface counts the CURRENT level's
 * ticks, and a new level or a retry after a lost life starts a new trace at 0. A sample
 * lower than the previous one therefore means a new world: the previous world's count is
 * banked. A poll every quarter second sees at most 15 ticks of a new world, far fewer than
 * any world lasts, so a rebuild cannot hide between two polls.
 *
 * THE ENDING IT REACHED IS CHECKED, not just that one was reached. `expect: { selector,
 * text }` names what the screen must say once the target shows. Without it a campaign-over
 * capture whose autoplay happened to WIN would photograph Mission Clear under the Game Over
 * id and pass, since both panels show the same primary action.
 *
 * Returns `{ state, reached, error }`: `reached` when the target is visible and says what
 * it should; otherwise `error` names why the step can never succeed, or both are unset and
 * polling continues.
 */
export function advancePlay(state, sample, { visible, maxTicks, expect }, nowMs, stallMs) {
  if (sample.ticks === null) {
    return { state, reached: false, error: `playUntil: there is no replay surface (__tanks.replay), so there is no tick budget to play within -- the state's query needs dev=1&replay=1` };
  }
  const banked = sample.ticks < state.last ? state.total + state.last : state.total;
  const total = banked + sample.ticks;
  const changed = state.lastChangeMs === null || sample.ticks !== state.last;
  const next = { total: banked, last: sample.ticks, lastChangeMs: changed ? nowMs : state.lastChangeMs };
  if (sample.visible) {
    if (expect !== undefined && sample.text !== expect.text) {
      return { state: next, reached: false, error: `playUntil: the game ended, but '${expect.selector}' reads ${JSON.stringify(sample.text)} rather than ${JSON.stringify(expect.text)}, after ${total} simulated ticks` };
    }
    return { state: next, reached: true, error: null, ticks: total };
  }
  if (total > maxTicks) {
    return { state: next, reached: false, error: `playUntil: the game did not end -- '${visible}' was not visible after ${total} simulated ticks (budget ${maxTicks})` };
  }
  if (sample.truncated) {
    return { state: next, reached: false, error: `playUntil: the game did not end -- the replay trace truncated at ${sample.ticks} ticks in one world before '${visible}' was visible` };
  }
  if (nowMs - next.lastChangeMs > stallMs) {
    return { state: next, reached: false, error: `playUntil: the simulation stopped advancing at ${total} ticks for ${stallMs} ms before '${visible}' was visible` };
  }
  return { state: next, reached: false, error: null, ticks: total };
}

/** Poll interval and stall limit for `{ playUntil }`, in wall-clock milliseconds. */
export const PLAY_POLL_MS = 250;
export const PLAY_STALL_MS = 15000;

async function playUntil(page, target) {
  const started = Date.now();
  let state = PLAY_START;
  for (;;) {
    const sample = await page.evaluate(playSampleIn(target.visible, target.expect?.selector));
    const now = Date.now();
    const verdict = advancePlay(state, sample, target, now, PLAY_STALL_MS);
    if (verdict.error) throw new Error(verdict.error);
    state = verdict.state;
    if (verdict.reached) return { kind: 'playUntil', visible: target.visible, maxTicks: target.maxTicks, ticks: verdict.ticks, wallMs: now - started };
    await page.waitForTimeout(PLAY_POLL_MS);
  }
}

/**
 * Focus a control the way a KEYBOARD user does, and prove it engaged (issue #842).
 *
 * `element.focus()` is a programmatic focus, and Chromium does not always apply
 * `:focus-visible` to one -- so a shot labelled "focused" could arrive with no ring on it. The
 * sequence that works is focus, step OFF with Shift+Tab, step back on with Tab, so the last
 * move is a real keyboard focus change.
 *
 * THEN IT IS READ BACK. `tools/uikit/primitive-states.mjs` measured `document.activeElement`
 * after focusing for exactly this reason, and that check survives here: a focus that silently
 * failed would photograph the rest state, which is indistinguishable from a control that has
 * no focus rule. Failing names the selector rather than leaving the caller a picture to squint
 * at.
 */
async function focusKeyboard(page, selector, timeout) {
  await page.waitForFunction(visibleIn(selector), undefined, { timeout });
  await page.evaluate((sel) => document.querySelector(sel)?.focus(), selector);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const engaged = await page.evaluate(
    (sel) => document.activeElement === document.querySelector(sel),
    selector,
  );
  if (!engaged) {
    throw new Error(`focusKeyboard: '${selector}' did not take focus -- the shot would be the rest state`);
  }
}

/**
 * Press a control and HOLD it, so `:active` can be photographed, and prove it engaged.
 *
 * MOUSE DOWN WITHOUT AN UP, deliberately, and it is the trap `tools/uikit/README.md` records:
 * a `mouse.down()` followed by a `mouse.up()` in the same place is a CLICK, and capturing the
 * pressed state of New Game that way started a game and lost the screen underneath it. A state
 * that wants the pressed look therefore ends holding the button; the page is torn down after
 * the shot, which is the release.
 *
 * `:active` is asked of the element afterwards, for the same reason `focusKeyboard` reads
 * `activeElement` back.
 */
async function pressHold(page, selector, timeout) {
  await page.waitForFunction(visibleIn(selector), undefined, { timeout });
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`pressHold: '${selector}' has no box to press`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const engaged = await page.evaluate((sel) => document.querySelector(sel)?.matches(':active') ?? false, selector);
  if (!engaged) {
    await page.mouse.up();
    throw new Error(`pressHold: '${selector}' did not go :active -- the shot would be the rest state`);
  }
}

/**
 * Run one declarative step. An unknown kind is an error, never a skipped line.
 *
 * Returns nothing, except for `{ playUntil }`, which returns what it cost -- simulated ticks
 * and wall-clock -- so the runner can record it in the report (issue #617's measured cost).
 */
export async function runStep(page, step, timeout) {
  const kinds = Object.keys(step).filter((k) => STEP_KINDS.includes(k));
  if (kinds.length !== 1) {
    throw new Error(`each step needs exactly one known key, got ${JSON.stringify(step)}`);
  }
  const [kind] = kinds;
  if (kind === 'press') return void (await page.keyboard.press(step.press));
  if (kind === 'focusKeyboard') return focusKeyboard(page, step.focusKeyboard, timeout);
  if (kind === 'pressHold') return pressHold(page, step.pressHold, timeout);
  // Its own budget in simulated ticks, not `timeout`: a played match is minutes of wall-clock
  // on software GL, and a wall-clock timeout would read as a broken selector.
  if (kind === 'playUntil') return playUntil(page, step.playUntil);
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
