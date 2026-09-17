// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import html from '../../index.html?raw';

/**
 * The entry-bundle failure card (issue #770, under #325), run as the page runs it.
 *
 * The script is extracted from `index.html` and executed here, not copied, so an edit to the
 * page is what these cases test. jsdom executes no page scripts of its own, so the module
 * script element is inert and each failure is dispatched as the browser would dispatch it:
 * an `error` on the element for a bundle that never arrived, and a window `ErrorEvent`
 * carrying the bundle's URL for one that arrived and threw. Chromium's behaviour for both
 * was measured on #325; the browser evidence for this change is in its pull request.
 */
const SCRIPT = (() => {
  const match = html.match(/<script id="boot-entry-failure">([\s\S]*?)<\/script>/);
  if (match === null) throw new Error('index.html no longer carries the entry failure script');
  return match[1];
})();

const DELIVERY = "Part of the game couldn't load. Check your connection, then reload.";
const EVALUATION = 'Something went wrong before the game was ready. Try reloading.';

const installed: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];

/** A page shaped like `index.html`'s body at parse time, with the script run against it. */
function load(entrySrc = '/assets/index-abc123.js') {
  document.body.innerHTML = '<main id="app"><div id="boot-loading">Tanks!</div></main>';
  const entry = document.createElement('script');
  entry.type = 'module';
  entry.setAttribute('src', entrySrc);
  document.head.appendChild(entry);
  const original = window.addEventListener;
  window.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    installed.push([type, listener, options]);
    original.call(window, type, listener, options);
  } as typeof window.addEventListener;
  try {
    new Function(SCRIPT)();
  } finally {
    window.addEventListener = original;
  }
  return { entry, app: document.getElementById('app') as HTMLElement };
}

const card = () => document.getElementById('boot-entry-failure-card');

afterEach(() => {
  for (const [type, listener, options] of installed.splice(0)) window.removeEventListener(type, listener, options);
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('index.html entry bundle failure card (issue #770)', () => {
  it('turns the holding card into a focused alert when the entry script never arrives', () => {
    const { entry } = load();
    entry.dispatchEvent(new Event('error'));
    const shown = card();
    expect(shown, 'no failure card after the entry script failed').not.toBeNull();
    expect(document.getElementById('boot-loading'), 'the holding card is still up').toBeNull();
    expect(shown?.getAttribute('role')).toBe('alert');
    expect(shown?.getAttribute('aria-live')).toBe('assertive');
    expect(shown?.querySelector('h1')?.textContent).toBe('Tanks! could not load.');
    expect(shown?.querySelector('p')?.textContent).toBe(DELIVERY);
    const reload = shown?.querySelector('button');
    expect(reload?.textContent).toBe('Reload');
    expect(document.activeElement, 'focus is not on Reload').toBe(reload);
  });

  it('says the game could not start when the bundle arrived and threw while evaluating', () => {
    const { entry } = load();
    window.dispatchEvent(new ErrorEvent('error', { filename: entry.src, message: 'SyntaxError' }));
    expect(card()?.querySelector('h1')?.textContent).toBe('Tanks! could not start.');
    expect(card()?.querySelector('p')?.textContent).toBe(EVALUATION);
    expect(document.activeElement).toBe(card()?.querySelector('button'));
  });

  it('ignores a failed image and an error thrown from any other script', () => {
    load();
    const icon = document.createElement('img');
    document.body.appendChild(icon);
    icon.dispatchEvent(new Event('error'));
    window.dispatchEvent(new ErrorEvent('error', { filename: 'https://example.com/extension.js' }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'no filename at all' }));
    expect(card(), 'a non-entry failure replaced the holding card').toBeNull();
    expect(document.getElementById('boot-loading')).not.toBeNull();
  });

  it('does nothing once boot has retired the holding card', () => {
    const { entry, app } = load();
    document.getElementById('boot-loading')?.remove();
    app.innerHTML = '<div class="hud">the game</div>';
    entry.dispatchEvent(new Event('error'));
    window.dispatchEvent(new ErrorEvent('error', { filename: entry.src }));
    expect(card(), 'a failure after startup replaced the running game').toBeNull();
    expect(app.textContent).toBe('the game');
  });

  it('shows one card for a failure reported twice, keeping the first cause', () => {
    const { entry } = load();
    entry.dispatchEvent(new Event('error'));
    window.dispatchEvent(new ErrorEvent('error', { filename: entry.src }));
    expect(document.querySelectorAll('#boot-entry-failure-card')).toHaveLength(1);
    expect(card()?.querySelector('p')?.textContent).toBe(DELIVERY);
  });

  it('sits before the entry module script, so it runs while the page is still parsing', () => {
    // A listener installed after the module's error was dispatched would never hear it. In
    // the source the module tag follows this script; in the build Vite moves the module tag
    // into <head>, and its error still fires only after parsing (measured on #325).
    const inline = html.indexOf('<script id="boot-entry-failure">');
    const module = html.indexOf('<script type="module"');
    expect(inline).toBeGreaterThan(-1);
    expect(module).toBeGreaterThan(inline);
  });
});
