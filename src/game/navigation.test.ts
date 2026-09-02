import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LAYER_SENTINEL, createHistoryMirror, createLayerStack, isLayerSentinel } from './navigation';
import type { HistoryHost, HistoryMirror, LayerEntry } from './navigation';

// ---------------------------------------------------------------------------
// The layer stack
// ---------------------------------------------------------------------------

type Id = 'a' | 'b' | 'c' | 'settings' | 'confirm' | 'levels' | 'dialog';
type Origin = 'main-menu' | 'settings' | 'pause';
type Restore = { readonly control: string };
type Entry = LayerEntry<Id, Origin, Restore>;

const route = (id: Id, origin: Origin = 'main-menu'): Entry => ({
  id,
  kind: 'route',
  origin,
  restore: { control: `open-${id}` },
});

const overlay = (id: Id, origin: Origin = 'main-menu'): Entry => ({
  id,
  kind: 'overlay',
  origin,
  restore: { control: `open-${id}` },
});

describe('createLayerStack: LIFO over the primary surface', () => {
  it('back pops the topmost layer, LIFO: [route a, route b] pops b then a', () => {
    // Killed by `stack-back-pops-the-bottom` (`pop()` reads from the bottom with `shift()`):
    // the first pop would return `a`, so Back would close the layer UNDER the one on screen.
    const stack = createLayerStack<Id, Origin, Restore>();
    const a = route('a');
    const b = route('b');
    expect(stack.push(a)).toBe('opened');
    expect(stack.push(b)).toBe('opened');
    expect(stack.depth).toBe(2);
    expect(stack.top()).toBe(b);

    expect(stack.pop()).toBe(b);
    expect(stack.top(), 'popping b did not expose a').toBe(a);
    expect(stack.pop()).toBe(a);
    expect(stack.depth).toBe(0);
    expect(stack.top()).toBeNull();
  });

  it('an overlay above a route is removed before the route, and each pop carries its own recorded origin and restore', () => {
    // The issue's "Back removes one overlay before one route", true by construction because an
    // overlay is always above every route. Killed by `stack-back-pops-the-bottom`, which hands
    // Back the route first and leaves the confirmation on screen. The origin/restore
    // assertions fail if `push` stored anything but the caller's entry (a copy with the
    // origin re-derived, say): the owner needs the surface it was opened OVER and the control
    // that opened it back, verbatim, per layer.
    const stack = createLayerStack<Id, Origin, Restore>();
    const settings = route('settings', 'main-menu');
    const confirm = overlay('confirm', 'settings');
    expect(stack.push(settings)).toBe('opened');
    expect(stack.push(confirm)).toBe('opened');

    const first = stack.pop();
    expect(first?.id, 'the route came off before the overlay above it').toBe('confirm');
    expect(first?.kind).toBe('overlay');
    expect(first?.origin).toBe('settings');
    expect(first?.restore).toBe(confirm.restore);

    const second = stack.pop();
    expect(second?.id).toBe('settings');
    expect(second?.kind).toBe('route');
    expect(second?.origin).toBe('main-menu');
    expect(second?.restore).toBe(settings.restore);
    expect(stack.depth).toBe(0);
  });

  it('a route pushed over an open overlay is refused and the stack is unchanged', () => {
    // The spec's "no full-screen destination opens under a modal". Killed by
    // `stack-accepts-a-route-over-an-overlay` (the refusal line deleted): `levels` would open
    // over the confirmation, and the next Back would close the Levels grid while the
    // confirmation the player was answering is still open below it.
    const stack = createLayerStack<Id, Origin, Restore>();
    const confirm = overlay('confirm', 'settings');
    stack.push(route('settings'));
    stack.push(confirm);

    expect(stack.push(route('levels'))).toBe('refused');
    expect(stack.depth, 'the refused route was pushed anyway').toBe(2);
    expect(stack.top()).toBe(confirm);

    // Negative control for the refusal's SHAPE: it is route-over-overlay specifically. An
    // overlay over an overlay (a dialog raising a confirmation) still opens; this fails if
    // the refusal widened to "anything over an overlay".
    expect(stack.push(overlay('dialog', 'settings'))).toBe('opened');
    expect(stack.depth).toBe(3);
  });

  it('pushing the id already on top reports already-top and pushes nothing; an id open lower down is refused', () => {
    // Killed by `stack-push-duplicates-the-top` (the already-top check deleted): the id on top
    // is then caught by the "open lower down" scan and reported `refused`, so the owner
    // would treat a re-open of the current layer as a failure instead of a re-render. The
    // lower-down half fails if the `entries.some(...)` scan goes: `a` would open a second
    // time above `b`, and Back would then land on a stale copy of `a`.
    const stack = createLayerStack<Id, Origin, Restore>();
    const a = route('a');
    const b = route('b');
    stack.push(a);
    stack.push(b);

    const bAgain = route('b', 'pause');
    expect(stack.push(bAgain)).toBe('already-top');
    expect(stack.depth, 'already-top pushed a duplicate').toBe(2);
    expect(stack.top(), 'already-top replaced the entry on top').toBe(b);

    expect(stack.push(route('a', 'pause'))).toBe('refused');
    expect(stack.depth).toBe(2);
    expect(stack.top()).toBe(b);
  });

  it('pop on an empty stack returns null; reset returns the cleared entries top-first and empties', () => {
    // `pop` on empty fails if the `?? null` goes (an `undefined` is not `null`, and the owner
    // branches on `null`). The reset half fails if `.reverse()` goes: the owner closes the
    // cleared layers in the returned order, and closing the bottom route before the overlay
    // above it runs close callbacks against a surface that has already gone.
    const stack = createLayerStack<Id, Origin, Restore>();
    expect(stack.pop()).toBeNull();
    expect(stack.reset()).toEqual([]);

    const a = route('a');
    const b = route('b');
    const c = overlay('c');
    stack.push(a);
    stack.push(b);
    stack.push(c);
    const cleared = stack.reset();
    expect(cleared.map((entry) => entry.id), 'reset did not return top-first').toEqual(['c', 'b', 'a']);
    expect(cleared[0]).toBe(c);
    expect(cleared[2]).toBe(a);
    expect(stack.depth, 'reset left entries behind').toBe(0);
    expect(stack.top()).toBeNull();
    expect(stack.pop()).toBeNull();
    expect(stack.reset()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

const BROWSER_GLOBALS = ['window', 'document', 'history', 'location', 'globalThis'] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** `import ...` statements and dynamic `import(` / `require(` calls, in comment-free code. */
function importSites(code: string): string[] {
  return [...code.matchAll(/^\s*import\b[^\n]*|\b(?:import|require)\s*\(/gm)].map((m) => m[0].trim());
}

/** Names the file declares itself: a local `const history = w.history` is not the global. */
function declaredNames(code: string): Set<string> {
  return new Set([...code.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
}

/**
 * Browser globals referenced bare: not after a `.` (a property read), not a property key
 * (`history?: {`), and not a name the file declares. Textual on purpose -- the module is
 * small and has no strings that could hide a token.
 */
function freeBrowserGlobals(code: string): string[] {
  const declared = declaredNames(code);
  return BROWSER_GLOBALS.filter(
    (name) => !declared.has(name) && new RegExp(`(?<![.\\w$])${name}(?![\\w$])(?!\\s*\\??:)`).test(code),
  );
}

describe('navigation.ts: purity', () => {
  it('imports nothing and names no browser global', () => {
    // The module's own claim ("PURE ... imports nothing and names no browser global"), which
    // is what lets every export but the adapter be driven from this node-environment file.
    // Fails if an `import` lands in the module, or if `createHistoryMirror` ever reads
    // `window`/`history` itself instead of the injected host.
    const code = stripComments(readFileSync(new URL('./navigation.ts', import.meta.url), 'utf8'));
    expect(code, 'read the wrong file').toContain('export function createHistoryMirror');
    expect(importSites(code)).toEqual([]);
    expect(freeBrowserGlobals(code)).toEqual([]);

    // Negative controls, so a green sweep is proven to LOOK. A planted global is found, a
    // planted import is found, a comment is not code, a property read and a property key are
    // not references, and the local-declaration exemption is exactly what lets the adapter's
    // `const history = w.history` through -- the same name undeclared is flagged.
    expect(freeBrowserGlobals('const x = window.innerWidth;')).toEqual(['window']);
    expect(freeBrowserGlobals('history.back();')).toEqual(['history']);
    expect(freeBrowserGlobals('export const g = globalThis;')).toEqual(['globalThis']);
    expect(freeBrowserGlobals('function f(w) { const history = w.history; history.back(); }')).toEqual([]);
    expect(freeBrowserGlobals('interface W { readonly history?: { state: unknown }; }')).toEqual([]);
    expect(freeBrowserGlobals(stripComments('/* window */ // document location\nconst x = 1;'))).toEqual([]);
    expect(importSites("import { x } from './y';")).toHaveLength(1);
    expect(importSites("const m = await import('./y');")).toHaveLength(1);
    expect(importSites("export { x } from './y';")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The browser-history mirror
// ---------------------------------------------------------------------------

type HostCall = 'pushState' | 'replaceState' | 'back';

interface FakeHost extends HistoryHost {
  /** Every History call in order; "touches history not at all" is an unchanged list. */
  readonly calls: HostCall[];
  readonly pushes: unknown[];
  readonly replaces: unknown[];
  readonly listeners: ((state: unknown) => void)[];
  /** Fire popstate by hand: a traversal landing, or a real browser Back/Forward. */
  popstate(state: unknown): void;
}

/**
 * A plain-object host. `back()` fires popstate(null) synchronously unless `manualPop` is
 * set, in which case the test fires the landing itself with `popstate`. Every landing-
 * sensitive case below uses `manualPop`: a real `history.back()` lands in a later task,
 * after `sync` has returned, and only a landing fired after the call reproduces that order.
 * `throwing` makes `pushState` throw, as Safari and Firefox do past their rate limit.
 */
function fakeHost(opts: { state?: unknown; manualPop?: boolean; throwing?: boolean } = {}): FakeHost {
  let state: unknown = opts.state ?? null;
  const host: FakeHost = {
    calls: [],
    pushes: [],
    replaces: [],
    listeners: [],
    get state(): unknown {
      return state;
    },
    pushState(next) {
      host.calls.push('pushState');
      if (opts.throwing) throw new Error('SecurityError: pushState rate limit');
      host.pushes.push(next);
      state = next;
    },
    replaceState(next) {
      host.calls.push('replaceState');
      host.replaces.push(next);
      state = next;
    },
    back() {
      host.calls.push('back');
      state = null;
      if (!opts.manualPop) host.popstate(null);
    },
    onPopState(cb) {
      host.listeners.push(cb);
      return () => {
        const at = host.listeners.indexOf(cb);
        if (at >= 0) host.listeners.splice(at, 1);
      };
    },
    popstate(next) {
      for (const cb of [...host.listeners]) cb(next);
    },
  };
  return host;
}

interface MirrorHarness {
  readonly mirror: HistoryMirror;
  /** Layers open, as the owner's stack reports it to the mirror. */
  depth(): number;
  /** A layer opened in-app: the stack grew, then `sync`, as the owner does. */
  open(): void;
  /** The owner's Back path: the stack shrank, then `sync`. `deps.back` runs this too. */
  close(): void;
  /** How many times the mirror asked the owner to pop (`deps.back`). */
  pops(): number;
  /** Set the reported depth WITHOUT syncing: a push whose `sync` is still to run. */
  setDepth(depth: number): void;
}

/** The owner as hud.ts models it: a depth counter, and a `back` that pops then syncs. */
function mirrorHarness(host: HistoryHost | null, initialDepth = 0): MirrorHarness {
  let depth = initialDepth;
  let pops = 0;
  const close = (): void => {
    depth -= 1;
    mirror.sync(depth);
  };
  const mirror = createHistoryMirror(host, {
    depth: () => depth,
    back: () => {
      pops += 1;
      close();
    },
  });
  return {
    mirror,
    depth: () => depth,
    open() {
      depth += 1;
      mirror.sync(depth);
    },
    close,
    pops: () => pops,
    setDepth(next) {
      depth = next;
    },
  };
}

describe('createHistoryMirror: one sentinel entry while layers are open', () => {
  it('the first layer pushes exactly one sentinel and a second layer pushes none', () => {
    // Killed by `history-mirror-pushes-per-layer` (`sync` pushes from `present` as well as
    // from `absent`): the second layer would add a second entry, and the player's browser
    // Back would then have to be pressed twice per layer to leave.
    const host = fakeHost();
    const h = mirrorHarness(host);
    expect(h.mirror.active).toBe(true);
    expect(h.mirror.phase).toBe('absent');

    h.open();
    expect(host.calls).toEqual(['pushState']);
    expect(host.pushes[0], 'the entry pushed is not the sentinel').toBe(LAYER_SENTINEL);
    expect(isLayerSentinel(host.pushes[0])).toBe(true);
    expect(h.mirror.phase).toBe('present');

    h.open();
    expect(host.calls, 'a second layer touched history').toEqual(['pushState']);
    expect(h.mirror.phase).toBe('present');
  });

  it('an in-app pop with a layer remaining touches history not at all; emptying the stack retires the sentinel with one back()', () => {
    // Killed by `history-mirror-pushes-per-layer`: with a push per `sync(d>0)`, the in-app
    // pop to depth 1 syncs from `present` and pushes AGAIN, so the list grows instead of
    // holding. The retirement half fails if `sync(0)` stops calling `back()` (the sentinel
    // would outlive the layers and the next browser Back would pop nothing while staying on
    // the page), or if `phase` is not `leaving` while the traversal is pending.
    const host = fakeHost({ manualPop: true });
    const h = mirrorHarness(host);
    h.open();
    h.open();
    expect(host.calls).toEqual(['pushState']);

    h.close();
    expect(host.calls, 'an in-app pop with a layer remaining touched history').toEqual(['pushState']);
    expect(h.mirror.phase).toBe('present');

    h.close();
    expect(host.calls).toEqual(['pushState', 'back']);
    expect(h.mirror.phase, 'the retirement is not recorded as pending').toBe('leaving');
    expect(h.pops()).toBe(0);

    host.popstate(null); // the traversal lands on the base
    expect(h.mirror.phase).toBe('absent');
    expect(host.calls, 'the landing of our own retirement touched history').toEqual(['pushState', 'back']);
    expect(h.pops()).toBe(0);
  });

  it('the popstate caused by our own retirement pops nothing; a base arrival while present pops one', () => {
    // Killed by `history-mirror-treats-its-own-landing-as-a-back` (the `leaving` early-return
    // deleted): the landing is then handled as a browser Back and pops whatever is open. The
    // landing is recognised by PHASE, not by depth: the second flow opens a layer during the
    // traversal whose `sync` has not yet run (`setDepth`), the shape the per-layer design was
    // rejected for ("pops a layer the player just opened"), and the mirror must still leave
    // it alone. The present-half fails if `onPop` stops calling `deps.back()`: a real browser
    // Back would then land on the base with the layer still on screen.
    const own = fakeHost({ manualPop: true });
    const h = mirrorHarness(own);
    h.open();
    h.close(); // sync(0): back() requested, phase leaving
    own.popstate(null);
    expect(h.pops(), 'our own landing popped a layer').toBe(0);
    expect(h.mirror.phase).toBe('absent');
    expect(own.calls).toEqual(['pushState', 'back']);

    h.open(); // present again, one more push
    h.close(); // leaving again
    expect(own.calls).toEqual(['pushState', 'back', 'pushState', 'back']);
    h.setDepth(1); // a layer opened during the traversal; its sync is still to run
    own.popstate(null);
    expect(h.pops(), 'our own landing popped the layer opened during the traversal').toBe(0);
    expect(h.mirror.phase).toBe('absent');
    expect(h.depth()).toBe(1);
    h.mirror.sync(1); // the deferred sync: the sentinel comes back for the open layer
    expect(own.calls).toEqual(['pushState', 'back', 'pushState', 'back', 'pushState']);
    expect(h.mirror.phase).toBe('present');

    // A base arrival while present is a real Back: one layer, through the owner's own path.
    const real = fakeHost({ manualPop: true });
    const r = mirrorHarness(real);
    r.open();
    expect(r.mirror.phase).toBe('present');
    real.popstate(null);
    expect(r.pops(), 'a browser Back with the sentinel current popped nothing').toBe(1);
    expect(r.depth()).toBe(0);
    expect(r.mirror.phase).toBe('absent');
    expect(real.calls, 'the owner\'s re-entrant sync(0) traversed after the browser already had').toEqual(['pushState']);
  });

  it('a browser Back at depth 2 pops one layer and re-pushes the sentinel through the re-entrant sync; at depth 1 pops one and pushes nothing', () => {
    // The owner's `back()` ends with `sync(depth)`, re-entrantly from inside `onPop`. Fails
    // if `phase = 'absent'` moves to AFTER `deps.back()`: the re-entrant `sync(1)` would see
    // `present`, push nothing, and the phase would then be stamped `absent` with a layer open
    // and no sentinel -- the next browser Back leaves the page. Also killed by
    // `history-mirror-pushes-per-layer` at the setup's exact push count.
    const host = fakeHost({ manualPop: true });
    const h = mirrorHarness(host);
    h.open();
    h.open();
    expect(host.calls).toEqual(['pushState']);

    host.popstate(null);
    expect(h.pops()).toBe(1);
    expect(h.depth()).toBe(1);
    expect(host.calls, 'the re-entrant sync did not re-push the sentinel').toEqual(['pushState', 'pushState']);
    expect(host.pushes[1]).toBe(LAYER_SENTINEL);
    expect(h.mirror.phase).toBe('present');

    host.popstate(null);
    expect(h.pops()).toBe(2);
    expect(h.depth()).toBe(0);
    expect(host.calls, 'the last layer\'s Back touched history').toEqual(['pushState', 'pushState']);
    expect(h.mirror.phase).toBe('absent');
  });

  it('a push during a pending retirement is honoured when the traversal lands', () => {
    // Killed by `history-mirror-drops-a-push-during-leaving` (`repush` never recorded): the
    // landing would be treated as a plain retirement, leaving the new layer open with no
    // sentinel, and the player's next browser Back leaves the page instead of closing it.
    const host = fakeHost({ manualPop: true });
    const h = mirrorHarness(host);
    h.open();
    h.close();
    expect(h.mirror.phase).toBe('leaving');

    h.open();
    expect(h.mirror.phase, 'the push during the traversal was not deferred').toBe('repush');
    expect(host.calls, 'a push during the traversal pushed immediately').toEqual(['pushState', 'back']);

    host.popstate(null);
    expect(host.calls, 'the landing did not re-push for the layer opened meanwhile').toEqual([
      'pushState',
      'back',
      'pushState',
    ]);
    expect(host.pushes[1]).toBe(LAYER_SENTINEL);
    expect(h.mirror.phase).toBe('present');
    expect(h.pops()).toBe(0);
  });
});

describe('createHistoryMirror: the loaded entry, Forward, and failure', () => {
  it('a stale sentinel on the loaded entry is re-stamped as base at construction; a null base is left alone', () => {
    // A reload while a layer was open loads onto the sentinel entry. Killed by
    // `history-mirror-keeps-a-stale-sentinel-at-boot`: the first layer then pushes a second
    // sentinel above a stale one, and after closing it the player's browser Back lands on the
    // stale sentinel -- a popstate the mirror reads as Forward and re-stamps, costing an
    // inert Back press. The null half fails if the stamp becomes unconditional (a replaceState
    // per boot, counting against the rate limit for nothing).
    const stale = fakeHost({ state: LAYER_SENTINEL });
    const h = mirrorHarness(stale);
    expect(stale.calls).toEqual(['replaceState']);
    expect(stale.replaces).toEqual([null]);
    expect(stale.state).toBeNull();
    expect(h.mirror.phase).toBe('absent');
    expect(h.mirror.active).toBe(true);

    const clean = fakeHost({ state: null });
    mirrorHarness(clean);
    expect(clean.calls, 'a null base was re-stamped').toEqual([]);

    // Negative control for the sentinel test itself: a look-alike is not ours.
    const other = fakeHost({ state: { tanks: 'other' } });
    mirrorHarness(other);
    expect(other.calls).toEqual([]);
    expect(isLayerSentinel({ tanks: 'other' })).toBe(false);
    expect(isLayerSentinel(null)).toBe(false);
  });

  it('Forward onto our sentinel with no layer re-stamps it; with a layer it becomes present', () => {
    // Killed by `history-mirror-forward-pops-a-layer` (the sentinel branch removed, so a
    // sentinel arrival is handled as a base arrival): at depth 0 the entry keeps the sentinel
    // (the next boot mistakes it for a reload-with-layer), and at depth>0 the arrival pops a
    // layer the player did not ask to close.
    const empty = fakeHost({ manualPop: true });
    const e = mirrorHarness(empty);
    empty.popstate(LAYER_SENTINEL);
    expect(empty.calls, 'Forward onto the sentinel with no layer was not re-stamped').toEqual(['replaceState']);
    expect(empty.replaces).toEqual([null]);
    expect(e.mirror.phase).toBe('absent');
    expect(e.pops()).toBe(0);

    const open = fakeHost({ manualPop: true });
    const o = mirrorHarness(open, 1);
    expect(o.mirror.phase).toBe('absent');
    open.popstate(LAYER_SENTINEL);
    expect(o.mirror.phase, 'Forward onto the sentinel with a layer open did not make it current').toBe('present');
    expect(open.calls, 'Forward with a layer open touched history').toEqual([]);
    expect(o.pops(), 'Forward onto the sentinel popped a layer').toBe(0);
  });

  it('a host whose pushState throws disables the mirror, never rethrows, and later syncs and pops are inert', () => {
    // Killed by `history-mirror-rethrows-the-host-error` (`safe` made a bare call): the throw
    // from inside the owner's keydown handler becomes an uncaught page error, and the layer
    // that was being opened never opens. The inert half fails if the latch does not clear
    // `active` (the next layer would retry and throw again) or if `onPop` keeps acting while
    // inactive (a browser Back with the in-app stack still working would pop a layer twice).
    const host = fakeHost({ throwing: true });
    const h = mirrorHarness(host);
    expect(h.mirror.active).toBe(true);

    expect(() => h.open()).not.toThrow();
    expect(host.calls).toEqual(['pushState']);
    expect(h.mirror.active, 'the throw did not latch the mirror off').toBe(false);
    expect(h.mirror.phase).toBe('absent');

    h.open();
    h.close();
    h.close();
    expect(host.calls, 'a later sync touched history after the latch').toEqual(['pushState']);
    expect(h.mirror.phase).toBe('absent');

    h.setDepth(1);
    host.popstate(null);
    expect(h.pops(), 'a popstate after the latch popped a layer').toBe(0);
    host.popstate(LAYER_SENTINEL);
    expect(host.calls).toEqual(['pushState']);
    expect(h.mirror.phase).toBe('absent');
  });

  it('dispose unsubscribes popstate and never traverses; with no host every call is inert and active is false', () => {
    // Killed by `history-mirror-listener-outlives-the-hud` (`dispose` skips the unsubscribe):
    // a mirror the HUD has torn down keeps reacting to the browser's Back on behalf of an
    // owner that no longer exists. The no-host half fails if `active` stops reading `host !==
    // null`, or if `sync` reaches for the host before its null check.
    const none = mirrorHarness(null);
    expect(none.mirror.active).toBe(false);
    expect(none.mirror.phase).toBe('absent');
    expect(() => {
      none.open();
      none.close();
      none.mirror.dispose();
      none.mirror.dispose();
    }).not.toThrow();
    expect(none.mirror.phase).toBe('absent');
    expect(none.pops()).toBe(0);

    const host = fakeHost({ manualPop: true });
    const h = mirrorHarness(host);
    expect(host.listeners).toHaveLength(1);
    h.open();
    h.mirror.dispose();
    expect(host.listeners, 'dispose left the popstate listener registered').toHaveLength(0);
    expect(host.calls, 'dispose traversed').toEqual(['pushState']);
    host.popstate(null);
    expect(h.pops(), 'a disposed mirror still popped on popstate').toBe(0);
    expect(() => h.mirror.dispose()).not.toThrow();
  });
});
