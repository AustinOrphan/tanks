import { describe, expect, it } from 'vitest';

import { advancePlay, PLAY_START, webglOverrideSource } from './steps.mjs';

/**
 * Issue #700. `webglOverrideSource` returns page-side source for a browser, so a unit test
 * runs it against stand-in globals: a canvas prototype whose `getContext` the mode may patch,
 * and a WebGL2 context prototype whose `createFramebuffer` it may patch. What matters is WHICH
 * one each mode touches, because that decides whether the page shows the fatal page or the
 * recoverable overlay. The browser run in the PR is the evidence that the overlay appears.
 */
function run(mode: string) {
  const realGetContext = function getContext() {
    return 'real context';
  };
  const realCreateFramebuffer = function createFramebuffer() {
    return 'real framebuffer';
  };
  const HTMLCanvasElement = { prototype: { getContext: realGetContext } };
  const WebGL2RenderingContext = { prototype: { createFramebuffer: realCreateFramebuffer } };
  new Function('HTMLCanvasElement', 'WebGL2RenderingContext', webglOverrideSource(mode))(
    HTMLCanvasElement,
    WebGL2RenderingContext,
  );
  return { HTMLCanvasElement, WebGL2RenderingContext, realGetContext, realCreateFramebuffer };
}

/**
 * Issue #617. `advancePlay` decides a `{ playUntil }` step one poll at a time, so every way a
 * played capture can end is driven here with hand-written samples. The browser run in the PR
 * is the evidence that a real match reaches its ending inside the budget.
 */
describe('steps.mjs: advancePlay, the verdict of a played step', () => {
  const target = { visible: '.hud-action', maxTicks: 1000 };
  const STALL = 15000;
  /** Feed samples in order, one second apart, and return the last verdict. */
  function play(samples: Array<{ visible: boolean; ticks: number | null; truncated?: boolean; text?: string | null }>, t = target) {
    let state = PLAY_START;
    let verdict: ReturnType<typeof advancePlay> | undefined;
    samples.forEach((sample, i) => {
      verdict = advancePlay(state, { truncated: false, text: null, ...sample }, t, i * 1000, STALL);
      state = verdict.state;
    });
    return verdict!;
  }

  it('reaches the target, reporting the simulated ticks it took', () => {
    const v = play([{ visible: false, ticks: 100 }, { visible: false, ticks: 400 }, { visible: true, ticks: 420 }]);
    expect(v).toMatchObject({ reached: true, error: null, ticks: 420 });
  });

  it('sums ticks across a world rebuild, where the replay trace restarts at 0', () => {
    // A lost life or a new level starts a new trace. Negative control: reading only the
    // current trace reports 50 here, and a budget measured that way would let a capture play
    // several worlds while claiming to be inside it.
    const v = play([{ visible: false, ticks: 600 }, { visible: false, ticks: 20 }, { visible: true, ticks: 50 }]);
    expect(v).toMatchObject({ reached: true, ticks: 650 });
  });

  it('fails an over-budget run as "the game did not end", naming the selector, counted across worlds', () => {
    // 700 then a rebuild to 350 is 1050 simulated ticks, over the budget of 1000 -- though
    // neither world alone is. Negative control: dropping the banked count lets this pass.
    const v = play([{ visible: false, ticks: 700 }, { visible: false, ticks: 350 }]);
    expect(v.reached).toBe(false);
    expect(v.error).toBe("playUntil: the game did not end -- '.hud-action' was not visible after 1050 simulated ticks (budget 1000)");
  });

  it('refuses a state with no replay surface, rather than playing with no budget', () => {
    const v = play([{ visible: false, ticks: null }]);
    expect(v.error).toMatch(/no replay surface.*dev=1&replay=1/);
  });

  it('fails a truncated trace, and a simulation that stops advancing', () => {
    expect(play([{ visible: false, ticks: 500, truncated: true }]).error).toMatch(/replay trace truncated at 500 ticks/);
    // 17 polls a second apart at the same count: 16 s without a tick, over the 15 s limit.
    const stalled = play(Array.from({ length: 17 }, () => ({ visible: false, ticks: 300 })));
    expect(stalled.error).toMatch(/stopped advancing at 300 ticks/);
    // Negative control for the stall rule: the same span with the count moving is not stalled.
    const moving = play(Array.from({ length: 17 }, (_, i) => ({ visible: false, ticks: 300 + i })));
    expect(moving.error).toBeNull();
  });

  it('fails when the game ends on the WRONG screen, quoting what it says instead', () => {
    // Negative control: ignoring `expect` reports a Mission Clear panel as a reached Game Over.
    const gameOver = { ...target, expect: { selector: '.hud-title', text: 'Game Over' } };
    const wrong = play([{ visible: false, ticks: 200 }, { visible: true, ticks: 240, text: 'Level 3 cleared!' }], gameOver);
    expect(wrong.reached).toBe(false);
    expect(wrong.error).toBe(
      "playUntil: the game ended, but '.hud-title' reads \"Level 3 cleared!\" rather than \"Game Over\", after 240 simulated ticks",
    );
    const right = play([{ visible: true, ticks: 240, text: 'Game Over' }], gameOver);
    expect(right).toMatchObject({ reached: true, ticks: 240 });
  });
});

describe('steps.mjs: the WebGL override each mode installs', () => {
  it('match-build-fails leaves getContext alone and makes framebuffer allocation throw an UNTYPED error (issue #700)', () => {
    // Negative controls: patching getContext instead is what #669 turns into a typed, fatal
    // failure (the full page, not the overlay); throwing a typed error would be classified
    // the same way. Both are the regression this mode exists to avoid.
    const { HTMLCanvasElement, WebGL2RenderingContext, realGetContext, realCreateFramebuffer } = run('match-build-fails');
    expect(HTMLCanvasElement.prototype.getContext).toBe(realGetContext);
    expect(WebGL2RenderingContext.prototype.createFramebuffer).not.toBe(realCreateFramebuffer);
    let thrown: unknown = null;
    try {
      WebGL2RenderingContext.prototype.createFramebuffer();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).constructor).toBe(Error);
    expect((thrown as Error).message).toMatch(/^capture: /);
  });

  it('probe-blocked still breaks the context itself, and leaves framebuffers alone', () => {
    // The boot-time probe-blocked screen depends on getContext throwing for webgl2.
    const { HTMLCanvasElement, WebGL2RenderingContext, realCreateFramebuffer } = run('probe-blocked');
    expect(WebGL2RenderingContext.prototype.createFramebuffer).toBe(realCreateFramebuffer);
    expect(() => HTMLCanvasElement.prototype.getContext.call({}, 'webgl2')).toThrow('capture: webgl2 blocked');
    expect(HTMLCanvasElement.prototype.getContext.call({}, '2d')).toBe('real context');
  });

  it('refuses a mode it does not know', () => {
    expect(() => webglOverrideSource('broken-somehow')).toThrow("unknown webgl mode 'broken-somehow'");
  });
});
