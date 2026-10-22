import { createRequire } from 'node:module';

/**
 * A `display`-only `getComputedStyle` cache for the HUD's jsdom tests (issue #1093). A test
 * file opts in by calling `installComputedStyleCache()` at its top.
 *
 * WHY. jsdom 30.1.2 empties its computed-style cache on every focus move, so a `:focus` rule
 * recomputes as it would in a browser. The HUD reads `display` up every focusable control's
 * ancestors (`isHiddenWithin` in `focusable.ts`), and every arrow or pad step moves focus, so
 * each step re-ran the cascade for every node on those paths. Measured on the
 * `leaving-surface-still-counted-as-open` scope, that cascade was 56% of the CPU, and 97% of
 * its reads were `display`. The mutation harness kills a run at 180s, and a slow CI shard took
 * that scope past 120s.
 *
 * WHAT IT KEEPS. Each element's `display`, until jsdom next empties its own cache for any
 * reason other than a focus move. A cache hit returns a proxy: `display` comes from the cache,
 * and every other property or method from a real `getComputedStyle` call made on first use,
 * because `hud.css`'s `:focus`, `:focus-visible`, `:hover` and `:active` rules do change other
 * properties. A pseudo-element read, and an element outside this document's tree (detached, in
 * a shadow root, or in another document), pass straight through: no clear this cache counts
 * covers them, and the focus-state guard below reads only this document's sheets.
 *
 * WHY A HIT IS NOT STALE. jsdom's own cache already serves a stored declaration until
 * `_clearStyleCache` runs, which it does on every connected DOM change, attribute, stylesheet
 * and CSSOM edit, and form-state change (`checked`, validity). This cache empties on the same
 * clears and skips only the ones jsdom's focus setter makes, which are what 30.1.2 added. A
 * focus move can change `display` only through a focus-state rule, so the install refuses any
 * sheet in this document with a `:focus`, `:focus-within`, `:focus-visible`, `:hover` or
 * `:active` rule that sets `display` or `all`, naming its selectors, and checks every sheet
 * added later the first time it is read after jsdom clears its cache.
 * `computed-style-cache.test.ts` changes `display` once through each path jsdom tracks and
 * expects the new value through this cache.
 *
 * JSDOM INTERNALS. The clear signal is jsdom's private `_clearStyleCache` on the document's
 * implementation, reached through `implForWrapper` (`jsdom/lib/generated/idl/utils.js`), and
 * the focus exclusion wraps the implementation's `_lastFocusedElement` setter. Written against
 * jsdom 30.1.2. If an upgrade renames one of them, `findJsdomStyleHooks` throws naming it, so
 * every file that opts in fails at its first line. If an upgrade keeps the names but routes a
 * change around `_clearStyleCache`, the path case for that change fails.
 *
 * NOT COVERED. A sheet is checked again only when its own rule count changes. A CSSOM edit
 * inside an existing rule (a declaration, a selector, a rule inside `@media`) that gives a
 * focus-state rule a `display` is not seen. No production module edits the CSSOM.
 *
 * A test-only module: nothing in production imports it.
 */

/** Live counters, for this module's own tests. */
export interface ComputedStyleCacheStats {
  /** Every `getComputedStyle` call while installed. */
  calls: number;
  /** Calls whose `display` came from the cache. */
  hits: number;
  /** Calls that read through and stored the element's `display`. */
  misses: number;
  /** Calls never cached: a pseudo-element, or an element outside this document's tree. */
  passThrough: number;
  /** Times a read found that jsdom had cleared its cache, and emptied this one. */
  invalidations: number;
}

export interface ComputedStyleCache {
  readonly stats: Readonly<ComputedStyleCacheStats>;
  /** Restores jsdom and the global. Only this module's own tests, which install per case. */
  uninstall(): void;
}

/** The jsdom internals the cache hooks, found by `findJsdomStyleHooks`. */
export interface JsdomStyleHooks {
  /** The implementation object behind the `document` wrapper. */
  readonly impl: object;
  readonly clearStyleCache: (this: object) => void;
  readonly lastFocusedElement: {
    readonly get: (this: object) => unknown;
    readonly set: (this: object, element: unknown) => void;
  };
}

function renamed(what: string): Error {
  return new Error(
    `computed-style-cache: ${what}. A jsdom upgrade renamed an internal this test cache relies ` +
      'on (it was written against jsdom 30.1.2); update src/game/computed-style-cache.ts.',
  );
}

/**
 * The internals the cache hooks, from jsdom's `idl/utils.js` module and the document. Throws,
 * naming the internal, when one is missing.
 */
export function findJsdomStyleHooks(idlUtils: unknown, doc: Document): JsdomStyleHooks {
  const implForWrapper = (idlUtils as { implForWrapper?: unknown } | null)?.implForWrapper;
  if (typeof implForWrapper !== 'function') {
    throw renamed('jsdom/lib/generated/idl/utils.js exports no implForWrapper');
  }
  const impl: unknown = implForWrapper(doc);
  if (typeof impl !== 'object' || impl === null) {
    throw renamed('implForWrapper(document) returned no implementation object');
  }
  const clearStyleCache: unknown = (impl as { _clearStyleCache?: unknown })._clearStyleCache;
  if (typeof clearStyleCache !== 'function') {
    throw renamed('the document implementation has no _clearStyleCache method');
  }
  let focus: PropertyDescriptor | undefined;
  for (let p: object | null = impl; p !== null && focus === undefined; p = Object.getPrototypeOf(p)) {
    focus = Object.getOwnPropertyDescriptor(p, '_lastFocusedElement');
  }
  if (focus?.get === undefined || focus.set === undefined) {
    throw renamed('the document implementation has no _lastFocusedElement getter and setter');
  }
  return {
    impl,
    clearStyleCache: clearStyleCache as (this: object) => void,
    lastFocusedElement: { get: focus.get, set: focus.set },
  };
}

/** A pseudo-class whose match changes when focus moves, or which issue #1093's ruling names. */
const FOCUS_STATE = /:(?:focus(?:-within|-visible)?|hover|active)(?![\w-])/i;

export interface FocusStateScan {
  /** Every rule visited, nested ones included, so a check can refuse to pass on an empty sheet. */
  readonly scanned: number;
  /** The selector of each rule under a focus state that sets `display` or `all`. */
  readonly selectors: readonly string[];
}

/**
 * The guard the cache rests on: the rules in `rules`, at any depth, that set `display` or `all`
 * under a focus-state selector. A nested rule inherits its parent's state, since
 * `.a:focus { .b { ... } }` matches `.b` only while `.a` is focused.
 */
export function focusStateDisplayRules(rules: ArrayLike<CSSRule>): FocusStateScan {
  let scanned = 0;
  const selectors: string[] = [];
  const walk = (list: ArrayLike<CSSRule>, underFocusState: boolean): void => {
    for (let i = 0; i < list.length; i++) {
      const rule = list[i];
      scanned += 1;
      let focusState = underFocusState;
      if (rule instanceof CSSStyleRule) {
        focusState = underFocusState || FOCUS_STATE.test(rule.selectorText);
        const setsDisplay = rule.style.getPropertyValue('display') !== '';
        const setsAll = rule.style.getPropertyValue('all') !== '';
        if (focusState && (setsDisplay || setsAll)) selectors.push(rule.selectorText);
      }
      if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules, focusState);
    }
  };
  walk(rules, false);
  return { scanned, selectors };
}

function refused(selectors: readonly string[]): Error {
  return new Error(
    'computed-style-cache: a stylesheet in this document sets display under a focus state, so a ' +
      `focus move could change display without this cache seeing it: ${selectors.join(', ')}`,
  );
}

function loadJsdomIdlUtils(): unknown {
  try {
    return createRequire(import.meta.url)('jsdom/lib/generated/idl/utils.js');
  } catch (cause) {
    throw renamed(`jsdom/lib/generated/idl/utils.js did not load (${String(cause)})`);
  }
}

let installed: ComputedStyleCache | null = null;

/**
 * Patches the global `getComputedStyle` for this file's jsdom document. Calling it again while
 * installed returns the same cache.
 */
export function installComputedStyleCache(): ComputedStyleCache {
  if (installed !== null) return installed;
  const hooks = findJsdomStyleHooks(loadJsdomIdlUtils(), document);
  const { impl } = hooks;
  const real = globalThis.getComputedStyle;
  const stats: ComputedStyleCacheStats = {
    calls: 0,
    hits: 0,
    misses: 0,
    passThrough: 0,
    invalidations: 0,
  };

  // Each sheet's rule count when it last passed the guard.
  const guarded = new WeakMap<CSSStyleSheet, number>();
  const guardSheets = (): void => {
    for (const sheet of Array.from(document.styleSheets)) {
      const count = sheet.cssRules.length;
      if (guarded.get(sheet) === count) continue;
      const { selectors } = focusStateDisplayRules(sheet.cssRules);
      if (selectors.length > 0) throw refused(selectors);
      guarded.set(sheet, count);
    }
  };
  guardSheets();

  let generation = 0;
  let cachedGeneration = 0;
  let cache = new WeakMap<Element, string>();
  let inFocusSetter = false;

  const ownClear = Object.getOwnPropertyDescriptor(impl, '_clearStyleCache');
  const ownFocus = Object.getOwnPropertyDescriptor(impl, '_lastFocusedElement');
  Object.defineProperty(impl, '_clearStyleCache', {
    configurable: true,
    writable: true,
    value(this: object): void {
      if (!inFocusSetter) generation += 1;
      hooks.clearStyleCache.call(this);
    },
  });
  Object.defineProperty(impl, '_lastFocusedElement', {
    configurable: true,
    get(this: object): unknown {
      return hooks.lastFocusedElement.get.call(this);
    },
    set(this: object, element: unknown): void {
      inFocusSetter = true;
      try {
        hooks.lastFocusedElement.set.call(this, element);
      } finally {
        inFocusSetter = false;
      }
    },
  });

  const servedFromCache = (el: Element, display: string): CSSStyleDeclaration => {
    let fresh: CSSStyleDeclaration | null = null;
    const style = (): CSSStyleDeclaration => (fresh ??= real(el));
    return new Proxy({} as CSSStyleDeclaration, {
      get(_target, key) {
        if (key === 'display') return display;
        const value: unknown = Reflect.get(style(), key);
        return typeof value === 'function' ? value.bind(style()) : value;
      },
      has: (_target, key) => Reflect.has(style(), key),
      getPrototypeOf: () => Reflect.getPrototypeOf(style()),
    });
  };

  const cached = (el: Element, pseudo?: string | null): CSSStyleDeclaration => {
    stats.calls += 1;
    if (pseudo || el.getRootNode() !== document) {
      stats.passThrough += 1;
      return real(el, pseudo);
    }
    if (generation !== cachedGeneration) {
      guardSheets();
      cache = new WeakMap();
      cachedGeneration = generation;
      stats.invalidations += 1;
    }
    const display = cache.get(el);
    if (display !== undefined) {
      stats.hits += 1;
      return servedFromCache(el, display);
    }
    stats.misses += 1;
    const style = real(el);
    cache.set(el, style.display);
    return style;
  };
  globalThis.getComputedStyle = cached;

  const restore = (key: string, own: PropertyDescriptor | undefined): void => {
    if (own === undefined) Reflect.deleteProperty(impl, key);
    else Object.defineProperty(impl, key, own);
  };
  installed = {
    stats,
    uninstall(): void {
      restore('_clearStyleCache', ownClear);
      restore('_lastFocusedElement', ownFocus);
      globalThis.getComputedStyle = real;
      installed = null;
    },
  };
  return installed;
}
