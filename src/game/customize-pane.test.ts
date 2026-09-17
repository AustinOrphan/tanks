// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { CUSTOMIZE_BODY, createCustomizePane, type CustomizeHost } from './customize-pane';
import type { Surface } from './pane-host';

/**
 * The Customize pane on its own (issue #556), driven through a RECORDING host.
 *
 * The host here is scaffolding, not the subject. `enterSurface` and `closeSurface` toggle the
 * hidden class and run `onBegin` synchronously, as the real ones do once a transition begins.
 * Everything whose correctness depends on the real host stays asserted through `createHud`:
 * the transition runner, one surface at a time, replace and release sequencing, `setState`'s
 * instant close, focus restoration and the navigation-key exception.
 *
 * The DOM is built from the pane's own `CUSTOMIZE_BODY`, so the fixture cannot drift from the
 * classes the pane actually queries.
 */
function mount() {
  const root = document.createElement('div');
  root.className = 'hud-customize hud-customize--hidden';
  root.tabIndex = -1;
  root.innerHTML = CUSTOMIZE_BODY;
  const opener = document.createElement('button');
  document.body.append(opener, root);
  const surface: Surface = { el: root, hidden: 'hud-customize--hidden' };
  const calls: string[] = [];
  const host: CustomizeHost = {
    isSurfaceOpen: (s) => !s.el.classList.contains(s.hidden),
    enterSurface: (to, onBegin) => {
      calls.push('enter');
      to.el.classList.remove(to.hidden);
      onBegin?.();
    },
    closeSurface: (from, onBegin, instant) => {
      calls.push(`close instant=${instant === true}`);
      from.el.classList.add(from.hidden);
      onBegin?.();
    },
    open: (who) => {
      calls.push(who === opener ? 'open from the opener' : 'open from something else');
      return true;
    },
    back: () => {
      calls.push('back');
      return true;
    },
  };
  const pane = createCustomizePane(host, surface, opener);
  return { root, opener, calls, pane };
}

const click = (el: Element, detail: number) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createCustomizePane (issue #556)', () => {
  it('hands out the preview canvas and the four rotate buttons from its own body, in order', () => {
    const { root, pane } = mount();
    expect(pane.previewCanvas).toBe(root.querySelector('.hud-preview'));
    expect(pane.previewRotateButtons.map((b) => `${b.dataset.rotatePart}-${b.dataset.rotateDir}`)).toEqual([
      'hull-left',
      'hull-right',
      'turret-left',
      'turret-right',
    ]);
  });

  it('opens once per real open: selection repainted and the pane focused before subscribers run', () => {
    const { root, pane, calls } = mount();
    const seen: string[] = [];
    pane.onCustomizeOpen(() => {
      const marked = ['.hud-swatches', '.hud-skins', '.hud-accents'].filter((row) =>
        root.querySelector(`${row} [aria-pressed="true"]`) !== null);
      seen.push(`first:${marked.length} rows marked, focus on pane ${document.activeElement === root}`);
    });
    pane.onCustomizeOpen(() => seen.push('second'));
    pane.show(true);
    expect(seen).toEqual(['first:3 rows marked, focus on pane true', 'second']);
    pane.show(true);
    expect(seen, 'a second open of the open pane is not a transition').toHaveLength(2);
    expect(calls).toEqual(['enter', 'enter']);
  });

  it('closes only a pane that was open, and passes instant through', () => {
    const { pane, calls } = mount();
    let closes = 0;
    pane.onCustomizeClose(() => {
      closes += 1;
    });
    pane.show(false, true);
    expect(closes, 'closing a pane that was never open tears down nothing').toBe(0);
    expect(calls).toEqual(['close instant=true']);
    pane.show(true);
    pane.show(false);
    expect(closes).toBe(1);
    expect(calls.at(-1)).toBe('close instant=false');
  });

  it('releases its subscribers only when on screen, and leaves the surface to the incoming pane', () => {
    const { root, pane, calls } = mount();
    let closes = 0;
    pane.onCustomizeClose(() => {
      closes += 1;
    });
    pane.release();
    expect(closes).toBe(0);
    pane.show(true);
    pane.release();
    expect(closes).toBe(1);
    expect(root.classList.contains('hud-customize--hidden'), 'release does not close the surface').toBe(false);
    expect(calls).toEqual(['enter']);
  });

  it('opens its layer from the opener, keeping focus after a keyboard press and dropping it after a pointer click', () => {
    const { opener, calls } = mount();
    opener.focus();
    click(opener, 0);
    expect(calls).toEqual(['open from the opener']);
    expect(document.activeElement).toBe(opener);
    click(opener, 1);
    expect(calls).toEqual(['open from the opener', 'open from the opener']);
    expect(document.activeElement).not.toBe(opener);
  });

  it('goes back from its Back button, and drops focus after a pointer click on it', () => {
    const { root, calls } = mount();
    const back = root.querySelector('.hud-customize-back') as HTMLButtonElement;
    back.focus();
    click(back, 1);
    expect(calls).toEqual(['back']);
    expect(document.activeElement).not.toBe(back);
  });

  it('removes the opener and Back listeners it added when disposed', () => {
    const { root, opener, calls, pane } = mount();
    pane.dispose();
    const back = root.querySelector('.hud-customize-back') as HTMLButtonElement;
    opener.focus();
    click(opener, 1);
    back.focus();
    click(back, 1);
    expect(calls).toEqual([]);
    expect(document.activeElement, 'the blur listener went too').toBe(back);
  });
});
