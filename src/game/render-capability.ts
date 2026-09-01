/**
 * Can this browser give us the WebGL level the gameplay renderer needs? (issue #470)
 *
 * Until now the answer was only ever discovered by TRYING: `boot.ts` wraps
 * `sessions.start()` in a try/catch, `startGameWith` builds a `THREE.WebGLRenderer`, and a
 * browser without WebGL 2 throws out of that constructor into the catch that paints
 * `NO_WEBGL_MESSAGE`. That works, but it makes the capability answer a SIDE EFFECT of
 * eager gameplay construction -- the one thing issue #428 exists to remove. This module is
 * the seam that separates them, so the page can know the answer before it has a session,
 * a world, a seed, a driver, a frame loop or a canvas anyone can see.
 *
 * WHY `webgl2` AND NOTHING ELSE. Read out of the shipped dependency rather than inferred
 * from three.js's documented defaults: `node_modules/three/build/three.module.js` acquires
 * its context with a single `const contextName = 'webgl2';` and there is no WebGL 1
 * fallback path after it (three r169, the version this repo pins at `^0.169.0`). Probing
 * for `'webgl'` would therefore report SUPPORTED on a browser where `new
 * THREE.WebGLRenderer` still throws, which is the exact false negative this probe exists
 * to prevent.
 *
 * WHY NO CONTEXT ATTRIBUTES. `render/scene.ts` builds its renderer with
 * `{ canvas, antialias: quality.antialias }`, and `render/quality.ts` is the only thing
 * that moves that flag (`low` turns it off; `medium`/`high` leave it on). three itself
 * treats an attribute-driven failure as a DIFFERENT condition from an absent context --
 * when `getContext('webgl2', attrs)` returns null it retries with the bare
 * `getContext('webgl2')` and reports "Error creating WebGL context with your selected
 * attributes." if that second call succeeds. Only the second call answers "does this
 * browser do WebGL 2 at all", which is the question this module is asked, so the bare form
 * is what it uses. Antialias is a quality knob, not a capability.
 *
 * This is a ONE-SHOT value, deliberately unlike `capabilities.ts`'s `CapabilitySource`.
 * A pad appears when someone plugs it in, so controller rumble needs a live source with
 * `refresh()`; WebGL 2 support does not arrive mid-document. The shell probes once and
 * retains the answer (`app-shell.ts`), which is also the shape issue #325 needs to render
 * a branded unsupported screen from.
 */

/** Why the probe said no. `null` when it said yes. */
export type RenderCapabilityFailure =
  /**
   * The browser handed back no `webgl2` context. The ordinary unsupported case: an old
   * browser, a blocklisted GPU, hardware acceleration switched off.
   */
  | 'no-webgl2'
  /**
   * The probe itself could not run -- `createElement` or `getContext` THREW rather than
   * returning null.
   *
   * A separate value because issue #470 asks unsupported capability to be distinguishable
   * from an unrelated failure to even ask. A locked-down or non-DOM host lands here, and
   * a consumer that wants to say something more precise than "no WebGL" can. Both are
   * `webgl2: false`, so a consumer that does NOT care keeps one branch.
   */
  | 'probe-failed';

export interface RenderCapability {
  /** Can `THREE.WebGLRenderer` get the context it will ask for? */
  readonly webgl2: boolean;
  /** Which way it failed, or `null` on success. */
  readonly failure: RenderCapabilityFailure | null;
}

export const RENDER_CAPABILITY_SUPPORTED: RenderCapability = Object.freeze({
  webgl2: true,
  failure: null,
});

/**
 * The exact context id three asks for.
 *
 * Exported so the probe's own test can pin it against the string read out of the
 * dependency, rather than the probe and its test agreeing on a typo.
 */
export const WEBGL2_CONTEXT_ID = 'webgl2';

/** The one thing the probe needs from a context: a way to hand it back. */
export interface ProbeContextLike {
  getExtension(name: string): unknown;
}

export interface ProbeCanvasLike {
  getContext(contextId: 'webgl2'): ProbeContextLike | null | undefined;
}

/** Only what the probe needs from `document`, so a test can drive both branches. */
export interface RenderCapabilityHost {
  createElement(tagName: 'canvas'): ProbeCanvasLike | null | undefined;
}

/**
 * The extension that lets us give a context back on purpose.
 *
 * Without it a successful probe would leave a live WebGL context alive for as long as the
 * canvas is reachable, and browsers cap how many a document may hold (the low teens, in
 * practice) -- `route-ui.ts` already documents this page's ceiling as "peak is two live
 * contexts, never three", and a probe that quietly added a permanent third would break
 * that claim without any test noticing. Losing the context is the only supported way to
 * release one early; dropping the reference alone leaves it to the GC.
 */
export const LOSE_CONTEXT_EXTENSION = 'WEBGL_lose_context';

interface LoseContextLike {
  loseContext(): void;
}

function isLoseContext(ext: unknown): ext is LoseContextLike {
  return typeof (ext as LoseContextLike | null)?.loseContext === 'function';
}

/**
 * Ask once, release immediately, return a plain frozen answer.
 *
 * The canvas is created DETACHED and never appended to anything, so there is no element
 * to remove afterwards and nothing can lay out, paint or receive events because of this
 * call. Together with `loseContext()` below, that is the whole of "a successful probe
 * leaves no persistent renderer, canvas, GL resource owner, or listener behind": the
 * canvas is unreachable the moment this function returns, and the context is already
 * lost rather than waiting on the collector.
 *
 * @param host injected so a test can return a null context, a throwing `getContext`, or a
 * context whose `getExtension` is absent -- none of which jsdom can produce, since jsdom
 * has no WebGL at all and would make every run take the unsupported branch.
 */
export function probeRenderCapability(
  host: RenderCapabilityHost = globalThis.document,
): RenderCapability {
  let gl: ProbeContextLike | null | undefined;
  try {
    const canvas = host.createElement('canvas');
    // `probe-failed`, not `no-webgl2`: a host that produced no canvas has not told us
    // anything about WebGL, so it is the same "could not ask" case as a throw.
    if (canvas == null) return Object.freeze({ webgl2: false, failure: 'probe-failed' });
    gl = canvas.getContext(WEBGL2_CONTEXT_ID);
  } catch {
    // A property access can itself throw in a locked-down context -- the case
    // `storage.ts`'s `resolveStorage` exists for, and the reason every probe in
    // `capabilities.ts` is wrapped the same way.
    return Object.freeze({ webgl2: false, failure: 'probe-failed' });
  }

  if (gl == null) return Object.freeze({ webgl2: false, failure: 'no-webgl2' });

  try {
    const ext = gl.getExtension(LOSE_CONTEXT_EXTENSION);
    if (isLoseContext(ext)) ext.loseContext();
  } catch {
    // Releasing early is an optimisation, not the answer. A browser that supports WebGL 2
    // but not `WEBGL_lose_context` -- or one that throws asking -- is still SUPPORTED, and
    // reporting otherwise would deny gameplay over a bookkeeping detail. The context then
    // goes when the detached canvas is collected, which is where it went before this
    // module existed at all.
  }
  return RENDER_CAPABILITY_SUPPORTED;
}
