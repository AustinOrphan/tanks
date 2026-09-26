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
/**
 * Answer the entry script's request according to a state's `entry` mode (issue #781).
 *
 * SHARED, and that is the point. This began as four lines inside `captureState`, and the
 * layout sweep's own driver -- which navigates for itself -- did not get them, so both
 * failure states timed out in all four viewports of the required `visual` job: the page
 * simply booted normally and the card never appeared. The touch flag had the same shape of
 * bug one issue earlier. One implementation, called by every driver that navigates.
 *
 * Both modes ANSWER the request, which is what separates them from `boot: 'holding'`: that
 * never replies, so the page waits on its card forever. A 404 completes and fires a resource
 * `error` whose target is the script element; a body that cannot parse completes and fires
 * one whose `filename` is the script's `src`. `index.html`'s inline guard keys on exactly
 * that difference to choose which card to draw, so mixing the two up photographs the wrong
 * card and still looks correct.
 *
 * @param {any} page a Playwright page, before it has navigated
 * @param {string | undefined} entry one of `ENTRY_MODES`
 */
export async function applyEntryMode(page, entry) {
  if (entry === 'refused') {
    await page.route('**/*.js', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  } else if (entry === 'unparseable') {
    await page.route('**/*.js', (route) => route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      // Unbalanced on purpose: this has to fail at PARSE time, not throw at run time. A body
      // that parses and then throws reports a different error shape and reaches the guard's
      // other branch.
      body: 'export const broken = (((;',
    }));
  }
}

export function webglOverrideSource(mode) {
  if (!WEBGL_MODES.includes(mode)) throw new Error(`unknown webgl mode '${mode}'`);
  if (mode === 'match-build-fails') {
    // The context is left alone, so the renderer is constructed and #669's typed context
    // failure never fires. A render-target allocation AFTER it then throws an untyped Error,
    // which `classifyStartupFailure` reads as "we do not know" at the match boundary: the
    // recoverable overlay (issue #700).
    //
    // WHY NOT `createFramebuffer`, which this used until issue #851. The override has to
    // throw from BELOW the one statement `scene.ts` wraps in `RenderContextUnavailableError`
    // -- `new THREE.WebGLRenderer(...)` -- because #325 made that wrap fatal and fatal takes
    // the full-page "this browser cannot run Tanks!" state at both boundaries. three 0.186
    // allocates a framebuffer inside that constructor, so the old override started throwing
    // one statement too early and the capture landed on the fatal page instead. It was
    // invisible for as long as it was because nothing in required CI runs this state.
    //
    // RE-MEASURED on three 0.186, same method as the original. First call site, and whether
    // the overlay is reached:
    //
    //   createFramebuffer      12 calls   new WebGLRenderer          FATAL page
    //   texImage2D             16 calls   new WebGLTexture           FATAL page
    //   framebufferTexture2D   16 calls   setupRenderTarget          overlay  <- used
    //   createProgram           8 calls   acquireProgram             overlay
    //   linkProgram             8 calls   acquireProgram             overlay
    //   drawElements         3963 calls   renderBufferDirect         overlay
    //
    // `framebufferTexture2D` is the earliest of the four that still lands on the overlay,
    // which keeps this override as close to the original intent -- the first render-target
    // allocation after the context -- as the renderer's own internals now allow. Note the
    // call counts: the original comment recorded each as called exactly once, and none is.
    return `(() => {
    WebGL2RenderingContext.prototype.framebufferTexture2D = function () {
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
  /**
   * One connected pad with NOTHING held (issue #917).
   *
   * `mixed` cannot be used with `{ padPress }`, and that is a measured fact rather than a
   * style preference: its pad 0 ships with button 7 already down, and the menu poller
   * dispatches that on its first read, so the fixture actuates the interface on its own. It
   * is what made the first draft of `screen.main-menu.pad-only` pass with the press REMOVED
   * -- the splash was being dismissed by the fixture, not by the press, and the state proved
   * nothing about either.
   *
   * So a state that wants the press to be the only actuation starts from a silent pad. Still
   * a real, standard-mapping pad, because the point is a pad that is connected and idle,
   * which is what a controller sitting on a desk actually reports.
   */
  idle: [
    {
      index: 0,
      id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    },
  ],
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
  // The array is parked on a window global and `getGamepads` reads it on every call, rather
  // than closing over a frozen snapshot. That is what lets `{ padPress }` below actuate a
  // button: the pads have to be MUTABLE between polls, because `createGamepadMenuPoller`
  // dispatches on the press->release EDGE and a static array never has one. Measured while
  // reproducing issue #917 -- a fixture that only ever reads "button 7 is down" can model a
  // pad being CONNECTED, and cannot press anything.
  return `(() => {
    window.__screenPads = ${JSON.stringify(pads)};
    navigator.getGamepads = () => window.__screenPads;
  })()`;
}

/**
 * Actuate one button on the pads `{ fakeGamepads }` installed: down, hold, up.
 *
 * `times` repeats the whole press. More than one matters because the modality tracker only
 * adopts a new input after `MODALITY_SWITCH_MS` (400ms) of it holding the field, and the
 * poller notes 'gamepad' only on a pad ACTION -- so a single press cannot switch a page that
 * was last touched by a pointer, and `gapMs` is what carries the second press past that
 * threshold.
 *
 * THROWS if no fake pad is installed. That is the realistic failure -- a state that forgets
 * `{ fakeGamepads }` first would otherwise press into `navigator.getGamepads()`'s real empty
 * list, photograph the rest state, and look exactly like a capture of a page where the pad
 * did nothing.
 */
function padPressSource(spec) {
  const button = spec.button;
  const holdMs = spec.holdMs ?? 120;
  return `(async () => {
    const pads = window.__screenPads;
    if (!Array.isArray(pads) || pads.length === 0) {
      throw new Error('padPress: no synthetic pad installed -- this state needs { fakeGamepads } first');
    }
    const pad = pads[0];
    if (!pad || !Array.isArray(pad.buttons) || pad.buttons.length <= ${button}) {
      throw new Error('padPress: pad 0 has no button ${button}');
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const set = (down) => {
      pad.buttons[${button}] = { pressed: down, value: down ? 1 : 0 };
      pad.timestamp = performance.now();
    };
    set(true);
    await wait(${holdMs});
    set(false);
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
  if (kind === 'padPress') {
    // Applied to the LIVE page like the two steps above. `times` presses are spaced by
    // `gapMs` so a page whose last input was a pointer can actually reach the gamepad
    // modality, which takes two notes 400ms apart.
    const spec = step.padPress;
    const times = spec.times ?? 1;
    const gapMs = spec.gapMs ?? 450;
    for (let n = 0; n < times; n++) {
      if (n > 0) await page.waitForTimeout(gapMs);
      await page.evaluate(padPressSource(spec));
    }
    // Settle, so the poller's next frame has run before whatever asserts on the result.
    await page.waitForTimeout(120);
    return;
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
