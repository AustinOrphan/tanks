/**
 * The browser did not give the match a rendering context (issue #325).
 *
 * WHY THIS IS A TYPE and not a bare `Error`: `startup-failure.ts` classifies a thrown value
 * into the branded state a player sees, and the single most important thing it decides is
 * whether the failure is FATAL (the renderer is absent, so every later match fails the same
 * way) or TRANSIENT (this match failed, the next might not). It can only decide that from
 * the CAUSE, so a cause that arrives untyped is necessarily classified as "we do not know",
 * which resolves to transient.
 *
 * That was a real, recorded hole rather than a hypothetical. `startup-failure.ts` carried it
 * as a KNOWN RESIDUAL: `UnsupportedRenderError` is thrown by the boot-time capability PROBE
 * (issue #470) and nothing else, so a browser that passed the probe and then failed to build
 * a context during `createScene` -- a context lost between the two, a GPU blocklisted for the
 * real renderer but not the probe canvas, a driver that answers a probe and refuses a second
 * context -- threw a bare `Error`, was classified `match-failed`, and handed the player a
 * dismissable overlay and a Main Menu whose every Start would fail identically. The copy was
 * written carefully enough not to be a lie, but the player could retry forever.
 *
 * WHY IT LIVES IN `presentation/`: `render/scene.ts` throws it and `game/startup-failure.ts`
 * reads it, which is this layer's stated job -- renderer-independent vocabulary more than one
 * layer reads. Putting it in `game/` would make `render -> game` an inverted import, and
 * putting it in `render/` would pull Three.js into `startup-failure.ts`, which `boot.ts` and
 * `hud.ts` both import, so a failure-copy module would drag the whole renderer into the boot
 * path. It names no Three.js type, holds no DOM, and carries the original throw as `cause`
 * so `reportError` still receives everything a developer needs.
 */
export class RenderContextUnavailableError extends Error {
  constructor(override readonly cause: unknown) {
    super('The browser did not provide a WebGL 2 rendering context for the match.');
    this.name = 'RenderContextUnavailableError';
  }
}
