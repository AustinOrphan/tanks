import { describe, expect, it } from 'vitest';

import { webglOverrideSource } from './steps.mjs';

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
