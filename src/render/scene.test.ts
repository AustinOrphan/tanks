// @vitest-environment jsdom
/*
 * jsdom implements no WebGL, so `canvas.getContext('webgl2')` returns null and Three throws
 * while constructing its renderer. That makes this environment an exact stand-in for the
 * browser this code path exists for -- one that hands back no context -- rather than a
 * simulation of it, which is why the assertion below is worth more than a mocked throw.
 */
import { describe, it, expect } from 'vitest';
import { createScene } from './scene';
import { RenderContextUnavailableError } from '../presentation/render-context';

describe('createScene when the browser will not give it a context (issue #325)', () => {
  const build = () => createScene(document.createElement('canvas'), 20, 15, 1);

  it('throws the TYPED failure, not a bare Error', () => {
    // What this buys, and it is not tidiness: `classifyStartupFailure` decides FATAL vs
    // TRANSIENT from the cause alone. Untyped, this reaches it as "we do not know", resolves
    // to a dismissable match-failed overlay, and the player retries forever against a
    // browser that cannot render. boot.test.ts pins that classification; this pins that the
    // classification is ever reachable from the real code path.
    expect(build).toThrow(RenderContextUnavailableError);
  });

  it('carries the original throw as `cause`', () => {
    // Player copy says nothing technical by design, so the real error has to survive to
    // `reportError` or the wrapper has traded a debuggable report for a nicer sentence.
    let caught: unknown;
    try { build(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(RenderContextUnavailableError);
    const cause = (caught as RenderContextUnavailableError).cause;
    expect(cause, 'the underlying throw was swallowed').toBeDefined();
    // Three's own message, not one this repository wrote. Asserted loosely -- the exact
    // wording is Three's to change -- but asserted at all, because a wrapper that stored its
    // own message here would look identical to one that kept the real cause.
    expect(String(cause)).toMatch(/context/i);
  });

  it('surfaces as the CONTEXT failure, not as a null dereference further down', () => {
    // The failure mode wrapping a constructor invites: catching and continuing, so the scene
    // builds on with no renderer and dies somewhere below on a property of `undefined`. That
    // still throws -- a bare `expect(build).toThrow()` passes under it, which is why this
    // asserts the TYPE and explicitly rejects the downstream shape instead.
    //
    // MEASURED: the `scene-context-failure-swallowed` mutation makes this a `TypeError`.
    let caught: unknown;
    try { build(); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(RenderContextUnavailableError);
    expect(caught, 'the failure escaped as a downstream null dereference').not.toBeInstanceOf(TypeError);
  });
});
