// @vitest-environment jsdom
//
// The configuration menu inside the HUD (issue #246): reaching it, what a press does to the
// previewed URL, and what Apply hands to the page. The view model and the renderer have
// their own files; this is the wiring between them.
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import { devSearchFrom, explainDevConfig, DEV_PRESETS } from './dev-config';

let hud: Hud | null = null;
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

function mount(opts: Parameters<typeof createHud>[1] = {}): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root, { developerMode: true, ...opts });
  hud.setState('main-menu');
  return { hud, root };
}

const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T =>
  root.querySelector<T>(sel) as T;
const isOpen = (el: HTMLElement, hidden: string): boolean =>
  !el.classList.contains(hidden) && !el.classList.contains('ui-surface--leaving');
const url = (root: HTMLElement): string => q(root, '.hud-devcfg-url').textContent ?? '';
function open(root: HTMLElement): void {
  q<HTMLButtonElement>(root, '.hud-devtools-open').click();
  q<HTMLButtonElement>(root, '.hud-devcfg-open').click();
}
const optionIn = (root: HTMLElement, field: string, label: string): HTMLButtonElement =>
  Array.from(
    q(root, `.hud-devcfg-control[data-field="${field}"]`).querySelectorAll('button'),
  ).find((b) => b.textContent === label) as HTMLButtonElement;

describe('reaching the configuration menu', () => {
  it('opens from the developer shell, and Back leaves it', () => {
    const { hud: h, root } = mount();
    open(root);
    expect(isOpen(q(root, '.hud-devcfg'), 'hud-devcfg--hidden')).toBe(true);
    expect(isOpen(q(root, '.hud-devtools'), 'hud-devtools--hidden'), 'the shell must not stay up')
      .toBe(false);
    h.back();
    expect(isOpen(q(root, '.hud-devcfg'), 'hud-devcfg--hidden')).toBe(false);
  });

  it('keeps the selection across a close, because building one is the slow part', () => {
    // Losing a configuration because Back was pressed to check something would make the menu
    // hostile to the one task it exists for.
    const { hud: h, root } = mount();
    open(root);
    optionIn(root, 'quality', 'low').click();
    const built = url(root);
    h.back();
    open(root);
    expect(url(root)).toBe(built);
  });
});

describe('what a press does to the previewed URL', () => {
  it('a value button puts that value in the URL, and Unset takes it out again', () => {
    const { root } = mount();
    open(root);
    optionIn(root, 'quality', 'low').click();
    expect(url(root)).toBe(devSearchFrom({ quality: 'low' }));
    optionIn(root, 'quality', 'Unset').click();
    expect(url(root)).toBe(devSearchFrom({}));
  });

  it('a toggle adds its own parameter and nothing else', () => {
    const { root } = mount();
    open(root);
    optionIn(root, 'aimRay', 'Off').click();
    expect(url(root)).toBe(devSearchFrom({ aimRay: true }));
  });

  it('a stepper walks a valued flag, and stops where the parser stops', () => {
    // The bound is the parser's, not a number written into the menu -- pressing past the
    // ceiling leaves the URL unchanged rather than building one the game would refuse.
    const { root } = mount();
    open(root);
    const up = q<HTMLButtonElement>(
      q(root, '.hud-devcfg-control[data-field="players"]'),
      '.hud-devcfg-step:nth-of-type(2)',
    );
    for (let i = 0; i < 10; i++) up.click();
    const built = url(root);
    const state = explainDevConfig(built);
    expect(state.notes.filter((n) => n.field === 'players' && n.reason === 'rejected')).toEqual([]);
    expect(state.effective.players, 'the stepper never moved at all').not.toBeNull();
  });

  it('a preset REPLACES the selection rather than merging into it', () => {
    // Half of one preset over half of another is a configuration neither describes, and the
    // preview would be accurate about something nobody chose.
    const { root } = mount();
    open(root);
    optionIn(root, 'quality', 'low').click();
    q<HTMLButtonElement>(root, '[data-preset="all-bots"]').click();
    const allBots = DEV_PRESETS.find((p) => p.id === 'all-bots');
    expect(url(root)).toBe(devSearchFrom(allBots?.selection ?? {}));
    expect(url(root), 'the earlier choice survived the preset').not.toContain('quality');
  });

  it('Reset clears the options and KEEPS developer mode', () => {
    // The trap `dev-config.ts` names: Reset is the gate alone, not `developerExitSearch`.
    // Dropping the gate would move the page to the production namespace on the next load.
    const { root } = mount();
    open(root);
    q<HTMLButtonElement>(root, '[data-preset="visual-debug"]').click();
    q<HTMLButtonElement>(root, '.hud-devcfg-reset').click();
    expect(url(root)).toBe(devSearchFrom({}));
    expect(explainDevConfig(url(root)).developerMode).toBe(true);
  });

  it('carries the page’s non-developer query through, so Apply does not drop a deep link', () => {
    const { root } = mount({ developerSearch: '?dev=1&utm=x' });
    open(root);
    expect(url(root)).toContain('utm=x');
  });
});

describe('Apply and Reload', () => {
  it('hands the page exactly the URL it was previewing', () => {
    // Acceptance criterion 4. The preview and the navigation are the same string by
    // construction -- there is no second computation to disagree.
    // Mounted WITH a page query: without one, a rebuilt URL and the previewed one are the
    // same string and the case proves nothing. Measured -- `devcfg-apply-sends-a-freshly-
    // built-url` survived this test until the base was added.
    const applied: string[] = [];
    const { root } = mount({
      applyDeveloperConfig: (s) => applied.push(s),
      developerSearch: '?dev=1&utm=x',
    });
    open(root);
    optionIn(root, 'quality', 'high').click();
    const previewed = url(root);
    expect(previewed, 'the fixture must carry a page query for this to measure anything')
      .toContain('utm=x');
    q<HTMLButtonElement>(root, '.hud-devcfg-apply').click();
    expect(applied).toEqual([previewed]);
  });

  it('is HIDDEN on a HUD that cannot navigate, rather than offered and inert', () => {
    // Same rule as Exit Developer Mode beside it, and the same reason every injected HUD in
    // a test stays off the History/Location APIs.
    const { root } = mount();
    expect(q<HTMLButtonElement>(root, '.hud-devcfg-apply').hidden).toBe(true);
    hud?.dispose();
    document.body.innerHTML = '';
    const second = mount({ applyDeveloperConfig: () => {} });
    expect(q<HTMLButtonElement>(second.root, '.hud-devcfg-apply').hidden).toBe(false);
  });
});

describe('Copy Link', () => {
  it('fills the field with the previewed URL and selects it', () => {
    // Selection is the path that always works: the async Clipboard API is origin- and
    // permission-gated and absent here.
    const { root } = mount();
    open(root);
    optionIn(root, 'mode', 'teams').click();
    const field = q<HTMLTextAreaElement>(root, '.hud-devcfg-copyfield');
    q<HTMLButtonElement>(root, '.hud-devcfg-copy').click();
    expect(field.value).toBe(url(root));
    expect(field.selectionEnd).toBe(field.value.length);
    expect(field.classList.contains('hud-devcfg-copyfield--hidden')).toBe(false);
  });
});
