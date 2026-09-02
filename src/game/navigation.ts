/**
 * Navigation state for the application's layers (issue #318): a layer stack, and a mirror
 * that keeps the browser's history in step with it.
 *
 * PURE. This module imports nothing and names no browser global. The one function that
 * touches a browser object, `browserHistoryHost`, takes that object as an argument, so
 * every other export can be driven from a node-environment test with plain values.
 *
 * WHAT A LAYER IS. The primary surface -- Main Menu, the pause panel, an outcome screen --
 * is owned by the state machine (`state.ts`) and painted by the page (`route-host.ts`).
 * A layer is what opens OVER it: the Records page, the paint shop, the Levels grid, the
 * controller panel, Versus Setup. Until this module those were six panes toggled by class
 * inside `hud.ts`, each with a Back button that hard-coded where it returned to, and no
 * record of which control had opened it. The stack records both: the surface a layer was
 * pushed over (`origin`) and an opaque `restore` value the owner uses to put focus back.
 *
 * WHAT A LAYER IS NOT. Pause is a gameplay phase, not a layer, and the outcome screens are
 * a session-owned phase. Neither enters this stack; the owner resets the stack on every
 * primary-surface change instead, so a layer can never outlive the surface it opened over.
 *
 * TWO KINDS, ONE RULE. `route` is a full-screen destination; `overlay` is a blocking layer
 * (a confirmation, a dialog). A route may never be pushed over an overlay -- the spec's
 * "no full-screen destination opens under a modal" -- which is what makes the issue's
 * "Back removes one overlay before one route" true by construction: an overlay is always
 * above every route, so a plain LIFO pop IS that order.
 */

export type LayerKind = 'route' | 'overlay';

/**
 * One layer over the primary surface. `origin` is the surface the layer was pushed over and
 * the surface Back returns to when this is the last layer. `restore` is opaque here: the
 * HUD stores the control that opened the layer in it, and this module never reads it.
 */
export interface LayerEntry<Id extends string, Origin extends string, Restore> {
  readonly id: Id;
  readonly kind: LayerKind;
  readonly origin: Origin;
  readonly restore: Restore;
}

export type PushResult = 'opened' | 'already-top' | 'refused';

export interface LayerStack<Id extends string, Origin extends string, Restore> {
  readonly depth: number;
  top(): LayerEntry<Id, Origin, Restore> | null;
  /**
   * `'already-top'` when the id is the one on top (the stack is unchanged, and the owner
   * re-renders rather than re-opens); `'refused'` for a route pushed over an overlay, or
   * for an id already open lower in the stack. Never throws.
   */
  push(entry: LayerEntry<Id, Origin, Restore>): PushResult;
  /** LIFO. `null` when empty. */
  pop(): LayerEntry<Id, Origin, Restore> | null;
  /** Empty the stack; returns the cleared entries top-first (`[]` when it was empty). */
  reset(): readonly LayerEntry<Id, Origin, Restore>[];
}

export function createLayerStack<Id extends string, Origin extends string, Restore>(): LayerStack<
  Id,
  Origin,
  Restore
> {
  const entries: LayerEntry<Id, Origin, Restore>[] = [];
  return {
    get depth(): number {
      return entries.length;
    },
    top(): LayerEntry<Id, Origin, Restore> | null {
      return entries.length === 0 ? null : entries[entries.length - 1];
    },
    push(entry): PushResult {
      const top = entries.length === 0 ? null : entries[entries.length - 1];
      if (top !== null && top.id === entry.id) return 'already-top';
      if (entries.some((open) => open.id === entry.id)) return 'refused';
      if (entry.kind === 'route' && top !== null && top.kind === 'overlay') return 'refused';
      entries.push(entry);
      return 'opened';
    },
    pop(): LayerEntry<Id, Origin, Restore> | null {
      return entries.pop() ?? null;
    },
    reset(): readonly LayerEntry<Id, Origin, Restore>[] {
      return entries.splice(0, entries.length).reverse();
    },
  };
}

// ---------------------------------------------------------------------------
// The browser-history mirror
// ---------------------------------------------------------------------------

/**
 * What the mirror needs from a browser's history. `browserHistoryHost` adapts a window;
 * a test passes a plain object whose `back()` fires `onPopState` synchronously.
 */
export interface HistoryHost {
  readonly state: unknown;
  /** The adapter passes NO url: the entry keeps the page's own URL, search and hash. */
  pushState(state: unknown): void;
  replaceState(state: unknown): void;
  back(): void;
  /** Returns the unsubscribe. */
  onPopState(cb: (state: unknown) => void): () => void;
}

/**
 * The one entry the mirror ever pushes. State-only: no URL, so `location.search` (which
 * selects developer mode and the storage namespace) and the relative-base deployment are
 * untouched by construction.
 */
export const LAYER_SENTINEL: { readonly tanks: 'layer' } = Object.freeze({ tanks: 'layer' as const });

export function isLayerSentinel(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { tanks?: unknown }).tanks === 'layer';
}

/**
 * Where the mirror stands relative to the browser's session history.
 *
 *  - `absent`: no sentinel entry exists; the current entry is the page's base.
 *  - `present`: the sentinel is the current entry; a browser Back lands on the base.
 *  - `leaving`: we asked the browser to go back to the base and the traversal has not
 *    landed yet (`history.back()` is asynchronous everywhere, jsdom included).
 *  - `repush`: a layer was pushed while that traversal was pending; when it lands, the
 *    sentinel is pushed again.
 */
export type MirrorPhase = 'absent' | 'present' | 'leaving' | 'repush';

export interface HistoryMirror {
  /** `false` with no host, or after any History call threw (rate limits, sandboxing). */
  readonly active: boolean;
  readonly phase: MirrorPhase;
  /** Call after every stack change with the new depth. Idempotent. */
  sync(depth: number): void;
  /** Unsubscribes from popstate. Never traverses. */
  dispose(): void;
}

export interface HistoryMirrorDeps {
  readonly depth: () => number;
  /**
   * Pop one layer in-app, the same way the Back button does. The owner's implementation
   * ends by calling `sync` itself, which is what re-pushes the sentinel when layers remain.
   */
  readonly back: () => void;
}

/**
 * ONE sentinel entry while the stack is non-empty, retired by ONE `back()` when it empties.
 *
 * Why one entry rather than one per layer: a per-layer mirror has to traverse on every
 * in-app pop, and a push that races a pending traversal leaves a forward entry dangling
 * or pops a layer the player just opened. With a single sentinel an in-app pop that leaves
 * layers open touches history not at all, at most one traversal is ever pending, and a
 * push during it is deferred to the landing (`repush`). A browser Back with a layer open
 * lands on the base entry, and that landing pops ONE layer through the owner's own Back
 * path, so close callbacks stay balanced with opens.
 *
 * Every History call is wrapped: Safari and Firefox rate-limit `pushState` and throw a
 * `SecurityError` past the limit, and a throw from inside a keydown or popstate handler
 * would be an uncaught page error. The first throw latches the mirror off; the in-app
 * stack keeps working and the page keeps the browser's default Back.
 *
 * Known costs, accepted: a reload while a layer was open leaves the previous document's
 * base entry below this one, so the next browser Back reloads the same URL once before
 * leaving; Forward onto our own sentinel after popping to the base costs one inert Back
 * press (the sentinel is re-stamped as base rather than traversed away from, which would
 * add a second pending traversal); a browser Back racing an in-app Back within one task
 * leaves two traversals pending and the second leaves the page -- not reachable by hand.
 */
export function createHistoryMirror(host: HistoryHost | null, deps: HistoryMirrorDeps): HistoryMirror {
  let active = host !== null;
  let phase: MirrorPhase = 'absent';
  let unsubscribe: (() => void) | null = null;

  function safe(fn: () => void): void {
    if (!active) return;
    try {
      fn();
    } catch {
      active = false;
      phase = 'absent';
    }
  }

  function sync(depth: number): void {
    if (host === null || !active) return;
    // The phase moves BEFORE the History call it describes. A host whose traversal lands
    // synchronously (a test's fake; no browser does this) would otherwise deliver the
    // popstate while the phase still reads `present`, and the retirement it reports would
    // be taken for a real Back. `safe` puts the phase back to `absent` if the call throws.
    if (depth > 0) {
      if (phase === 'absent') {
        phase = 'present';
        safe(() => host.pushState(LAYER_SENTINEL));
      } else if (phase === 'leaving') {
        phase = 'repush';
      }
      return;
    }
    if (phase === 'present') {
      phase = 'leaving';
      safe(() => host.back());
    } else if (phase === 'repush') {
      phase = 'leaving';
    }
  }

  function onPop(state: unknown): void {
    if (host === null || !active) return;
    if (isLayerSentinel(state)) {
      // Forward onto our own entry. With layers open it is simply current again; with
      // none it is re-stamped as the base rather than traversed away from.
      if (deps.depth() > 0) {
        phase = 'present';
      } else {
        safe(() => host.replaceState(null));
        phase = 'absent';
      }
      return;
    }
    const previous = phase;
    // Set BEFORE acting: the owner's `back()` ends with `sync(depth)`, and that call must
    // see the landed state, not the one we are still processing.
    phase = 'absent';
    if (previous === 'leaving') return; // our own retirement landed
    if (previous === 'repush') {
      sync(deps.depth()); // honour the push made during the traversal
      return;
    }
    // A real browser or OS Back with the sentinel current: consume one in-app layer.
    if (deps.depth() > 0) deps.back();
  }

  if (host !== null) {
    // A reload while a layer was open carries the sentinel on the loaded entry; the stack
    // is empty, so the entry is this document's base and is stamped as such.
    if (isLayerSentinel(host.state)) safe(() => host.replaceState(null));
    unsubscribe = host.onPopState(onPop);
  }

  return {
    get active(): boolean {
      return active;
    },
    get phase(): MirrorPhase {
      return phase;
    },
    sync,
    dispose(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/** Structural, so a real window satisfies it and a test can pass a plain object. */
export interface HistoryWindow {
  readonly history?: {
    readonly state: unknown;
    pushState(data: unknown, unused: string): void;
    replaceState(data: unknown, unused: string): void;
    back(): void;
  };
  addEventListener(type: 'popstate', fn: (e: { readonly state: unknown }) => void): void;
  removeEventListener(type: 'popstate', fn: (e: { readonly state: unknown }) => void): void;
}

/**
 * Adapt a window's history. `null` when the host has no usable `pushState`, which is the
 * issue's "where supported": the in-app stack still works, and Back is the browser's own.
 */
export function browserHistoryHost(w: HistoryWindow): HistoryHost | null {
  const history = w.history;
  if (history === undefined || typeof history.pushState !== 'function') return null;
  return {
    get state(): unknown {
      return history.state;
    },
    pushState: (state) => history.pushState(state, ''),
    replaceState: (state) => history.replaceState(state, ''),
    back: () => history.back(),
    onPopState(cb): () => void {
      const listener = (e: { readonly state: unknown }): void => cb(e.state);
      w.addEventListener('popstate', listener);
      return () => w.removeEventListener('popstate', listener);
    },
  };
}
