// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

import hudCss from './hud.css?raw';
import {
  findJsdomStyleHooks,
  focusStateDisplayRules,
  installComputedStyleCache,
  type ComputedStyleCache,
} from './computed-style-cache';

/**
 * The display cache's contract (issue #1093): a hit returns what jsdom itself would. Every
 * fixture is a synthetic sheet built here, so a fix to a shipped stylesheet cannot delete a
 * control. Each case installs a fresh cache and uninstalls it after.
 */

let cache: ComputedStyleCache | null = null;
const install = (): ComputedStyleCache => (cache = installComputedStyleCache());

afterEach(() => {
  cache?.uninstall();
  cache = null;
  for (const style of Array.from(document.querySelectorAll('style'))) style.remove();
  document.body.innerHTML = '';
});

const requireHere = createRequire(import.meta.url);
const jsdomIdlUtils = (): unknown => requireHere('jsdom/lib/generated/idl/utils.js');

function sheet(css: string, parent: Node = document.head): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = css;
  parent.appendChild(style);
  return style;
}

function add<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  parent: Node = document.body,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== '') el.className = className;
  parent.appendChild(el);
  return el;
}

const rulesOf = (css: string): CSSRuleList => {
  const parsed = new CSSStyleSheet();
  parsed.replaceSync(css);
  return parsed.cssRules;
};

/** Two reads of `el`, the second a hit, so a case cannot pass with the cache doing nothing. */
function primed(c: ComputedStyleCache, el: Element, display: string): void {
  expect(getComputedStyle(el).display, 'the fixture does not start where the case says').toBe(display);
  const hits = c.stats.hits;
  expect(getComputedStyle(el).display).toBe(display);
  expect(c.stats.hits, 'the second read was not served from the cache').toBe(hits + 1);
}

interface DisplayPath {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** Builds the fixture, and returns the element read and the one change under test. */
  readonly build: () => { subject: Element; change: () => void };
}

// One case per way jsdom lets `display` change. A text-only change is not here: jsdom counts any
// text child as content for `:empty`, so no selector it supports reads character data (pinned
// below).
const PATHS: readonly DisplayPath[] = [
  {
    path: 'a class added to the element',
    before: 'block',
    after: 'none',
    build: () => {
      sheet('.gcs-off { display: none }');
      const subject = add('div');
      return { subject, change: () => subject.classList.add('gcs-off') };
    },
  },
  {
    path: 'a class removed from the element',
    before: 'none',
    after: 'block',
    build: () => {
      sheet('.gcs-off { display: none }');
      const subject = add('div', 'gcs-off');
      return { subject, change: () => subject.classList.remove('gcs-off') };
    },
  },
  {
    path: 'an attribute a selector reads',
    before: 'block',
    after: 'none',
    build: () => {
      sheet('[data-gcs-off] { display: none }');
      const subject = add('div');
      return { subject, change: () => subject.setAttribute('data-gcs-off', '') };
    },
  },
  {
    path: 'the hidden attribute (user-agent sheet)',
    before: 'block',
    after: 'none',
    build: () => {
      const subject = add('div');
      return { subject, change: () => (subject.hidden = true) };
    },
  },
  {
    path: 'an inline style',
    before: 'block',
    after: 'flex',
    build: () => {
      const subject = add('div');
      return { subject, change: () => (subject.style.display = 'flex') };
    },
  },
  {
    path: 'a sibling a combinator reads',
    before: 'block',
    after: 'none',
    build: () => {
      sheet('.gcs-a + .gcs-b { display: none }');
      const subject = add('div', 'gcs-b');
      const sibling = document.createElement('div');
      sibling.className = 'gcs-a';
      return { subject, change: () => subject.before(sibling) };
    },
  },
  {
    path: 'its last child removed (:empty)',
    before: 'block',
    after: 'none',
    build: () => {
      sheet('.gcs-e:empty { display: none }');
      const subject = add('div', 'gcs-e');
      const child = add('span', '', subject);
      return { subject, change: () => child.remove() };
    },
  },
  {
    path: 'a class on an ancestor',
    before: 'block',
    after: 'none',
    build: () => {
      sheet('.gcs-group-off .gcs-child { display: none }');
      const group = add('div');
      const subject = add('div', 'gcs-child', group);
      return { subject, change: () => group.classList.add('gcs-group-off') };
    },
  },
  {
    path: 'a <style> appended',
    before: 'block',
    after: 'none',
    build: () => {
      const subject = add('div', 'gcs-later');
      return { subject, change: () => sheet('.gcs-later { display: none }') };
    },
  },
  {
    path: 'a <style> removed',
    before: 'none',
    after: 'block',
    build: () => {
      const style = sheet('.gcs-gone { display: none }');
      const subject = add('div', 'gcs-gone');
      return { subject, change: () => style.remove() };
    },
  },
  {
    path: 'a rule inserted with insertRule',
    before: 'block',
    after: 'grid',
    build: () => {
      const style = sheet('');
      const subject = add('div', 'gcs-inserted');
      return { subject, change: () => style.sheet?.insertRule('.gcs-inserted { display: grid }') };
    },
  },
  {
    path: 'a rule deleted with deleteRule',
    before: 'grid',
    after: 'block',
    build: () => {
      const style = sheet('.gcs-deleted { display: grid }');
      const subject = add('div', 'gcs-deleted');
      return { subject, change: () => style.sheet?.deleteRule(0) };
    },
  },
  {
    path: "a rule's declaration edited in place",
    before: 'grid',
    after: 'flex',
    build: () => {
      const style = sheet('.gcs-edited { display: grid }');
      const subject = add('div', 'gcs-edited');
      const rule = style.sheet?.cssRules[0] as CSSStyleRule;
      return { subject, change: () => (rule.style.display = 'flex') };
    },
  },
  {
    path: 'a checkbox checked (:checked)',
    before: 'inline',
    after: 'none',
    build: () => {
      sheet(':checked + .gcs-checked { display: none }');
      const box = add('input');
      box.type = 'checkbox';
      const subject = add('span', 'gcs-checked');
      return { subject, change: () => (box.checked = true) };
    },
  },
  {
    path: 'an input made valid (:invalid)',
    before: 'none',
    after: 'inline',
    build: () => {
      sheet('input:invalid + .gcs-invalid { display: none }');
      const input = add('input');
      input.required = true;
      const subject = add('span', 'gcs-invalid');
      return { subject, change: () => (input.value = 'filled') };
    },
  },
  {
    // A removal moves focus inside jsdom's focus setter, whose clears this cache skips; the
    // removal's own clear must still count.
    path: 'the focused element removed',
    before: 'none',
    after: 'block',
    build: () => {
      sheet('.gcs-focused + .gcs-next { display: none }');
      const focused = add('button', 'gcs-focused');
      const subject = add('div', 'gcs-next');
      focused.focus();
      expect(document.activeElement, 'the button did not take focus').toBe(focused);
      return { subject, change: () => focused.remove() };
    },
  },
];

describe('computed-style-cache: a hit follows every change jsdom tracks', () => {
  it.each(PATHS)('sees $path', ({ build, before, after }) => {
    const c = install();
    const { subject, change } = build();
    primed(c, subject, before);
    change();
    expect(getComputedStyle(subject).display).toBe(after);
  });
});

describe('computed-style-cache: a focus move keeps the cache', () => {
  it('serves display from the cache across a focus, a second focus and a blur, though jsdom empties its own on each', () => {
    const c = install();
    const first = add('button');
    const second = add('button');
    const subject = add('div');
    primed(c, subject, 'block');
    const { impl } = findJsdomStyleHooks(jsdomIdlUtils(), document);
    const jsdomCache = (): unknown => (impl as { _styleCache?: unknown })._styleCache;
    expect(jsdomCache(), "jsdom's own cache moved; this case can no longer see it").toBeInstanceOf(WeakMap);
    const moves: ReadonlyArray<[string, () => void, Element]> = [
      ['focus', () => first.focus(), first],
      ['a second focus', () => second.focus(), second],
      ['blur', () => second.blur(), document.body],
    ];
    for (const [name, move, focused] of moves) {
      const before = jsdomCache();
      move();
      expect(document.activeElement, name).toBe(focused);
      expect(jsdomCache(), `jsdom kept its own cache across ${name}, so this case shows nothing`).not.toBe(before);
      const { hits, invalidations } = c.stats;
      expect(getComputedStyle(subject).display, name).toBe('block');
      expect(c.stats.hits, `the read after ${name} was not a hit`).toBe(hits + 1);
      expect(c.stats.invalidations, `${name} emptied the cache`).toBe(invalidations);
    }
  });
});

describe('computed-style-cache: what a hit returns', () => {
  it('reads every property but display fresh, so a :focus color shows after a focus move', () => {
    sheet('.gcs-focus:focus { color: rgb(255, 0, 0) }');
    const c = install();
    const button = add('button', 'gcs-focus');
    const display = getComputedStyle(button).display;
    primed(c, button, display);
    button.focus();
    const hits = c.stats.hits;
    const style = getComputedStyle(button);
    expect(c.stats.hits, 'the read after focus was not a hit').toBe(hits + 1);
    expect(style.display).toBe(display);
    expect(style.color).toBe('rgb(255, 0, 0)');
    expect(style.getPropertyValue('color')).toBe('rgb(255, 0, 0)');
  });

  it('is a CSSStyleDeclaration, as a real one is', () => {
    const c = install();
    const subject = add('div');
    primed(c, subject, 'block');
    expect(getComputedStyle(subject)).toBeInstanceOf(CSSStyleDeclaration);
  });
});

describe('computed-style-cache: reads it never caches', () => {
  it('passes a pseudo-element read through', () => {
    const c = install();
    const subject = add('div');
    primed(c, subject, 'block');
    const { hits, passThrough } = c.stats;
    getComputedStyle(subject, '::before');
    getComputedStyle(subject, '::before');
    expect(c.stats.hits).toBe(hits);
    expect(c.stats.passThrough).toBe(passThrough + 2);
  });

  it('passes a detached element through, so a focus move cannot strand its value', () => {
    sheet('.gcs-off { display: none }');
    install();
    const button = add('button');
    const detached = document.createElement('div');
    expect(getComputedStyle(detached).display).toBe('block');
    expect(getComputedStyle(detached).display).toBe('block');
    // jsdom clears nothing for a detached element; its focus clear is what makes its next read
    // fresh.
    detached.className = 'gcs-off';
    button.focus();
    expect(getComputedStyle(detached).display).toBe('none');
  });

  it('passes an element in a shadow root through, whose sheets the guard never reads', () => {
    install();
    const host = add('div');
    const shadow = host.attachShadow({ mode: 'open' });
    sheet('.gcs-wrap:focus-within .gcs-shown { display: none }', shadow);
    const wrap = add('div', 'gcs-wrap', shadow);
    const button = add('button', '', wrap);
    const subject = add('span', 'gcs-shown', wrap);
    expect(getComputedStyle(subject).display).toBe('inline');
    expect(getComputedStyle(subject).display).toBe('inline');
    button.focus();
    expect(getComputedStyle(subject).display).toBe('none');
  });

  it('passes an element of another document through, whose clears this cache does not count', () => {
    install();
    // An inline style, since jsdom applies no <style> in a document without a window.
    const other = document.implementation.createHTMLDocument('');
    const subject = other.createElement('div');
    other.body.appendChild(subject);
    expect(getComputedStyle(subject).display).toBe('block');
    expect(getComputedStyle(subject).display).toBe('block');
    subject.style.display = 'flex';
    expect(getComputedStyle(subject).display).toBe('flex');
  });
});

describe('computed-style-cache: the focus-state guard', () => {
  it.each([
    { state: ':focus', css: '.gcs-a:focus { display: none }', selectors: ['.gcs-a:focus'] },
    {
      state: ':focus-within',
      css: '.gcs-a:focus-within .gcs-b { display: none }',
      selectors: ['.gcs-a:focus-within .gcs-b'],
    },
    { state: ':focus-visible', css: '.gcs-a:focus-visible { display: grid }', selectors: ['.gcs-a:focus-visible'] },
    { state: ':hover', css: '.gcs-a:hover { display: block }', selectors: ['.gcs-a:hover'] },
    { state: ':active', css: '.gcs-a:active { display: flex }', selectors: ['.gcs-a:active'] },
    {
      state: 'a state inside :is()',
      css: '.gcs-a:is(:hover, .gcs-b) { display: none }',
      selectors: ['.gcs-a:is(:hover, .gcs-b)'],
    },
    { state: 'a state inside :not()', css: '.gcs-a:not(:focus) { display: none }', selectors: ['.gcs-a:not(:focus)'] },
    { state: 'a state inside :has()', css: '.gcs-a:has(:focus) { display: none }', selectors: ['.gcs-a:has(:focus)'] },
    { state: 'all, which resets display', css: '.gcs-a:focus { all: unset }', selectors: ['.gcs-a:focus'] },
    {
      state: 'a rule inside @media',
      css: '@media screen { .gcs-a:focus { display: none } }',
      selectors: ['.gcs-a:focus'],
    },
    {
      state: 'a rule inside @supports',
      css: '@supports (display: grid) { .gcs-a:hover { display: grid } }',
      selectors: ['.gcs-a:hover'],
    },
    {
      state: 'a rule nested under a focus-state rule',
      css: '.gcs-a:focus { color: red; .gcs-b { display: none } }',
      selectors: ['& .gcs-b'],
    },
  ])('reports display set under $state', ({ css, selectors }) => {
    expect(focusStateDisplayRules(rulesOf(css)).selectors).toEqual(selectors);
  });

  it('reports nothing for display with no focus state, a focus state with no display, or a lookalike', () => {
    const css =
      '.gcs-a { display: none } .gcs-a:focus { color: red } .gcs-focused { display: none } ' +
      '.gcs-a:checked { display: none } @media screen { .gcs-b { display: grid } }';
    const scan = focusStateDisplayRules(rulesOf(css));
    expect(scan.scanned, 'the sheet parsed to something else, so this proves nothing').toBe(6);
    expect(scan.selectors).toEqual([]);
  });

  it('finds nothing in hud.css, the sheet the opted-in HUD files load', () => {
    const scan = focusStateDisplayRules(rulesOf(hudCss));
    expect(scan.scanned, 'hud.css parsed to almost nothing, so this passes vacuously').toBeGreaterThan(400);
    expect(scan.selectors).toEqual([]);
  });

  it("finds nothing in jsdom's user-agent sheet, which applies everywhere and which the install cannot read", () => {
    const path = requireHere.resolve('jsdom/lib/jsdom/browser/default-stylesheet.css');
    const scan = focusStateDisplayRules(rulesOf(readFileSync(path, 'utf8')));
    expect(scan.scanned, 'the user-agent sheet parsed to almost nothing').toBeGreaterThan(100);
    expect(scan.selectors).toEqual([]);
  });

  it('the install refuses a sheet with a focus-state display rule, naming it', () => {
    sheet('.gcs-p:focus-within .gcs-c { display: none }');
    expect(() => install()).toThrow('.gcs-p:focus-within .gcs-c');
  });

  it('a sheet added after the install is refused at the next read, and at every read after', () => {
    const c = install();
    const subject = add('div');
    primed(c, subject, 'block');
    sheet('.gcs-z:hover { display: none }');
    expect(() => getComputedStyle(subject)).toThrow('.gcs-z:hover');
    expect(() => getComputedStyle(subject)).toThrow('.gcs-z:hover');
  });
});

describe('computed-style-cache: the jsdom internals it hooks', () => {
  it('finds them in the installed jsdom', () => {
    const hooks = findJsdomStyleHooks(jsdomIdlUtils(), document);
    expect(typeof hooks.clearStyleCache).toBe('function');
    expect(typeof hooks.lastFocusedElement.get).toBe('function');
    expect(typeof hooks.lastFocusedElement.set).toBe('function');
  });

  it.each([
    { lacking: 'implForWrapper', utils: {}, named: 'implForWrapper' },
    { lacking: 'a document implementation', utils: { implForWrapper: () => null }, named: 'implementation object' },
    { lacking: '_clearStyleCache', utils: { implForWrapper: () => ({}) }, named: '_clearStyleCache' },
    {
      lacking: '_lastFocusedElement',
      utils: { implForWrapper: () => ({ _clearStyleCache() {} }) },
      named: '_lastFocusedElement',
    },
    {
      lacking: "_lastFocusedElement's setter",
      utils: {
        implForWrapper: () => ({
          _clearStyleCache() {},
          get _lastFocusedElement() {
            return null;
          },
        }),
      },
      named: '_lastFocusedElement',
    },
  ])('throws naming $lacking when a jsdom upgrade drops it', ({ utils, named }) => {
    // The module's own message, not the TypeError that using the missing internal would throw.
    expect(() => findJsdomStyleHooks(utils, document)).toThrow(new RegExp(`^computed-style-cache: .*${named}`));
  });
});

describe('computed-style-cache: the jsdom behavior it rests on', () => {
  it('jsdom applies no width media query, so a viewport change cannot change display', () => {
    sheet('@media (max-width: 99999px) { .gcs-narrow { display: none } }');
    expect(getComputedStyle(add('div', 'gcs-narrow')).display).toBe('block');
  });

  it('jsdom counts an empty text child as content for :empty, so no text change can change display', () => {
    sheet('.gcs-e:empty { display: none }');
    const subject = add('div', 'gcs-e');
    subject.appendChild(document.createTextNode(''));
    expect(getComputedStyle(subject).display).toBe('block');
  });
});
