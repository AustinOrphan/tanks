// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { LAYER_SENTINEL, browserHistoryHost } from './navigation';
import type { HistoryWindow } from './navigation';

/**
 * jsdom lands a traversal after two macrotasks (measured: the popstate fires between the
 * first and second `setTimeout(0)`), never synchronously from `back()`.
 */
async function landed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('browserHistoryHost: the adapter over a real window', () => {
  it('browserHistoryHost leaves location.search (?dev=1) and the hash untouched across push, replace and back', async () => {
    // `?dev=1` selects developer mode and the storage namespace, and the hash is the page's
    // own. Fails if the adapter passes a URL to `pushState`/`replaceState` (`'/'` or
    // `location.pathname` in the third argument), which strips both from the new entry; the
    // `state` reads fail if the adapter stops forwarding the sentinel object itself.
    const original = location.href;
    history.replaceState(null, '', `${location.pathname}?dev=1#x`);
    try {
      const host = browserHistoryHost(window);
      if (host === null) throw new Error('jsdom has pushState; the adapter returned null');
      const landings: unknown[] = [];
      const off = host.onPopState((state) => landings.push(state));

      host.pushState(LAYER_SENTINEL);
      expect(location.search, 'pushState dropped the search').toBe('?dev=1');
      expect(location.hash, 'pushState dropped the hash').toBe('#x');
      expect(host.state).toEqual(LAYER_SENTINEL);

      host.replaceState(null);
      expect(location.search, 'replaceState dropped the search').toBe('?dev=1');
      expect(location.hash, 'replaceState dropped the hash').toBe('#x');
      expect(host.state).toBeNull();

      host.back();
      expect(landings, 'the traversal landed synchronously').toEqual([]);
      await landed();
      expect(landings, 'back() did not land on the base entry').toEqual([null]);
      expect(location.search, 'back() dropped the search').toBe('?dev=1');
      expect(location.hash, 'back() dropped the hash').toBe('#x');

      off();
      host.pushState(LAYER_SENTINEL);
      history.back();
      await landed();
      expect(landings, 'the unsubscribe left the listener registered').toEqual([null]);
    } finally {
      history.replaceState(null, '', original);
    }
  });

  it('browserHistoryHost returns null for a window without history.pushState', () => {
    // The issue's "where supported". Fails if the `history === undefined` guard goes (the
    // bare window throws reading `pushState` of undefined), or if the `typeof` check goes
    // (`{ history: {} }` is adapted, and the first layer throws inside a keydown handler).
    const noop = (): void => {};
    expect(browserHistoryHost({ addEventListener: noop, removeEventListener: noop })).toBeNull();
    const bare = { history: {} as HistoryWindow['history'], addEventListener: noop, removeEventListener: noop };
    expect(browserHistoryHost(bare)).toBeNull();

    // Negative control: the same shape WITH a pushState is adapted.
    expect(browserHistoryHost(window)).not.toBeNull();
  });
});
