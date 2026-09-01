// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  probeRenderCapability,
  LOSE_CONTEXT_EXTENSION,
  RENDER_CAPABILITY_SUPPORTED,
  WEBGL2_CONTEXT_ID,
  type ProbeCanvasLike,
  type ProbeContextLike,
  type RenderCapabilityHost,
} from './render-capability';

/**
 * A host that records what the probe did to it.
 *
 * jsdom cannot stand in for a real browser here in EITHER direction: it has no WebGL, so
 * `getContext('webgl2')` always returns null and every run would take the unsupported
 * branch. That is why the host is injected, and why the supported branch below is only
 * reachable through this fake.
 */
function fakeHost(
  opts: {
    context?: ProbeContextLike | null;
    extension?: unknown;
    createElement?: () => ProbeCanvasLike | null;
    throwOnGetContext?: boolean;
    throwOnGetExtension?: boolean;
  } = {},
): {
  host: RenderCapabilityHost;
  contextIds: string[];
  extensionNames: string[];
  loseContextCalls: number;
  canvases: ProbeCanvasLike[];
} {
  const contextIds: string[] = [];
  const extensionNames: string[] = [];
  const canvases: ProbeCanvasLike[] = [];
  const box = { loseContextCalls: 0 };

  const defaultExtension = {
    loseContext(): void {
      box.loseContextCalls += 1;
    },
  };

  const context: ProbeContextLike | null =
    opts.context !== undefined
      ? opts.context
      : {
          getExtension(name: string): unknown {
            extensionNames.push(name);
            if (opts.throwOnGetExtension) throw new Error('getExtension refused');
            return 'extension' in opts ? opts.extension : defaultExtension;
          },
        };

  const makeCanvas = (): ProbeCanvasLike => ({
    getContext(contextId: 'webgl2'): ProbeContextLike | null {
      contextIds.push(contextId);
      if (opts.throwOnGetContext) throw new Error('getContext refused');
      return context;
    },
  });

  const host: RenderCapabilityHost = {
    createElement: (): ProbeCanvasLike | null => {
      if (opts.createElement) return opts.createElement();
      const canvas = makeCanvas();
      canvases.push(canvas);
      return canvas;
    },
  };

  return {
    host,
    contextIds,
    extensionNames,
    canvases,
    get loseContextCalls(): number {
      return box.loseContextCalls;
    },
  };
}

describe('probeRenderCapability: which context it asks for', () => {
  /**
   * The claim this module is BUILT on, checked against the shipped dependency rather than
   * against three.js's documentation or its defaults.
   *
   * Would fail if: the pinned three version regained a WebGL 1 fallback, or moved to a
   * different context id. Either would make the probe answer a question the renderer no
   * longer asks -- reporting supported where `new THREE.WebGLRenderer` still throws, or
   * unsupported where it would have worked.
   */
  it('is the only context id three will accept, read out of the shipped build', () => {
    const require = createRequire(import.meta.url);
    // Located through the one subpath three's `exports` map allows -- it publishes no
    // `./package.json` entry, so the manifest is read off the filesystem beside the
    // resolved entry rather than through module resolution.
    const pkgPath = resolve(dirname(require.resolve('three')), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports: { '.': { import: string } };
    };
    // The `import` condition, not `require`: that is the entry Vite resolves for the
    // `import * as THREE from 'three'` in `render/scene.ts`, so it is the file whose
    // behaviour the shipped bundle actually gets.
    const entry = new URL(pkg.exports['.'].import, pathToFileURL(pkgPath));
    const source = readFileSync(entry, 'utf8');
    // The single acquisition site: `const contextName = 'webgl2';` with no sibling
    // assignment for a fallback level.
    //
    // EITHER quote style (PR #474 review). The claim is about the context ID three asks
    // for, not about how its bundler happens to emit string literals -- a single-quote-only
    // pattern would fail this test on a formatting change that left the id untouched, which
    // is a false report about the one fact the module is built on. A build that dropped the
    // line entirely still fails, because the match list is then empty.
    const names = [...source.matchAll(/const contextName = ['"]([a-z0-9]+)['"]/g)].map((m) => m[1]);
    expect(names).toEqual([WEBGL2_CONTEXT_ID]);
  });

  it('asks the canvas for exactly that id, once', () => {
    const h = fakeHost();
    probeRenderCapability(h.host);
    expect(h.contextIds).toEqual([WEBGL2_CONTEXT_ID]);
  });

  /**
   * No context attributes.
   *
   * Would fail if someone threaded `{ antialias }` through: three treats an
   * attribute-driven refusal as a different condition from an absent context, and a probe
   * that failed on `antialias` would report a `low`-quality-capable device as unsupported.
   */
  it('asks with no attributes, so a quality knob cannot read as a missing capability', () => {
    const seen: unknown[][] = [];
    const host: RenderCapabilityHost = {
      createElement: () => ({
        getContext(...args: unknown[]): ProbeContextLike {
          seen.push(args);
          return { getExtension: () => null };
        },
      }) as unknown as ProbeCanvasLike,
    };
    probeRenderCapability(host);
    expect(seen).toEqual([[WEBGL2_CONTEXT_ID]]);
  });
});

describe('probeRenderCapability: the answer', () => {
  it('reports supported when the browser hands back a context', () => {
    expect(probeRenderCapability(fakeHost().host)).toEqual(RENDER_CAPABILITY_SUPPORTED);
  });

  it('reports no-webgl2 when the browser hands back null', () => {
    const h = fakeHost({ context: null });
    expect(probeRenderCapability(h.host)).toEqual({ webgl2: false, failure: 'no-webgl2' });
  });

  /**
   * The distinction issue #470 asks for: "could not ask" is not "asked and was told no".
   *
   * Would fail if the catch collapsed both into `no-webgl2`, which would tell #325's
   * branded screen to blame the GPU for a locked-down document.
   */
  it('reports probe-failed, not no-webgl2, when getContext throws', () => {
    const h = fakeHost({ throwOnGetContext: true });
    expect(probeRenderCapability(h.host)).toEqual({ webgl2: false, failure: 'probe-failed' });
  });

  it('reports probe-failed when the host produces no canvas at all', () => {
    const h = fakeHost({ createElement: () => null });
    expect(probeRenderCapability(h.host)).toEqual({ webgl2: false, failure: 'probe-failed' });
  });

  /**
   * The host resolution itself is inside the try (PR #474 review).
   *
   * `host: RenderCapabilityHost = globalThis.document` would read that property in the
   * PARAMETER LIST, which is evaluated before the body and therefore outside the try -- so
   * a locked-down context whose `document` getter throws would throw out of the probe
   * instead of reporting `probe-failed`. That is the exact distinction the return type
   * exists to make, defeated by the one property access not covered.
   *
   * Driven against a real throwing getter on `globalThis` rather than through the injected
   * host, because the injected host is what the parameter default BYPASSES: a test that
   * passed one could not see this at all.
   */
  it('reports probe-failed when reading the default document throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      get() {
        throw new Error('document is not available in this context');
      },
    });
    try {
      expect(() => probeRenderCapability()).not.toThrow();
      expect(probeRenderCapability()).toEqual({ webgl2: false, failure: 'probe-failed' });
    } finally {
      if (original) Object.defineProperty(globalThis, 'document', original);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it('reports probe-failed when there is no document at all', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    // `delete` rather than `undefined`: a non-DOM host does not have the property, and
    // `??` has to cover its absence as well as an explicit undefined.
    delete (globalThis as { document?: unknown }).document;
    try {
      expect(probeRenderCapability()).toEqual({ webgl2: false, failure: 'probe-failed' });
    } finally {
      if (original) Object.defineProperty(globalThis, 'document', original);
    }
  });

  it('reports probe-failed when createElement itself throws', () => {
    const host: RenderCapabilityHost = {
      createElement: () => {
        throw new Error('no DOM here');
      },
    };
    expect(probeRenderCapability(host)).toEqual({ webgl2: false, failure: 'probe-failed' });
  });

  it('freezes what it returns, so a consumer cannot rewrite the page-wide answer', () => {
    const answer = probeRenderCapability(fakeHost({ context: null }).host);
    expect(Object.isFrozen(answer)).toBe(true);
  });

  /**
   * jsdom really has no WebGL. This is the one case that runs against a REAL
   * `HTMLCanvasElement` rather than the fake, which is what proves the default host
   * argument and the `document` structural typing are wired -- not just the fake.
   */
  it('runs against a real document and reports this environment unsupported', () => {
    expect(probeRenderCapability()).toEqual({ webgl2: false, failure: 'no-webgl2' });
  });
});

describe('probeRenderCapability: leaves nothing behind', () => {
  /**
   * The acceptance bullet "a successful probe leaves no persistent renderer, canvas, GL
   * resource owner, or listener behind", checked as a COUNT rather than trusted because
   * the call returned.
   *
   * Would fail if the release were dropped: the context would stay live for as long as
   * the canvas is reachable, and `route-ui.ts` documents this page's ceiling as "peak is
   * two live contexts, never three".
   */
  it('hands the context back through WEBGL_lose_context', () => {
    const h = fakeHost();
    probeRenderCapability(h.host);
    expect(h.extensionNames).toEqual([LOSE_CONTEXT_EXTENSION]);
    expect(h.loseContextCalls).toBe(1);
  });

  it('never appends the canvas it made to the document', () => {
    const before = document.body.childElementCount;
    probeRenderCapability();
    expect(document.body.childElementCount).toBe(before);
    expect(document.querySelector('canvas')).toBeNull();
  });

  /**
   * A browser with WebGL 2 and no `WEBGL_lose_context` is still SUPPORTED. Denying
   * gameplay over a release detail would be a worse bug than the leak it avoids.
   */
  it('still reports supported when the release extension is missing', () => {
    const h = fakeHost({ extension: null });
    expect(probeRenderCapability(h.host)).toEqual(RENDER_CAPABILITY_SUPPORTED);
    expect(h.loseContextCalls).toBe(0);
  });

  it('still reports supported when asking for the release extension throws', () => {
    const h = fakeHost({ throwOnGetExtension: true });
    expect(probeRenderCapability(h.host)).toEqual(RENDER_CAPABILITY_SUPPORTED);
  });
});
