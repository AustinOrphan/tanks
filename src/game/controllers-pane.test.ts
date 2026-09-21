// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROLLERS_BODY, createControllersPane, type ControllersHost } from './controllers-pane';
import type { Surface } from './pane-host';

/**
 * The Controllers pane on its own (issue #556), driven through a RECORDING host, in the same
 * shape as `customize-pane.test.ts`.
 *
 * THREE CASES, and each one closes a gap measured before it was written. Mutating the pane
 * against `hud.surfaces`, `hud.controls` and `hud.navigation` -- 341 cases -- firing the open
 * callbacks unconditionally, dropping `release`'s open guard, and dropping `dispose`'s Back
 * listener removal ALL survived. Making the heading ignore `deps.headingText()` did not, so that
 * one is not re-tested here: it is already covered where it belongs.
 *
 * Everything whose correctness depends on the real host stays asserted through `createHud`: the
 * transition runner, one surface at a time, replace and release sequencing, `setState`'s instant
 * close, and focus restoration.
 */
function mount() {
  const root = document.createElement('div');
  root.className = 'hud-controllers hud-controllers--hidden';
  root.tabIndex = -1;
  root.innerHTML = CONTROLLERS_BODY;
  const opener = document.createElement('button');
  document.body.append(opener, root);
  const surface: Surface = { el: root, hidden: 'hud-controllers--hidden' };
  const calls: string[] = [];
  const host: ControllersHost = {
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
  const pane = createControllersPane(host, surface, opener, {
    detectedPads: () => [],
    headingText: () => 'Controllers',
  });
  return { root, opener, calls, pane };
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createControllersPane (issue #556)', () => {
  it('fires the open callbacks once per REAL transition, not once per show(true)', () => {
    const { pane } = mount();
    let opens = 0;
    pane.onControllersOpen(() => {
      opens += 1;
    });
    pane.show(true);
    pane.show(true); // already open: nothing transitioned, so nothing should fire
    expect(opens, 'a redundant show(true) fired the open callbacks again').toBe(1);
  });

  it('releases only a pane that is on screen', () => {
    // `release` is the sibling-replacing path (issue #558). Fired for a pane that was never
    // shown, it would tell a subscriber to tear down something it never built.
    const { pane } = mount();
    let closes = 0;
    pane.onControllersClose(() => {
      closes += 1;
    });
    pane.release();
    expect(closes, 'released a pane that was never open').toBe(0);
    pane.show(true);
    pane.release();
    expect(closes, 'a released open pane did not tell its subscribers').toBe(1);
  });

  it('removes every listener it added, on both of its own controls', () => {
    const { root, opener, calls, pane } = mount();
    const backBtn = root.querySelector('.hud-controllers-back') as HTMLButtonElement;
    pane.dispose();
    click(opener);
    click(backBtn);
    expect(calls, 'a listener survived dispose').toEqual([]);
  });

  it('builds its rows and its Back control from its own body, so the fixture cannot drift', () => {
    // The negative control for the three cases above: if the body stopped carrying these, the
    // queries in the factory would silently return null and every assertion here would be
    // asserting about a pane that never wired anything.
    const { root } = mount();
    expect(root.querySelector('.hud-controller-rows')).not.toBeNull();
    expect(root.querySelector('.hud-controllers-back')).not.toBeNull();
    expect(root.querySelector('.hud-controllers-title')).not.toBeNull();
  });
});
